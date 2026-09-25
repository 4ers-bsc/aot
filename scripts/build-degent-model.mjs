#!/usr/bin/env node
// Builds assets/models/degent.glb, the runtime props for the Degent skin
// (skin 3), from the source model in art/degent-source.gltf.
//
// The source is a Blender export of the Degent PFP: a flat, extruded
// ape-in-a-suit silhouette plus real 3D props — a spiky crown, a whiskey
// bottle and the hand gripping it. A flat cut-out can't stand in for a 3D
// fighter (edge-on it's a plank, and it has no legs or rig), so the game
// rebuilds the body in its own voxel style (buildDegentBody in src/game.js)
// and takes the two signature props straight from the model. This script:
//   1. decodes the Draco source and pulls out the crown and the bottle,
//   2. bakes the model's own scaling (and the crown's tilt) into the vertices,
//   3. welds + simplifies them (the bottle alone is ~44k triangles),
//   4. recomputes crease-aware normals so flat faces stay crisp,
//   5. splits the bottle into glass and a dark label + cap part,
//   6. normalizes each prop to unit size, standing on y = 0,
//   7. writes a small, uncompressed GLB (no decoder needed at runtime).
//
// The tooling is not a project dependency; install it ad hoc, then run:
//   npm i --no-save @gltf-transform/core@4 @gltf-transform/extensions@4 draco3dgltf@1 meshoptimizer@1
//   node scripts/build-degent-model.mjs [source.gltf] [out.glb]

import { Document, NodeIO } from "@gltf-transform/core";
import { KHRDracoMeshCompression } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import { MeshoptSimplifier } from "meshoptimizer";

const SRC = process.argv[2] || "art/degent-source.gltf";
const OUT = process.argv[3] || "assets/models/degent.glb";

// Triangle budgets: detailed enough for the APPEARANCE preview close-up, cheap
// enough for ten fighters (plus the shadow pass) in a PvP match.
const CROWN_TRIS = 900;
const BOTTLE_TRIS = 700;
const CREASE_DEG = 40;

const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression])
  .registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });
await MeshoptSimplifier.ready;

const src = await io.read(SRC);

// -- Geometry helpers ---------------------------------------------------------
function rotate([qx, qy, qz, qw], [x, y, z]) {
  // v' = q v q*, expanded.
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

// Pull one node's triangles out of the source, with its scale (and optionally
// its rotation) baked in. Translation is dropped: each prop is re-centred.
function extract(nodeName, { bakeRotation }) {
  const node = src.getRoot().listNodes().find((n) => n.getName() === nodeName);
  if (!node?.getMesh()) throw new Error(`source has no mesh node named "${nodeName}"`);
  const prim = node.getMesh().listPrimitives()[0];
  const pos = prim.getAttribute("POSITION").getArray();
  const idx = prim.getIndices()?.getArray() ?? Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
  const [sx, sy, sz] = node.getScale();
  const q = bakeRotation ? node.getRotation() : [0, 0, 0, 1];
  const positions = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    positions.set(rotate(q, [pos[i] * sx, pos[i + 1] * sy, pos[i + 2] * sz]), i);
  }
  return { positions, indices: Uint32Array.from(idx) };
}

function bounds(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  }
  return { min, max, size: max.map((v, k) => v - min[k]) };
}

// Merge vertices that share a position (the Draco export splits them per face
// corner), dropping triangles that collapse. Normals are rebuilt later.
function weld({ positions, indices }) {
  const { size } = bounds(positions);
  const eps = Math.hypot(...size) * 1e-5;
  const ids = new Map();
  const remap = new Uint32Array(positions.length / 3);
  const out = [];
  for (let v = 0; v < remap.length; v++) {
    const key = [0, 1, 2].map((k) => Math.round(positions[3 * v + k] / eps)).join(",");
    let id = ids.get(key);
    if (id === undefined) {
      id = out.length / 3;
      ids.set(key, id);
      out.push(positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]);
    }
    remap[v] = id;
  }
  const tris = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]], b = remap[indices[t + 1]], c = remap[indices[t + 2]];
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  return { positions: Float32Array.from(out), indices: Uint32Array.from(tris) };
}

// Keep only the vertices `tris` references, renumbered.
function compact(positions, tris) {
  const used = new Map();
  const out = [];
  const indices = new Uint32Array(tris.length);
  tris.forEach((v, i) => {
    let id = used.get(v);
    if (id === undefined) {
      id = out.length / 3;
      used.set(v, id);
      out.push(positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]);
    }
    indices[i] = id;
  });
  return { positions: Float32Array.from(out), indices };
}

// Simplify a mesh whose faces are split into material groups (group[f]).
// Each group gets its own copy of the vertices on a group boundary, which the
// simplifier treats as a seam: it can slide collapses along the boundary but
// never across it, so every part keeps a clean edge and the parts still meet
// exactly. Returns one compacted mesh per group.
function simplifyGroups({ positions, indices }, group, groupCount, targetTris) {
  const ids = new Map();
  const pos = [];
  const vertexGroup = [];
  const split = new Uint32Array(indices.length);
  for (let f = 0; f < indices.length / 3; f++) {
    for (let k = 0; k < 3; k++) {
      const v = indices[3 * f + k];
      const key = v * groupCount + group[f];
      let id = ids.get(key);
      if (id === undefined) {
        id = pos.length / 3;
        ids.set(key, id);
        pos.push(positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]);
        vertexGroup.push(group[f]);
      }
      split[3 * f + k] = id;
    }
  }
  const splitPos = Float32Array.from(pos);
  const [out, error] = MeshoptSimplifier.simplify(split, splitPos, 3, targetTris * 3, 0.02);
  const parts = [];
  for (let g = 0; g < groupCount; g++) {
    const tris = [];
    for (let t = 0; t < out.length; t += 3) {
      if (vertexGroup[out[t]] === g) tris.push(out[t], out[t + 1], out[t + 2]);
    }
    parts.push({ ...compact(splitPos, tris), error });
  }
  return parts;
}

// Cross product of triangle f's edges: its normal, scaled by twice its area.
function faceCross({ positions, indices }, f) {
  const [a, b, c] = [indices[3 * f], indices[3 * f + 1], indices[3 * f + 2]];
  const e1 = [0, 1, 2].map((k) => positions[3 * b + k] - positions[3 * a + k]);
  const e2 = [0, 1, 2].map((k) => positions[3 * c + k] - positions[3 * a + k]);
  return [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
}

function faceNormal(mesh, f) {
  const n = faceCross(mesh, f);
  const len = Math.hypot(...n) || 1;
  return n.map((v) => v / len);
}

// Area-weighted vertex normals that only average faces within CREASE_DEG of
// each other, splitting vertices along hard edges (the bottle's flat faces).
function creasedNormals(mesh) {
  const { positions, indices } = mesh;
  const faces = indices.length / 3;
  const unit = new Float32Array(faces * 3);
  const weighted = new Float32Array(faces * 3);
  const around = Array.from({ length: positions.length / 3 }, () => []);
  for (let f = 0; f < faces; f++) {
    weighted.set(faceCross(mesh, f), 3 * f);
    unit.set(faceNormal(mesh, f), 3 * f);
    for (let k = 0; k < 3; k++) around[indices[3 * f + k]].push(f);
  }
  const cos = Math.cos((CREASE_DEG * Math.PI) / 180);
  const ids = new Map();
  const outPos = [], outNrm = [];
  const tris = new Uint32Array(indices.length);
  for (let f = 0; f < faces; f++) {
    for (let k = 0; k < 3; k++) {
      const v = indices[3 * f + k];
      const n = [0, 0, 0];
      for (const g of around[v]) {
        const dot = unit[3 * f] * unit[3 * g] + unit[3 * f + 1] * unit[3 * g + 1] + unit[3 * f + 2] * unit[3 * g + 2];
        if (dot >= cos) for (let j = 0; j < 3; j++) n[j] += weighted[3 * g + j];
      }
      const len = Math.hypot(...n) || 1;
      const nn = n.map((x) => x / len);
      const key = `${v}|${nn.map((x) => Math.round(x * 1e3)).join(",")}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = outPos.length / 3;
        ids.set(key, id);
        outPos.push(positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]);
        outNrm.push(...nn);
      }
      tris[3 * f + k] = id;
    }
  }
  return { positions: Float32Array.from(outPos), normals: Float32Array.from(outNrm), indices: tris };
}

// Re-centre on X/Z, stand on y = 0 and scale uniformly so `measure(size)` = 1.
function normalize(mesh, measure) {
  const { min, max, size } = bounds(mesh.positions);
  const s = 1 / measure(size);
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    mesh.positions[i] = (mesh.positions[i] - cx) * s;
    mesh.positions[i + 1] = (mesh.positions[i + 1] - min[1]) * s;
    mesh.positions[i + 2] = (mesh.positions[i + 2] - cz) * s;
  }
  return mesh;
}

function prepare(nodeName, { bakeRotation, swapXZ = false }) {
  const raw = extract(nodeName, { bakeRotation });
  if (swapXZ) {
    // Turn the prop a quarter about Y (x, z) -> (z, -x).
    for (let i = 0; i < raw.positions.length; i += 3) {
      const x = raw.positions[i];
      raw.positions[i] = raw.positions[i + 2];
      raw.positions[i + 2] = -x;
    }
  }
  return weld(raw);
}

function report(label, source, parts) {
  const tris = parts.reduce((n, p) => n + p.indices.length / 3, 0);
  console.log(`${label}: ${source.indices.length / 3} -> ${tris} tris (error ${parts[0].error.toFixed(4)})`);
}

// -- Crown --------------------------------------------------------------------
// Keeps the model's own tilt and spin, so the spikes read exactly as they do
// on the PFP from the front. Unit width (the wider of X/Z).
const crownSrc = normalize(prepare("head - spikey-crown", { bakeRotation: true }), (s) => Math.max(s[0], s[2]));
const [crownSimple] = simplifyGroups(crownSrc, new Uint8Array(crownSrc.indices.length / 3), 1, CROWN_TRIS);
report("crown", crownSrc, [crownSimple]);
const crown = creasedNormals(crownSimple);

// -- Bottle -------------------------------------------------------------------
// Upright (the held tilt is posed in code), turned so the broad faces look
// along ±Z, i.e. the label faces the camera from the fighter's side. Unit height.
const bottle = normalize(prepare("hand - bottle - carafe", { bakeRotation: false, swapXZ: true }), (s) => s[1]);
// Split into glass and a dark label + cap on the full-resolution mesh, where
// the boundaries are exact: the cap is everything above the neck (which ends
// at 218.5 of the source's 245 units); the label is the recessed band on the
// broad front/back faces (source units 24–134).
const CAP_FROM = 218.5 / 245, LABEL_FROM = 20 / 245, LABEL_TO = 136 / 245;
function isDark(f) {
  let minY = Infinity, y = 0;
  for (let k = 0; k < 3; k++) {
    const vy = bottle.positions[3 * bottle.indices[3 * f + k] + 1];
    minY = Math.min(minY, vy);
    y += vy / 3;
  }
  if (minY >= CAP_FROM - 1e-4) return true;
  return y > LABEL_FROM && y < LABEL_TO && Math.abs(faceNormal(bottle, f)[2]) > 0.9;
}
const bottleGroups = Uint8Array.from({ length: bottle.indices.length / 3 }, (_, f) => (isDark(f) ? 1 : 0));
const [glassSimple, darkSimple] = simplifyGroups(bottle, bottleGroups, 2, BOTTLE_TRIS);
report("bottle", bottle, [glassSimple, darkSimple]);
const bottleGlass = creasedNormals(glassSimple);
const bottleDark = creasedNormals(darkSimple);

// -- Write --------------------------------------------------------------------
const doc = new Document();
doc.createBuffer();
const scene = doc.createScene("degent");
function addMesh(name, mesh, color, { metallic = 0, roughness = 0.6 } = {}) {
  const material = doc.createMaterial(name)
    .setBaseColorFactor([...color, 1])
    .setMetallicFactor(metallic)
    .setRoughnessFactor(roughness);
  const prim = doc.createPrimitive()
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(mesh.positions))
    .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(mesh.normals))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(
      mesh.positions.length / 3 > 65535 ? mesh.indices : Uint16Array.from(mesh.indices)))
    .setMaterial(material);
  scene.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)));
  console.log(`  ${name}: ${mesh.indices.length / 3} tris, ${mesh.positions.length / 3} verts`);
}
// Colours only matter for viewing the GLB on its own; the game re-materials
// every part from the skin preset (APPEARANCE_PRESETS[3]).
addMesh("crown", crown, [0.69, 0.5, 0.02], { metallic: 0.6, roughness: 0.35 });
addMesh("bottleGlass", bottleGlass, [0.35, 0.12, 0.02], { roughness: 0.25 });
addMesh("bottleDark", bottleDark, [0.02, 0.02, 0.02], { roughness: 0.5 });
await io.write(OUT, doc);
console.log(`wrote ${OUT}`);
