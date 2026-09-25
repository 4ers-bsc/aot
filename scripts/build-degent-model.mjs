#!/usr/bin/env node
// Builds assets/models/degent.glb, the runtime crown for the Degent skin
// (skin 3), from the source model in art/degent-source.gltf.
//
// The source is a Blender export of the Degent PFP: a flat, extruded
// ape-in-a-suit silhouette plus a few real 3D props (a spiky crown, a bottle
// and the hand gripping it). A flat cut-out can't stand in for a 3D fighter
// (edge-on it's a plank, and it has no legs or rig), so the game rebuilds the
// body in its own voxel style (buildDegentBody in src/game.js) and takes the
// signature crown straight from the model. This script:
//   1. decodes the Draco source and pulls out the crown,
//   2. bakes the model's own scale and tilt into its vertices,
//   3. welds + simplifies it,
//   4. recomputes crease-aware normals so the spike edges stay crisp,
//   5. normalizes it to unit width, standing on y = 0,
//   6. writes a small, uncompressed GLB (no decoder needed at runtime).
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

// Triangle budget: detailed enough for the APPEARANCE preview close-up, cheap
// enough for ten fighters (plus the shadow pass) in a PvP match.
const CROWN_TRIS = 900;
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

// Pull one node's triangles out of the source with its scale and rotation
// baked in. Translation is dropped: the mesh is re-centred by normalize().
function extract(nodeName) {
  const node = src.getRoot().listNodes().find((n) => n.getName() === nodeName);
  if (!node?.getMesh()) throw new Error(`source has no mesh node named "${nodeName}"`);
  const prim = node.getMesh().listPrimitives()[0];
  const pos = prim.getAttribute("POSITION").getArray();
  const idx = prim.getIndices()?.getArray() ?? Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
  const [sx, sy, sz] = node.getScale();
  const q = node.getRotation();
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

// Simplify towards targetTris, then keep only the vertices still referenced.
function simplify({ positions, indices }, targetTris) {
  const [tris, error] = MeshoptSimplifier.simplify(indices, positions, 3, targetTris * 3, 0.02);
  const used = new Map();
  const out = [];
  const remapped = new Uint32Array(tris.length);
  tris.forEach((v, i) => {
    let id = used.get(v);
    if (id === undefined) {
      id = out.length / 3;
      used.set(v, id);
      out.push(positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]);
    }
    remapped[i] = id;
  });
  return { positions: Float32Array.from(out), indices: remapped, error };
}

// Cross product of triangle f's edges: its normal, scaled by twice its area.
function faceCross({ positions, indices }, f) {
  const [a, b, c] = [indices[3 * f], indices[3 * f + 1], indices[3 * f + 2]];
  const e1 = [0, 1, 2].map((k) => positions[3 * b + k] - positions[3 * a + k]);
  const e2 = [0, 1, 2].map((k) => positions[3 * c + k] - positions[3 * a + k]);
  return [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
}

// Area-weighted vertex normals that only average faces within CREASE_DEG of
// each other, splitting vertices along hard edges (the spikes' ridges).
function creasedNormals(mesh) {
  const { positions, indices } = mesh;
  const faces = indices.length / 3;
  const unit = new Float32Array(faces * 3);
  const weighted = new Float32Array(faces * 3);
  const around = Array.from({ length: positions.length / 3 }, () => []);
  for (let f = 0; f < faces; f++) {
    const n = faceCross(mesh, f);
    const len = Math.hypot(...n) || 1;
    weighted.set(n, 3 * f);
    unit.set(n.map((v) => v / len), 3 * f);
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

// Re-centre on X/Z, stand on y = 0 and scale uniformly to unit width (the
// wider of X and Z).
function normalize(mesh) {
  const { min, max, size } = bounds(mesh.positions);
  const s = 1 / Math.max(size[0], size[2]);
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    mesh.positions[i] = (mesh.positions[i] - cx) * s;
    mesh.positions[i + 1] = (mesh.positions[i + 1] - min[1]) * s;
    mesh.positions[i + 2] = (mesh.positions[i + 2] - cz) * s;
  }
  return mesh;
}

// -- Crown --------------------------------------------------------------------
// Keeps the model's own tilt and spin, so the spikes read exactly as they do
// on the PFP from the front.
const crownSrc = normalize(weld(extract("head - spikey-crown")));
const crownSimple = simplify(crownSrc, CROWN_TRIS);
console.log(`crown: ${crownSrc.indices.length / 3} -> ${crownSimple.indices.length / 3} tris (error ${crownSimple.error.toFixed(4)})`);
const crown = creasedNormals(crownSimple);

// -- Write --------------------------------------------------------------------
const doc = new Document();
doc.createBuffer();
// The colour only matters for viewing the GLB on its own; the game re-materials
// the crown with the skin's gold (APPEARANCE_PRESETS[3].trim).
const material = doc.createMaterial("crown")
  .setBaseColorFactor([0.69, 0.5, 0.02, 1])
  .setMetallicFactor(0.6)
  .setRoughnessFactor(0.35);
const prim = doc.createPrimitive()
  .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(crown.positions))
  .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(crown.normals))
  .setIndices(doc.createAccessor().setType("SCALAR").setArray(
    crown.positions.length / 3 > 65535 ? crown.indices : Uint16Array.from(crown.indices)))
  .setMaterial(material);
doc.createScene("degent").addChild(doc.createNode("crown").setMesh(doc.createMesh("crown").addPrimitive(prim)));
await io.write(OUT, doc);
console.log(`wrote ${OUT}: ${crown.indices.length / 3} tris, ${crown.positions.length / 3} verts`);
