// 3D isometric voxel arena for FIGHT10.
// Two visual views share one scene:
//   - "lobby": monochrome, shown behind the app chrome before a match.
//   - "game":  the attached reference look (light battlefield, green/red
//              fighters) with its own HUD; all app chrome is hidden.
// The local player is simulated and emits state/attacks. Demo mode pits the
// player against one AI raider. PvP mode supports up to ten network-driven
// opponents in a free-for-all; the last fighter standing wins.

import * as THREE from "three";
import { escapeHtml } from "./utils.js";

const TILE = 2;
const MAP_TILES = 50;
const MAP_WORLD = MAP_TILES * TILE; // 100
const MAP_HALF = MAP_WORLD / 2; // 50
// State snapshot broadcast interval. 10 Hz is plenty for the netMove
// interpolator, and it matters for capacity: every peer emits on the same
// Realtime channel (at 20 Hz a 10-player match was ≈200 msg/s, past Supabase's
// default channel rate limits — drops are silent). HP changes still propagate
// instantly via the forced emitState() in applyDamage.
const EMIT_MS = 100;

const WEAPONS = {
  sword:  { id: "sword",   name: "Sword",   atk: 25, atkVar: 3, cd: 0.7,  range: 2.4, ranged: false },
  pistol: { id: "pistol",  name: "Pistol",  atk: 15, atkVar: 4, cd: 0.9,  range: 18,  ranged: true,  bulletSpeed: 46, bulletSize: 0.13, chargeTime: 0    },
  sniper: { id: "sniper",  name: "Sniper",  atk: 20, atkVar: 2, cd: 2.2,  range: 60,  ranged: true,  bulletSpeed: 90, bulletSize: 0.22, chargeTime: 0.45 },
  frag:   { id: "frag",    name: "Frag",    atk: 22, atkVar: 4, cd: 3.5,  range: 23,  ranged: false, isGrenade: true, fuseTime: 1.0, blastRadius: 5 },
};
Object.values(WEAPONS).forEach(Object.freeze);
Object.freeze(WEAPONS);
const WEAPON_LIST = Object.values(WEAPONS).filter((w) => !w.isGrenade);
function randomAiWeapon() { return WEAPON_LIST[Math.floor(Math.random() * WEAPON_LIST.length)]; }
// AI raiders have no real profile — hand them a plausible level so their name
// tag matches the format shown for real players.
function randomAiLevel() { return 1 + Math.floor(Math.random() * 15); }

const THEMES = {
  game: {
    bg: 0x08090c,
    ground: ["#ffffff", "#ffffff", "#ffffff", "#f4f4f4", "#f4f4f4", "#e2e2e2", "#d9d9d9", "#d9d9d9", "#c4c4c4", "#a8a8a8", "#8f8f8f", "#6f6f6f"],
    grid: [0x8a7030, 0xb89040], gridOpacity: 0.38,
    border: 0xffc830,
    player: { boots: 0x2c4a2c, jacket: 0x4a8a45, helmet: 0x33572f, face: 0xcda882 },
    enemy: { boots: 0x4a2222, jacket: 0xa83a32, helmet: 0x6a1f1f, face: 0xd0a884 },
    bullet: 0xffe08a,
    markerMove: [0x2f8a2f, 0x1f6f1f], markerAttack: [0xd23b3b, 0xa02020],
    playerBar: "#33b14a", enemyBar: "#e0473c",
    cursor: "%23e0473c",
    mm: { grid: "rgba(110,120,128,0.16)", border: "rgba(58,106,58,0.8)", cam: "rgba(47,138,47,0.5)", enemy: "#d23b3b", player: "#2f8a2f" }
  },
  lobby: {
    bg: 0x121212,
    ground: ["#3a3a3a", "#343434", "#2e2e2e", "#2a2a2a", "#404040", "#363636", "#444444", "#383838", "#303030", "#4a4a4a", "#2c2c2c", "#3d3d3d"],
    grid: [0x5a5a5a, 0x404040], gridOpacity: 0.32,
    border: 0x808080,
    player: { boots: 0x8f8f8f, jacket: 0xdedede, helmet: 0xf3f3f3, face: 0xb6b6b6 },
    enemy: { boots: 0x242424, jacket: 0x4a4a4a, helmet: 0x1c1c1c, face: 0x6a6a6a },
    bullet: 0xffffff,
    markerMove: [0xffffff, 0xffffff], markerAttack: [0xbbbbbb, 0xffffff],
    playerBar: "#f0f0f0", enemyBar: "#8c8c8c",
    cursor: "%23ffffff",
    mm: { grid: "rgba(255,255,255,0.08)", border: "rgba(255,255,255,0.5)", cam: "rgba(255,255,255,0.25)", enemy: "#9a9a9a", player: "#ffffff" }
  }
};
const RD_FOG = { Near: [18, 38], Medium: [30, 65], Far: [52, 100] };
const RD_ORDER = ["Near", "Medium", "Far"];

export function createArenaGame(options) {
  const mount = options.mount;
  mount.innerHTML = "";

  if (typeof THREE === "undefined") {
    const note = document.createElement("div");
    note.className = "arena-error";
    note.textContent = "3D engine failed to load.";
    mount.appendChild(note);
    return stubApi();
  }

  let theme = THEMES.lobby;

  // -- Renderer -------------------------------------------------------------
  // WebGLRenderer THROWS when a WebGL context can't be created (GPU-blacklisted
  // WebViews, iOS Lockdown Mode, remote desktops). Degrade to the stub API like
  // the missing-THREE case above instead of crashing the whole app at boot.
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch (err) {
    console.error("WebGL unavailable:", err);
    const note = document.createElement("div");
    note.className = "arena-error";
    note.textContent = "3D graphics are unavailable on this device/browser.";
    mount.appendChild(note);
    return stubApi();
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(theme.bg, 1);
  renderer.domElement.classList.add("arena-canvas");
  mount.appendChild(renderer.domElement);

  function size() {
    return { w: mount.clientWidth || window.innerWidth, h: mount.clientHeight || window.innerHeight };
  }

  // -- Scene ----------------------------------------------------------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(theme.bg);
  scene.fog = new THREE.Fog(theme.bg, RD_FOG.Far[0], RD_FOG.Far[1]);

  const FRUSTUM = 16;
  // Zoom bounds (orthographic: lower zoom = more zoomed out). Declared here so the
  // camera can start at the fully zoomed-out limit on the home page and at match start.
  const ZOOM_MIN = 0.4, ZOOM_MAX = 3.2;
  let dim = size();
  let aspect = dim.w / dim.h;
  const camera = new THREE.OrthographicCamera(-FRUSTUM * aspect, FRUSTUM * aspect, FRUSTUM, -FRUSTUM, 0.1, 1000);
  camera.zoom = ZOOM_MIN;            // start fully zoomed out
  camera.updateProjectionMatrix();
  const CAM_OFFSET = new THREE.Vector3(28, 34, 28);
  const camCenter = new THREE.Vector3(0, 0, 0);
  let following = true;

  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const sun = new THREE.DirectionalLight(0xffffff, 0.65);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 120;
  sun.shadow.camera.left = -18; sun.shadow.camera.right = 18;
  sun.shadow.camera.top = 18; sun.shadow.camera.bottom = -18;
  sun.shadow.bias = -0.0004;
  scene.add(sun, sun.target);

  // -- Ground ---------------------------------------------------------------
  function makeGroundTex(palette) {
    const px = 96;
    const c = document.createElement("canvas");
    c.width = c.height = px;
    const ctx = c.getContext("2d");
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        ctx.fillStyle = palette[(Math.random() * palette.length) | 0];
        ctx.fillRect(x, y, 1, 1);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(MAP_WORLD / 24, MAP_WORLD / 24);
    return tex;
  }
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP_WORLD, MAP_WORLD),
    new THREE.MeshStandardMaterial({ map: makeGroundTex(theme.ground), roughness: 1, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  let grid = null;
  function buildGrid() {
    if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
    grid = new THREE.GridHelper(MAP_WORLD, MAP_TILES, theme.grid[0], theme.grid[1]);
    grid.material.transparent = true;
    grid.material.opacity = theme.gridOpacity;
    grid.position.y = 0.012;
    scene.add(grid);
  }
  buildGrid();

  const border = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-MAP_HALF, 0.02, -MAP_HALF), new THREE.Vector3(MAP_HALF, 0.02, -MAP_HALF),
      new THREE.Vector3(MAP_HALF, 0.02, MAP_HALF), new THREE.Vector3(-MAP_HALF, 0.02, MAP_HALF),
      new THREE.Vector3(-MAP_HALF, 0.02, -MAP_HALF)
    ]),
    new THREE.LineBasicMaterial({ color: theme.border })
  );
  scene.add(border);

  // -- Arena walls (disposable, theme-aware) ------------------------------------
  const wallObjects = []; // tracks all wall scene objects for disposal

  function buildArenaWalls(variant) {
    // Dispose existing wall objects via the shared traversal helper (it
    // handles shared materials, textures, and nested groups uniformly).
    wallObjects.forEach((obj) => {
      scene.remove(obj);
      disposeObject3D(obj);
    });
    wallObjects.length = 0;

    const DEPTH = 10;
    const addObj = (obj) => { scene.add(obj); wallObjects.push(obj); return obj; };

    // Dark backing behind each wall
    const backColor = 0x0a0804;
    const sideMat = new THREE.MeshStandardMaterial({ color: backColor, roughness: 0.98, metalness: 0.0 });
    [
      { x: 0,         z: -MAP_HALF, ry: 0 },
      { x: 0,         z:  MAP_HALF, ry: Math.PI },
      { x: -MAP_HALF, z: 0,         ry:  Math.PI / 2 },
      { x:  MAP_HALF, z: 0,         ry: -Math.PI / 2 },
    ].forEach(({ x, z, ry }) => {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(MAP_WORLD, DEPTH), sideMat);
      wall.position.set(x, -DEPTH / 2, z);
      wall.rotation.y = ry;
      addObj(wall);
    });

    // Bottom cap
    const btm = new THREE.Mesh(
      new THREE.PlaneGeometry(MAP_WORLD, MAP_WORLD),
      new THREE.MeshStandardMaterial({ color: 0x030302, roughness: 1 })
    );
    btm.rotation.x = Math.PI / 2;
    btm.position.y = -DEPTH;
    addObj(btm);

    // Glass panels — golden pixel grid
    const GH = 6;
    const CELL = 8;
    const PW = 256;
    const PH = 64;
    const gc = document.createElement("canvas");
    gc.width = PW; gc.height = PH;
    const gctx = gc.getContext("2d");
    gctx.imageSmoothingEnabled = false;

    for (let row = 0; row < PH / CELL; row++) {
      const rowAlpha = 1 - row / (PH / CELL);
      for (let col = 0; col < PW / CELL; col++) {
        const va = 0.85 + Math.random() * 0.15;
        const fillAlpha = rowAlpha * 0.28 * va;
        gctx.fillStyle = `rgba(210,175,60,${fillAlpha.toFixed(3)})`;
        gctx.fillRect(col * CELL + 1, row * CELL + 1, CELL - 2, CELL - 2);
      }
    }
    for (let row = 0; row <= PH / CELL; row++) {
      const rowAlpha = 1 - row / (PH / CELL);
      gctx.strokeStyle = `rgba(255, 200, 48, ${(rowAlpha * 0.72).toFixed(3)})`;
      gctx.lineWidth = 1;
      gctx.beginPath(); gctx.moveTo(0, row * CELL); gctx.lineTo(PW, row * CELL); gctx.stroke();
    }
    for (let col = 0; col <= PW / CELL; col++) {
      for (let row = 0; row < PH / CELL; row++) {
        const rowAlpha = 1 - row / (PH / CELL);
        gctx.strokeStyle = `rgba(255, 200, 48, ${(rowAlpha * 0.55).toFixed(3)})`;
        gctx.lineWidth = 1;
        gctx.beginPath(); gctx.moveTo(col * CELL, row * CELL); gctx.lineTo(col * CELL, (row + 1) * CELL); gctx.stroke();
      }
    }

    const glassTex = new THREE.CanvasTexture(gc);
    glassTex.magFilter = THREE.NearestFilter;
    glassTex.minFilter = THREE.NearestFilter;
    const glassMat = new THREE.MeshBasicMaterial({
      map: glassTex, transparent: true, side: THREE.DoubleSide, depthWrite: false
    });

    const SIDES = [
      { x: 0,         z: -MAP_HALF, ry: 0 },
      { x: 0,         z:  MAP_HALF, ry: Math.PI },
      { x: -MAP_HALF, z: 0,         ry:  Math.PI / 2 },
      { x:  MAP_HALF, z: 0,         ry: -Math.PI / 2 },
    ];
    SIDES.forEach(({ x, z, ry }) => {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(MAP_WORLD, GH), glassMat);
      panel.position.set(x, -GH / 2, z);
      panel.rotation.y = ry;
      addObj(panel);
    });

    // Top rim
    const rimColor = 0xffc830;
    const rimColor2 = 0xffaa00;
    const rimPts = [
      new THREE.Vector3(-MAP_HALF, 0.08, -MAP_HALF), new THREE.Vector3(MAP_HALF, 0.08, -MAP_HALF),
      new THREE.Vector3(MAP_HALF, 0.08,  MAP_HALF),  new THREE.Vector3(-MAP_HALF, 0.08,  MAP_HALF),
      new THREE.Vector3(-MAP_HALF, 0.08, -MAP_HALF),
    ];
    addObj(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(rimPts),
      new THREE.LineBasicMaterial({ color: rimColor, transparent: true, opacity: 0.9 })
    ));
    const rimPts2 = [
      new THREE.Vector3(-MAP_HALF - 0.05, 0.04, -MAP_HALF - 0.05),
      new THREE.Vector3( MAP_HALF + 0.05, 0.04, -MAP_HALF - 0.05),
      new THREE.Vector3( MAP_HALF + 0.05, 0.04,  MAP_HALF + 0.05),
      new THREE.Vector3(-MAP_HALF - 0.05, 0.04,  MAP_HALF + 0.05),
      new THREE.Vector3(-MAP_HALF - 0.05, 0.04, -MAP_HALF - 0.05),
    ];
    addObj(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(rimPts2),
      new THREE.LineBasicMaterial({ color: rimColor2, transparent: true, opacity: 0.38 })
    ));
  }

  buildArenaWalls("game");

  // -- Edge ledge + flame lamps ----------------------------------------------
  // A polished black ledge ring hugging the map rim, with small flickering
  // flame lamps spaced along it — scene objects, so they stay anchored to the
  // map edges (home backdrop and in-game alike) instead of the viewport.
  const edgeLamps = []; // { sprite, glow, phase } — flickered in animate()
  {
    const LEDGE_W = 3.2;   // ledge band width beyond the map rim
    const LEDGE_H = 0.56;  // ledge thickness; top sits just above the floor
    const LEDGE_TOP = 0.06;
    const ledgeMat = new THREE.MeshStandardMaterial({
      color: 0x0c0c0e, roughness: 0.16, metalness: 0.72, // black polished stone
    });
    const ledgeCY = LEDGE_TOP - LEDGE_H / 2;
    const L_OUT = MAP_HALF + LEDGE_W;
    // North/south bands span the full width plus both corners; east/west fill between.
    [
      { w: MAP_WORLD + LEDGE_W * 2, d: LEDGE_W, x: 0, z: -(MAP_HALF + LEDGE_W / 2) },
      { w: MAP_WORLD + LEDGE_W * 2, d: LEDGE_W, x: 0, z:  (MAP_HALF + LEDGE_W / 2) },
      { w: LEDGE_W, d: MAP_WORLD, x: -(MAP_HALF + LEDGE_W / 2), z: 0 },
      { w: LEDGE_W, d: MAP_WORLD, x:  (MAP_HALF + LEDGE_W / 2), z: 0 },
    ].forEach(({ w, d, x, z }) => {
      const band = new THREE.Mesh(new THREE.BoxGeometry(w, LEDGE_H, d), ledgeMat);
      band.position.set(x, ledgeCY, z);
      band.receiveShadow = true;
      scene.add(band);
    });
    // Gold trim line along the ledge's outer edge (matches the arena rim lines).
    scene.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-L_OUT, LEDGE_TOP + 0.02, -L_OUT), new THREE.Vector3(L_OUT, LEDGE_TOP + 0.02, -L_OUT),
        new THREE.Vector3( L_OUT, LEDGE_TOP + 0.02,  L_OUT), new THREE.Vector3(-L_OUT, LEDGE_TOP + 0.02,  L_OUT),
        new THREE.Vector3(-L_OUT, LEDGE_TOP + 0.02, -L_OUT),
      ]),
      new THREE.LineBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.45 })
    ));

    // Flame sprite texture — soft radial gradient, warm core.
    const flameCanvas = document.createElement("canvas");
    flameCanvas.width = 64; flameCanvas.height = 64;
    const fx = flameCanvas.getContext("2d");
    const fg = fx.createRadialGradient(32, 38, 2, 32, 34, 30);
    fg.addColorStop(0.00, "rgba(255,246,214,1)");
    fg.addColorStop(0.25, "rgba(255,208,116,0.92)");
    fg.addColorStop(0.55, "rgba(255,138,40,0.55)");
    fg.addColorStop(1.00, "rgba(255,90,10,0)");
    fx.fillStyle = fg;
    fx.fillRect(0, 0, 64, 64);
    const flameTex = new THREE.CanvasTexture(flameCanvas);

    // Warm glow pool cast on the polished ledge under each flame.
    const glowCanvas = document.createElement("canvas");
    glowCanvas.width = 64; glowCanvas.height = 64;
    const gx2 = glowCanvas.getContext("2d");
    const gg = gx2.createRadialGradient(32, 32, 1, 32, 32, 31);
    gg.addColorStop(0.00, "rgba(255,180,80,0.9)");
    gg.addColorStop(0.45, "rgba(255,130,30,0.35)");
    gg.addColorStop(1.00, "rgba(255,90,10,0)");
    gx2.fillStyle = gg;
    gx2.fillRect(0, 0, 64, 64);
    const glowTex = new THREE.CanvasTexture(glowCanvas);

    const baseGeo = new THREE.CylinderGeometry(0.3, 0.38, 0.5, 10);
    const glowGeo = new THREE.PlaneGeometry(3.4, 3.4);
    const LAMP_MID = MAP_HALF + LEDGE_W / 2; // lamp row centered on the ledge band
    const lampSpots = [];
    [-1, -0.5, 0, 0.5, 1].forEach((f) => {
      const p = f * (MAP_HALF - 3); // five per side, evenly spaced, shy of corners
      lampSpots.push([p, -LAMP_MID], [p, LAMP_MID], [-LAMP_MID, p], [LAMP_MID, p]);
    });
    lampSpots.forEach(([x, z]) => {
      // Small polished base…
      const base = new THREE.Mesh(baseGeo, ledgeMat);
      base.position.set(x, LEDGE_TOP + 0.25, z);
      scene.add(base);
      // …its flame…
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: flameTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      sprite.position.set(x, LEDGE_TOP + 0.5 + 0.72, z);
      sprite.scale.set(1.15, 1.7, 1);
      scene.add(sprite);
      // …and the warm pool it throws on the shiny ledge.
      const glow = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({
        map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      glow.rotation.x = -Math.PI / 2;
      glow.position.set(x, LEDGE_TOP + 0.015, z);
      scene.add(glow);
      edgeLamps.push({ sprite, glow, phase: Math.random() * Math.PI * 2 });
    });
  }

  // -- Pixelated FIGHT10 ground decals (black pixel squares, random) --------
  const fight10Groups = [];
  function makeFight10Decal() {
    fight10Groups.forEach((g) => {
      scene.remove(g);
      disposeObject3D(g);
    });
    fight10Groups.length = 0;
    const CW = 56, CH = 10;
    const dc = document.createElement("canvas");
    dc.width = CW; dc.height = CH;
    const dctx = dc.getContext("2d");
    dctx.imageSmoothingEnabled = false;
    dctx.clearRect(0, 0, CW, CH);
    dctx.fillStyle = "#000000";
    dctx.font = `bold ${CH}px monospace`;
    dctx.textAlign = "center";
    dctx.textBaseline = "middle";
    dctx.fillText("FIGHT10", CW / 2, CH / 2);
    const tex = new THREE.CanvasTexture(dc);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 7.2),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.22 })
    );
    mesh.rotation.x = -Math.PI / 2;
    const safe = MAP_HALF - 22;
    const grp = new THREE.Group();
    grp.position.set(
      (Math.random() - 0.5) * 2 * safe,
      0.04,
      (Math.random() - 0.5) * 2 * safe
    );
    grp.rotation.y = Math.floor(Math.random() * 4) * (Math.PI / 2);
    grp.add(mesh);
    scene.add(grp);
    fight10Groups.push(grp);
  }

  // -- Outer dot plane (black field with receding white dots beyond the ledge) --
  (function buildOuterDotPlane() {
    const SIZE = 320;
    const PX = 512;
    const dc = document.createElement("canvas");
    dc.width = dc.height = PX;
    const dctx = dc.getContext("2d");
    dctx.fillStyle = "#000000";
    dctx.fillRect(0, 0, PX, PX);
    // Dot grid — spacing 16px, dots radius 1.8px, fade toward edges
    const SPACING = 14;
    const cx = PX / 2, cy = PX / 2;
    const maxDist = Math.sqrt(cx * cx + cy * cy);
    for (let y = SPACING / 2; y < PX; y += SPACING) {
      for (let x = SPACING / 2; x < PX; x += SPACING) {
        const dx = x - cx, dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // Fade: full opacity near center (arena edge), transparent near outer edge
        const alpha = Math.max(0, 1 - (dist / maxDist) * 1.1);
        // Dot size shrinks slightly as alpha decreases (receding effect)
        const r = 0.55 * (0.5 + 0.5 * alpha);
        dctx.globalAlpha = alpha * 0.7;
        dctx.fillStyle = "#c8d0da";
        dctx.beginPath();
        dctx.arc(x, y, r, 0, Math.PI * 2);
        dctx.fill();
      }
    }
    dctx.globalAlpha = 1;
    // Hole mask: punch out arena area (centre square) to transparent so arena floor shows
    const arenaFrac = (MAP_WORLD / SIZE);
    const arenaPx = arenaFrac * PX;
    const ao = (PX - arenaPx) / 2;
    dctx.globalCompositeOperation = "destination-out";
    dctx.fillRect(ao, ao, arenaPx, arenaPx);

    const tex = new THREE.CanvasTexture(dc);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(SIZE, SIZE),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = -0.01;
    scene.add(plane);
  })();

  // -- Snow -----------------------------------------------------------------
  const SNOW_COUNT = 1400, SNOW_AREA = 48, SNOW_TOP = 30;
  const snowGeo = new THREE.BufferGeometry();
  const snowPos = new Float32Array(SNOW_COUNT * 3);
  const snowVel = new Float32Array(SNOW_COUNT);
  const snowPhase = new Float32Array(SNOW_COUNT);
  for (let i = 0; i < SNOW_COUNT; i++) {
    snowPos[i * 3] = (Math.random() - 0.5) * SNOW_AREA;
    snowPos[i * 3 + 1] = Math.random() * SNOW_TOP;
    snowPos[i * 3 + 2] = (Math.random() - 0.5) * SNOW_AREA;
    snowVel[i] = 2 + Math.random() * 3;
    snowPhase[i] = Math.random() * Math.PI * 2;
  }
  snowGeo.setAttribute("position", new THREE.BufferAttribute(snowPos, 3));
  function makeFlake() {
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const ctx = c.getContext("2d");
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.45, "rgba(255,255,255,0.85)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
    return new THREE.CanvasTexture(c);
  }
  const snow = new THREE.Points(snowGeo, new THREE.PointsMaterial({
    size: 0.34, map: makeFlake(), transparent: true, depthWrite: false, opacity: 0.9, sizeAttenuation: true
  }));
  scene.add(snow);

  // -- Marker ---------------------------------------------------------------
  const marker = new THREE.Group();
  const markerFill = new THREE.Mesh(new THREE.PlaneGeometry(TILE, TILE), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
  const markerEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(TILE, TILE)), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }));
  marker.add(markerFill, markerEdge);
  marker.rotation.x = -Math.PI / 2;
  marker.position.y = 0.02;
  scene.add(marker);
  let markerLife = 0;

  // Frag range ring — shown when frag weapon is active
  const fragRing = new THREE.Mesh(
    new THREE.RingGeometry(WEAPONS.frag.range - 0.18, WEAPONS.frag.range + 0.18, 72),
    new THREE.MeshBasicMaterial({ color: 0xff8833, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false })
  );
  fragRing.rotation.x = -Math.PI / 2;
  fragRing.position.y = 0.09;
  fragRing.visible = false;
  scene.add(fragRing);
  function setMarker(x, z, fillCol, edgeCol) {
    marker.position.set(x, 0.02, z);
    markerFill.material.color.setHex(fillCol);
    markerEdge.material.color.setHex(edgeCol);
    markerLife = 1;
  }

  // -- Fighters -------------------------------------------------------------
  function box(w, h, d, color) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05 }));
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }
  function limb(w, h, d, color) {
    const pivot = new THREE.Group();
    const mesh = box(w, h, d, color);
    mesh.position.y = -h / 2;
    pivot.add(mesh);
    pivot.mesh = mesh;
    return pivot;
  }
  function makeSword() {
    const s = new THREE.Group();
    const blade = box(0.1, 0.06, 0.95, 0xc9d2da); blade.position.set(0, 0, 0.55);
    const guard = box(0.34, 0.08, 0.09, 0x3a3f45); guard.position.set(0, 0, 0.05);
    const grip = box(0.09, 0.09, 0.26, 0x6b4a2a); grip.position.set(0, 0, -0.14);
    s.add(blade, guard, grip);
    s.position.set(0, -0.8, 0.05);
    s.rotation.x = -0.15;
    return s;
  }
  function makePistol() {
    const g = new THREE.Group();
    const body = box(0.12, 0.18, 0.3, 0x2a2e33); body.position.set(0, 0, 0.04);
    const barrel = box(0.09, 0.1, 0.32, 0x16181c); barrel.position.set(0, 0.04, 0.26);
    const grip = box(0.11, 0.22, 0.12, 0x3a2a1a); grip.position.set(0, -0.16, -0.06); grip.rotation.x = 0.35;
    g.add(body, barrel, grip);
    g.position.set(0, -0.78, 0.08);
    g.rotation.x = -0.05;
    return g;
  }
  function makeSniper() {
    const g = new THREE.Group();
    const body   = box(0.10, 0.12, 0.50, 0x1a1c22); body.position.set(0,     0,     0.15);
    const barrel = box(0.06, 0.06, 0.50, 0x0d0f12); barrel.position.set(0,   0.02,  0.52);
    const stock  = box(0.10, 0.10, 0.28, 0x5c3d1e); stock.position.set(0,    0,    -0.22);
    const cheek  = box(0.10, 0.06, 0.16, 0x5c3d1e); cheek.position.set(0,    0.08, -0.14);
    const scope  = box(0.07, 0.07, 0.30, 0x111418); scope.position.set(0,    0.12,  0.10);
    const lens   = box(0.07, 0.07, 0.04, 0x1e3a4a); lens.position.set(0,     0.12,  0.28);
    const grip   = box(0.10, 0.18, 0.10, 0x2a2e33); grip.position.set(0,    -0.10,  0.05); grip.rotation.x = 0.35;
    g.add(body, barrel, stock, cheek, scope, lens, grip);
    g.position.set(-0.05, -0.82, 0.05);
    g.rotation.x = -0.08;
    return g;
  }
  function makeBar(barColor) {
    const el = document.createElement("div");
    el.className = "bar game-ui";
    const name = document.createElement("div"); name.className = "bar-name";
    const level = document.createElement("div"); level.className = "bar-level";
    const track = document.createElement("div"); track.className = "bar-track";
    const fill = document.createElement("div"); fill.className = "bar-fill";
    fill.style.background = barColor;
    track.appendChild(fill);
    el.append(name, level, track);
    document.body.appendChild(el);
    return { el, name, level, fill, color: barColor };
  }
  function makeFighter(cfg) {
    const P = cfg.palette;
    const g = new THREE.Group();
    // Legs — slightly chunkier
    const legL = limb(0.36, 0.94, 0.36, P.boots), legR = limb(0.36, 0.94, 0.36, P.boots);
    legL.position.set(-0.22, 0.94, 0); legR.position.set(0.22, 0.94, 0);
    // Torso — barrel-chest
    const torso = box(1.0, 1.0, 0.58, P.jacket); torso.position.y = 1.42;
    // Shoulder pads
    const shlL = box(0.28, 0.28, 0.44, P.helmet); shlL.position.set(-0.64, 1.82, 0);
    const shlR = box(0.28, 0.28, 0.44, P.helmet); shlR.position.set( 0.64, 1.82, 0);
    // Arms
    const armL = limb(0.28, 0.82, 0.28, P.jacket), armR = limb(0.28, 0.82, 0.28, P.jacket);
    armL.position.set(-0.64, 1.68, 0); armR.position.set(0.64, 1.68, 0);
    // Head + full helmet
    const head = box(0.58, 0.46, 0.54, P.face); head.position.y = 2.18;
    const helmet = box(0.70, 0.50, 0.68, P.helmet); helmet.position.y = 2.44;
    // Visor — dark horizontal strip on front of helmet
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.52, 0.16, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x111820, roughness: 0.4, metalness: 0.6 })
    );
    visor.position.set(0, 2.46, 0.36);
    const swordMesh = makeSword(); armR.add(swordMesh);
    const pistolMesh = makePistol(); pistolMesh.visible = false; armR.add(pistolMesh);
    const sniperMesh = makeSniper(); sniperMesh.visible = false; armR.add(sniperMesh);
    g.add(legL, legR, torso, shlL, shlR, armL, armR, head, helmet, visor);
    g.position.copy(cfg.pos);
    g.visible = false;
    scene.add(g);
    const f = {
      userId: cfg.userId || null,
      name: cfg.name, level: cfg.level ?? 1, isPlayer: !!cfg.isPlayer, group: g,
      legL, legR, armL, armR, swordMesh, pistolMesh, sniperMesh,
      maxHp: cfg.hp, hp: cfg.hp, weapon: cfg.weapon, speed: cfg.speed,
      cdTimer: 0, atkAnim: 0, hurt: 0, regenAcc: 0, chargeTimer: 0,
      moving: false, facing: 0, walkPhase: 0,
      target: null, attackTarget: null, dead: false, deadTimer: 0,
      connected: false, networked: false, netTarget: null,
      parts: {
        boots: [legL.mesh.material, legR.mesh.material],
        jacket: [torso.material, armL.mesh.material, armR.mesh.material],
        helmet: [helmet.material, shlL.material, shlR.material],
        face: [head.material]
      },
      bar: makeBar(cfg.barColor)
    };
    updateWeaponVis(f);
    return f;
  }
  function updateWeaponVis(f) {
    if (f.swordMesh)  f.swordMesh.visible  = f.weapon.id === "sword";
    if (f.pistolMesh) f.pistolMesh.visible = f.weapon.id === "pistol";
    if (f.sniperMesh) f.sniperMesh.visible = f.weapon.id === "sniper";
  }
  function recolorFighter(f, palette) {
    Object.keys(f.parts).forEach((key) => f.parts[key].forEach((mat) => mat.color.setHex(palette[key])));
  }
  // Fully release an Object3D subtree: every descendant's geometry, its
  // material(s) — material ARRAYS included — and any texture those materials
  // hold. This is the single disposal path for everything removed from the
  // scene; ad-hoc `mesh.geometry.dispose()` calls silently leak when the node
  // is a Group (no geometry/material of its own) or when materials are shared.
  // The Set keeps shared resources from being visited repeatedly (dispose() is
  // idempotent in three.js, so a stray double call is still harmless).
  function disposeObject3D(root) {
    const seen = new Set();
    root.traverse((o) => {
      if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        if (seen.has(m)) continue;
        seen.add(m);
        if (m.map) m.map.dispose();
        m.dispose();
      }
    });
  }
  function disposeFighter(f) {
    scene.remove(f.group);
    disposeObject3D(f.group);
    f.bar.el.remove();
  }

  const player = makeFighter({ name: "You", isPlayer: true, palette: theme.player, pos: new THREE.Vector3(-12, 0, 4), hp: 100, weapon: WEAPONS.sword, speed: 6.5, barColor: theme.playerBar });
  // Demo AI raiders (foeMode === "ai"). PvP uses the opponents map instead.
  const aiEnemy = makeFighter({ name: "Raider", palette: theme.enemy, pos: new THREE.Vector3(12, 0, -4), hp: 100, weapon: randomAiWeapon(), speed: 4.6, barColor: theme.enemyBar, level: randomAiLevel() });
  const aiRaiders = [aiEnemy]; // grows/shrinks via setAiCount
  const opponents = new Map(); // userId -> networked fighter
  let foeMode = "ai"; // "ai" (demo) | "net" (pvp)
  const AI_AGGRO = 14;

  let _foeCache = null;
  function foeList() {
    if (_foeCache) return _foeCache;
    _foeCache = foeMode === "ai" ? aiRaiders : [...opponents.values()];
    return _foeCache;
  }

  function makeAiRaider(i) {
    const sp = randomSpawn();
    const f = makeFighter({
      name: `Raider ${i + 1}`, palette: theme.enemy,
      pos: new THREE.Vector3(sp.x, 0, sp.z), hp: 100,
      weapon: randomAiWeapon(), speed: 4.6, barColor: theme.enemyBar, level: randomAiLevel()
    });
    f.networked = false;
    f.connected = true;
    updateWeaponVis(f);
    return f;
  }

  function disposeAiRaider(f) {
    disposeFighter(f);
  }

  // -- Map obstacles --------------------------------------------------------
  // Trees & snow mountains block movement and deflect attacks; the river slows
  // movement and weakens attacks. Built deterministically from a seed so every
  // client in a match shares the exact same layout.
  const BODY_R = 0.6;
  const RIVER_SLOW = 0.5;
  const RIVER_ATK = 0.5;
  const mapGroup = new THREE.Group();
  scene.add(mapGroup);
  let solids = [];        // { x, z, r } — blocks movement + line of sight
  let riverSegments = []; // array of {x,z} waypoints defining the river centre-line
  let riverHalfW = 0;     // half-width of the river for capsule checks
  let riverFish = [];     // swimming fish — meshes live in mapGroup, animated per frame

  function makeRng(seedStr) {
    const str = String(seedStr);
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function inRiver(x, z) {
    if (riverSegments.length < 2) return false;
    const hw2 = riverHalfW * riverHalfW;
    for (let i = 0; i < riverSegments.length - 1; i++) {
      const a = riverSegments[i], b = riverSegments[i + 1];
      const abx = b.x - a.x, abz = b.z - a.z;
      const len2 = abx * abx + abz * abz || 1e-6;
      let t = ((x - a.x) * abx + (z - a.z) * abz) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = a.x + abx * t, cz = a.z + abz * t;
      const dx = x - cx, dz = z - cz;
      if (dx * dx + dz * dz <= hw2) return true;
    }
    return false;
  }
  function collidesSolid(x, z, selfR) {
    for (const s of solids) {
      const dx = x - s.x, dz = z - s.z, rr = s.r + selfR;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
    return false;
  }
  // Fish are moving obstacles: they block walking (a blocked fighter just
  // stalls until the fish swims past) but never bullets or line of sight.
  const FISH_BLOCK_R = 0.85;
  function collidesFish(x, z, selfR) {
    for (const F of riverFish) {
      const dx = x - F.g.position.x, dz = z - F.g.position.z;
      const rr = FISH_BLOCK_R + selfR;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
    return false;
  }
  // True if the segment A→B passes within any solid's radius (attack deflected).
  function losBlocked(ax, az, bx, bz) {
    for (const s of solids) {
      const abx = bx - ax, abz = bz - az;
      const len2 = abx * abx + abz * abz || 1e-6;
      let t = ((s.x - ax) * abx + (s.z - az) * abz) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + abx * t, cz = az + abz * t;
      const dx = s.x - cx, dz = s.z - cz;
      if (dx * dx + dz * dz < s.r * s.r) return true;
    }
    return false;
  }
  // Where a shot fired from A toward B first strikes a solid, or null if the
  // path is clear. Used so a blocked ranged shot still flies out and thuds into
  // the obstruction instead of never leaving the barrel.
  function rayBlockHit(ax, az, bx, bz) {
    const abx = bx - ax, abz = bz - az;
    const len = Math.hypot(abx, abz) || 1e-6;
    const dx = abx / len, dz = abz / len;
    let bestT = Infinity, hit = null;
    for (const s of solids) {
      const fx = ax - s.x, fz = az - s.z;
      const b = 2 * (fx * dx + fz * dz);
      const c = fx * fx + fz * fz - s.r * s.r;
      const disc = b * b - 4 * c;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      let t = (-b - sq) / 2;          // near intersection (entry)
      if (t < 0) t = (-b + sq) / 2;   // origin inside the solid → use exit
      if (t < 0 || t > len) continue;
      if (t < bestT) { bestT = t; hit = s; }
    }
    if (!hit) return null;
    return { x: ax + dx * bestT, z: az + dz * bestT };
  }
  function clearMap() {
    while (mapGroup.children.length) {
      const c = mapGroup.children[0];
      disposeObject3D(c);
      mapGroup.remove(c);
    }
    solids = [];
    riverSegments = [];
    riverHalfW = 0;
    riverFish = []; // meshes were children of mapGroup — already disposed above
  }
  function addTower(x, z) {
    const g = new THREE.Group();
    const base  = box(4.0, 0.5,  4.0, 0x6a6a6a); base.position.y  = 0.25;
    const body  = box(3.2, 11.0, 3.2, 0x787878); body.position.y  = 6.0;
    const par   = box(3.8, 0.6,  3.8, 0x848484); par.position.y   = 11.8;
    const psnow = box(3.9, 0.22, 3.9, 0xdde9f5); psnow.position.y = 12.22;
    [[-1.3,-1.3],[-1.3,1.3],[1.3,-1.3],[1.3,1.3]].forEach(([bx, bz]) => {
      const bt  = box(1.0, 1.4,  1.0, 0x7a7a7a); bt.position.set(bx, 12.9,  bz); g.add(bt);
      const bsn = box(1.1, 0.22, 1.1, 0xe4eef7); bsn.position.set(bx, 13.71, bz); g.add(bsn);
    });
    // Gold F10 cloth draped flat on top of the tower
    const clothCanvas = document.createElement("canvas");
    clothCanvas.width = 128; clothCanvas.height = 128;
    const cCtx = clothCanvas.getContext("2d");
    cCtx.fillStyle = "#c8940a";
    cCtx.fillRect(0, 0, 128, 128);
    cCtx.strokeStyle = "#7a5800";
    cCtx.lineWidth = 5;
    cCtx.strokeRect(4, 4, 120, 120);
    cCtx.fillStyle = "#0a0800";
    cCtx.font = "bold 52px monospace";
    cCtx.textAlign = "center";
    cCtx.textBaseline = "middle";
    cCtx.fillText("F10", 64, 64);
    const clothTex = new THREE.CanvasTexture(clothCanvas);
    const cloth = new THREE.Mesh(
      new THREE.PlaneGeometry(4.4, 4.4),
      new THREE.MeshBasicMaterial({ map: clothTex }),
    );
    cloth.rotation.x = -Math.PI / 2;
    cloth.position.y = 14.0;
    g.add(cloth);
    g.add(base, body, par, psnow);
    g.position.set(x, 0, z);
    mapGroup.add(g);
    solids.push({ x, z, r: 2.2 });
  }
  function addTowerSnowGrass(cx, cz, rng) {
    const count = 6 + Math.floor(rng() * 5);
    for (let i = 0; i < count; i++) {
      const angle = rng() * Math.PI * 2;
      const dist  = 3.2 + rng() * 3.8;
      const px = cx + Math.cos(angle) * dist;
      const pz = cz + Math.sin(angle) * dist;
      if (Math.abs(px) > MAP_HALF - 1 || Math.abs(pz) > MAP_HALF - 1) continue;
      const g = new THREE.Group();
      const bladeCount = 2 + Math.floor(rng() * 3);
      for (let j = 0; j < bladeCount; j++) {
        const ox = (rng() * 2 - 1) * 0.4, oz = (rng() * 2 - 1) * 0.4;
        const h  = 0.28 + rng() * 0.32;
        const col = rng() < 0.5 ? 0xc8dce0 : 0xa8c8b8;
        const blade = box(0.12, h, 0.12, col);
        blade.position.set(ox, h / 2, oz);
        blade.rotation.y = rng() * Math.PI;
        g.add(blade);
      }
      g.position.set(px, 0, pz);
      mapGroup.add(g);
    }
  }
  function addGrass(x, z, rng) {
    const g = new THREE.Group();
    const count = 2 + Math.floor(rng() * 3); // 2–4 blades
    for (let i = 0; i < count; i++) {
      const ox = (rng() * 2 - 1) * 0.4, oz = (rng() * 2 - 1) * 0.4;
      const h  = 0.3 + rng() * 0.35;
      const col = rng() < 0.5 ? 0x4a7a38 : 0x5a8a42;
      const blade = box(0.12, h, 0.12, col);
      blade.position.set(ox, h / 2, oz);
      blade.rotation.y = rng() * Math.PI;
      g.add(blade);
    }
    g.position.set(x, 0, z);
    mapGroup.add(g);
    // No solid entry — grass is purely decorative
  }
  function addTree(x, z, rng) {
    const rand = rng || Math.random.bind(Math);
    const sc = 0.68 + rand() * 0.66;            // 0.68 – 1.34 scale
    const g = new THREE.Group();
    const trunk = box(0.5, 1.6, 0.5, 0x5c3d1e); trunk.position.y = 0.8;
    const f1 = box(2.0, 1.4, 2.0, 0x2d5e2a); f1.position.y = 2.0;
    const f2 = box(1.3, 1.2, 1.3, 0x254f22); f2.position.y = 3.0;
    g.add(trunk, f1, f2);
    g.scale.setScalar(sc);
    g.position.set(x, 0, z);
    mapGroup.add(g);
    solids.push({ x, z, r: 1.1 * sc });
  }
  function addMountain(x, z, rng, tier = 1) {
    // tier 0 = small hillock, 1 = medium (original), 2 = large peak
    const tierScales = [0.48 + rng() * 0.22, 0.82 + rng() * 0.30, 1.40 + rng() * 0.45];
    const sc = tierScales[tier] ?? tierScales[1];
    const g = new THREE.Group();
    // Rocky base + snow-capped cone.
    const rock = new THREE.Mesh(
      new THREE.ConeGeometry(2.6, 2.2, 7),
      new THREE.MeshStandardMaterial({ color: 0x8b8f96, roughness: 1, flatShading: true })
    );
    rock.position.y = 1.1; rock.castShadow = true; rock.receiveShadow = true;
    const snow = new THREE.Mesh(
      new THREE.ConeGeometry(1.7, 2.4, 7),
      new THREE.MeshStandardMaterial({ color: 0xf4f8fb, roughness: 0.9, flatShading: true })
    );
    snow.position.y = 2.6; snow.castShadow = true;
    g.add(rock, snow);
    g.scale.setScalar(sc);
    g.rotation.y = rng() * Math.PI;
    g.position.set(x, 0, z);
    mapGroup.add(g);
    solids.push({ x, z, r: 1.9 * sc });
  }
  function addRiverBoulder(x, z, rng) {
    const g = new THREE.Group();
    const sz = 1.1 + rng() * 0.8;
    const rock = new THREE.Mesh(
      new THREE.SphereGeometry(sz, 6, 5),
      new THREE.MeshStandardMaterial({ color: 0x7a7875, roughness: 1, flatShading: true }),
    );
    rock.position.y = sz * 0.45;
    rock.rotation.set(rng() * 0.6, rng() * Math.PI * 2, rng() * 0.6);
    rock.castShadow = true;
    const snowCap = box(sz * 1.3, sz * 0.32, sz * 1.3, 0xdde9f5);
    snowCap.position.y = sz * 1.0;
    g.add(rock, snowCap);
    g.position.set(x, 0, z);
    mapGroup.add(g);
    solids.push({ x, z, r: sz * 1.05 });
  }
  function addFallenLog(x, z, rng) {
    const len   = 2.6 + rng() * 2.6;
    const thick = 0.20 + rng() * 0.12;
    const g = new THREE.Group();
    // Cylinder lying on its side: rotate so axis runs along local X, then spin in Y.
    const logMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(thick, thick * 1.12, len, 7),
      new THREE.MeshStandardMaterial({ color: 0x4a2e12, roughness: 1, metalness: 0 })
    );
    logMesh.rotation.z = Math.PI / 2;  // lay flat
    logMesh.position.y = thick;         // sit on ground
    logMesh.castShadow = true; logMesh.receiveShadow = true;
    // Snow drape — a flattened box spanning the top of the cylinder
    const snowMesh = new THREE.Mesh(
      new THREE.BoxGeometry(len * 1.02, thick * 0.28, thick * 2.0),
      new THREE.MeshStandardMaterial({ color: 0xe2eef8, roughness: 0.9, metalness: 0 })
    );
    snowMesh.position.y = thick * 2;  // top surface of the cylinder
    g.add(logMesh, snowMesh);
    g.rotation.y = rng() * Math.PI;
    g.position.set(x, 0, z);
    mapGroup.add(g);
    // Logs are thin — no solid entry, fighters step around them naturally
  }
  function buildRiver(rng) {
    const hw    = 7 + rng() * 5;                    // half-width 7–12 → river 14–24 u wide
    riverHalfW  = hw;
    const limit = MAP_HALF - hw - 2;                 // keep bends inside map
    const horiz = rng() < 0.5;

    const clampLat = (v) => Math.max(-limit, Math.min(limit, v));

    // 5 waypoints for a natural S-curve / meander
    const c0 = clampLat((rng() * 2 - 1) * limit * 0.55);
    const c1 = clampLat(c0 + (rng() * 2 - 1) * limit * 0.65);
    const c2 = clampLat(c0 + (rng() * 2 - 1) * limit * 0.70);
    const c3 = clampLat(c2 + (rng() * 2 - 1) * limit * 0.55);
    const c4 = clampLat((rng() * 2 - 1) * limit * 0.50);

    let wps;
    if (horiz) {
      wps = [
        { x: -MAP_HALF,        z: c0 },
        { x: -MAP_HALF * 0.5,  z: c1 },
        { x:  0,               z: c2 },
        { x:  MAP_HALF * 0.5,  z: c3 },
        { x:  MAP_HALF,        z: c4 },
      ];
    } else {
      wps = [
        { x: c0, z: -MAP_HALF        },
        { x: c1, z: -MAP_HALF * 0.5  },
        { x: c2, z:  0               },
        { x: c3, z:  MAP_HALF * 0.5  },
        { x: c4, z:  MAP_HALF        },
      ];
    }
    // Sample Catmull-Rom bezier so inRiver() checks the same curve drawn on screen.
    const STEPS = 20;
    const sampledPts = [];
    for (let i = 0; i < wps.length - 1; i++) {
      const p0 = wps[Math.max(0, i - 1)];
      const p1 = wps[i];
      const p2 = wps[i + 1];
      const p3 = wps[Math.min(wps.length - 1, i + 2)];
      const cp1x = p1.x + (p2.x - p0.x) / 6, cp1z = p1.z + (p2.z - p0.z) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6, cp2z = p2.z - (p3.z - p1.z) / 6;
      for (let s = 0; s < STEPS; s++) {
        const t = s / STEPS, mt = 1 - t;
        sampledPts.push({
          x: mt*mt*mt*p1.x + 3*mt*mt*t*cp1x + 3*mt*t*t*cp2x + t*t*t*p2.x,
          z: mt*mt*mt*p1.z + 3*mt*mt*t*cp1z + 3*mt*t*t*cp2z + t*t*t*p2.z,
        });
      }
    }
    sampledPts.push(wps[wps.length - 1]);
    riverSegments = sampledPts;

    // Smooth Catmull-Rom bezier canvas texture — organic rounded edges.
    const CS  = 512;
    const rc  = document.createElement("canvas");
    rc.width  = CS; rc.height = CS;
    const rctx = rc.getContext("2d");

    const toU = (wx) => (wx + MAP_HALF) / MAP_WORLD * CS;
    const toV = (wz) => (wz + MAP_HALF) / MAP_WORLD * CS;
    const pts  = wps.map((wp) => ({ u: toU(wp.x), v: toV(wp.z) }));
    const lw   = hw * 2 / MAP_WORLD * CS;

    const crBez = (i) => {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];
      return {
        cp1u: p1.u + (p2.u - p0.u) / 6, cp1v: p1.v + (p2.v - p0.v) / 6,
        cp2u: p2.u - (p3.u - p1.u) / 6, cp2v: p2.v - (p3.v - p1.v) / 6,
      };
    };
    const drawPath = () => {
      rctx.beginPath();
      rctx.moveTo(pts[0].u, pts[0].v);
      for (let i = 0; i < pts.length - 1; i++) {
        const { cp1u, cp1v, cp2u, cp2v } = crBez(i);
        rctx.bezierCurveTo(cp1u, cp1v, cp2u, cp2v, pts[i + 1].u, pts[i + 1].v);
      }
    };

    rctx.save(); rctx.strokeStyle = "rgba(20,60,100,0.35)";
    rctx.lineWidth = lw + 10; rctx.lineCap = "round"; rctx.lineJoin = "round";
    drawPath(); rctx.stroke(); rctx.restore();

    rctx.save(); rctx.strokeStyle = "rgba(55,120,175,0.88)";
    rctx.lineWidth = lw; rctx.lineCap = "round"; rctx.lineJoin = "round";
    drawPath(); rctx.stroke(); rctx.restore();

    const tex   = new THREE.CanvasTexture(rc);
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(MAP_WORLD, MAP_WORLD),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.y  = 0.05;
    plane.receiveShadow = false;
    mapGroup.add(plane);

    // Snowy boulders scattered on the river
    for (let attempt = 0, count = 0; attempt < 80 && count < 5; attempt++) {
      const si = Math.floor(rng() * (wps.length - 1));
      const t  = rng();
      const a  = wps[si], b = wps[si + 1];
      const cx = a.x + (b.x - a.x) * t, cz = a.z + (b.z - a.z) * t;
      const fdx = b.x - a.x, fdz = b.z - a.z;
      const flen = Math.hypot(fdx, fdz) || 1;
      const perpX = -fdz / flen, perpZ = fdx / flen;
      const off = (rng() * 2 - 1) * hw * 0.55;
      const bx = cx + perpX * off, bz = cz + perpZ * off;
      if (!inRiver(bx, bz)) continue;
      if (collidesSolid(bx, bz, 2.2)) continue;
      addRiverBoulder(bx, bz, rng);
      count++;
    }

    // Fish — koi-gold silhouettes swimming the centre-line with a lazy wiggle.
    // Distance-parameterised along the sampled curve so speed is uniform.
    const cum = [0];
    for (let i = 1; i < sampledPts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(
        sampledPts[i].x - sampledPts[i - 1].x,
        sampledPts[i].z - sampledPts[i - 1].z
      ));
    }
    const riverLen = cum[cum.length - 1];
    const posAt = (dist) => {
      let d = dist % riverLen; if (d < 0) d += riverLen;
      let i = 1;
      while (i < cum.length - 1 && cum[i] < d) i++;
      const a = sampledPts[i - 1], b = sampledPts[i];
      const seg = cum[i] - cum[i - 1] || 1e-6;
      const t = (d - cum[i - 1]) / seg;
      const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
      return { x: a.x + dx * t, z: a.z + dz * t, dirx: dx / len, dirz: dz / len };
    };

    const FISH_COLORS = [0xe8963c, 0xd4a017, 0xf2ce5b];
    const fishCount = 8 + Math.floor(rng() * 4); // 8–11 per river
    for (let i = 0; i < fishCount; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: FISH_COLORS[Math.floor(rng() * FISH_COLORS.length)],
        roughness: 0.55, metalness: 0.35,
      });
      const fishG = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), mat);
      body.scale.set(1.7, 0.3, 0.65); // long, flat, slim — reads as a fish from above
      const tail = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.65, 6), mat);
      tail.rotation.z = Math.PI / 2;   // tip toward -x (body nose faces +x)
      tail.scale.y = 0.5;
      tail.position.set(-0.85, 0, 0);
      fishG.add(body, tail);
      fishG.position.y = 0.09; // just above the water plane (y = 0.05)
      mapGroup.add(fishG);
      riverFish.push({
        g: fishG, posAt,
        dist: rng() * riverLen,
        speed: (2 + rng() * 2.2) * (rng() < 0.5 ? 1 : -1), // both directions
        lat: hw * (0.15 + rng() * 0.45),   // lateral lane, well inside the banks
        latPhase: rng() * Math.PI * 2,
        wigglePhase: rng() * Math.PI * 2,
      });
    }
  }
  // Paints a transparent biome-tint overlay the same size as the arena floor.
  // Blue-grey near the river banks, darker earth near large mountain bases.
  // Called after all solids are placed so it can read the final solid list.
  function buildBiomeOverlay() {
    const CS = 256; // texel resolution; soft blending means high-res isn't needed
    const bc = document.createElement("canvas");
    bc.width = bc.height = CS;
    const bctx = bc.getContext("2d");
    const imgData = bctx.createImageData(CS, CS);
    const px = imgData.data;
    // Large mountain solids (r >= 1.4) for the dark-earth halo
    const peaks = solids.filter((s) => s.r >= 1.4);

    for (let py = 0; py < CS; py++) {
      for (let pxi = 0; pxi < CS; pxi++) {
        const wx = ((pxi + 0.5) / CS) * MAP_WORLD - MAP_HALF;
        const wz = ((py  + 0.5) / CS) * MAP_WORLD - MAP_HALF;

        let r = 0, g = 0, b = 0, a = 0;

        // River zone — blue-grey tint that fades out beyond 2× the river half-width
        if (riverSegments.length > 1) {
          let minD = Infinity;
          for (let i = 0; i < riverSegments.length - 1; i++) {
            const sa = riverSegments[i], sb = riverSegments[i + 1];
            const abx = sb.x - sa.x, abz = sb.z - sa.z;
            const len2 = abx * abx + abz * abz || 1e-6;
            let t = ((wx - sa.x) * abx + (wz - sa.z) * abz) / len2;
            t = Math.max(0, Math.min(1, t));
            const d = Math.hypot(wx - (sa.x + abx * t), wz - (sa.z + abz * t));
            if (d < minD) minD = d;
          }
          const inner = riverHalfW, outer = riverHalfW * 2.4;
          if (minD < outer) {
            const fade = Math.max(0, 1 - (minD - inner) / (outer - inner));
            r = 62; g = 88; b = 118;
            a = Math.round(fade * 52);
          }
        }

        // Mountain halo — dark earthy tint around large peaks
        for (const s of peaks) {
          const d = Math.hypot(wx - s.x, wz - s.z);
          const inner2 = s.r * 1.1, outer2 = s.r * 3.8;
          if (d < outer2) {
            const fade = Math.max(0, 1 - (d - inner2) / (outer2 - inner2));
            const da = Math.round(fade * 44);
            if (da > a) { r = 22; g = 20; b = 16; a = da; }
          }
        }

        const idx = (py * CS + pxi) * 4;
        px[idx] = r; px[idx + 1] = g; px[idx + 2] = b; px[idx + 3] = a;
      }
    }
    bctx.putImageData(imgData, 0, 0);
    const tex = new THREE.CanvasTexture(bc);
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(MAP_WORLD, MAP_WORLD),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = 0.03;
    mapGroup.add(plane);
  }
  function generateMap(seedStr) {
    clearMap();
    const rng = makeRng(seedStr || "demo");
    buildRiver(rng);
    // Four snowy watchtowers, one at each corner — always present
    const tOff = MAP_HALF - 5;
    [[-tOff,-tOff],[-tOff,tOff],[tOff,-tOff],[tOff,tOff]].forEach(([tx,tz]) => {
      addTower(tx, tz);
      addTowerSnowGrass(tx, tz, rng);
    });
    const scatter = (count, adder, gap) => {
      let made = 0, tries = 0;
      while (made < count && tries < count * 40) {
        tries++;
        const x = (rng() * 2 - 1) * (MAP_HALF - 4);
        const z = (rng() * 2 - 1) * (MAP_HALF - 4);
        if (inRiver(x, z) || collidesSolid(x, z, gap)) continue;
        adder(x, z); made++;
      }
    };
    scatter(18, (x, z) => addTree(x, z, rng), 2.4);
    scatter(3, (x, z) => addMountain(x, z, rng, 0), 2.2);  // small hillocks
    scatter(4, (x, z) => addMountain(x, z, rng, 1), 3.4);  // medium peaks
    scatter(2, (x, z) => addMountain(x, z, rng, 2), 4.8);  // large peaks
    scatter(10, (x, z) => addFallenLog(x, z, rng), 1.4);
    scatter(45, (x, z) => addGrass(x, z, rng), 0.6);
    buildBiomeOverlay();
  }
  // A free, dry spawn point anywhere on the map.
  // Pass a seeded rng (from makeRng) for deterministic placement across clients.
  function randomSpawn(rng) {
    const rand = rng || Math.random.bind(Math);
    for (let i = 0; i < 80; i++) {
      const x = (rand() * 2 - 1) * (MAP_HALF - 3);
      const z = (rand() * 2 - 1) * (MAP_HALF - 3);
      if (!inRiver(x, z) && !collidesSolid(x, z, BODY_R + 0.4)) return { x, z };
    }
    return {
      x: (rand() * 2 - 1) * (MAP_HALF - 3),
      z: (rand() * 2 - 1) * (MAP_HALF - 3),
    };
  }

  // -- State ----------------------------------------------------------------
  let perspective = "offline";
  let controllable = false;
  let matchPhase = "offline";
  let resultSent = false;
  let emitAcc = 0;
  let kills = 0;
  let viewIsGame = false;
  let localUserId = null;

  // -- Combat ---------------------------------------------------------------
  const ARRIVE = 0.06;
  const bullets = [];
  function moveStep(f, tx, tz, dt) {
    const px = f.group.position.x, pz = f.group.position.z;
    const dx = tx - px, dz = tz - pz;
    const dist = Math.hypot(dx, dz);
    if (dist <= ARRIVE) return true;
    const slow = inRiver(px, pz) ? RIVER_SLOW : 1;
    const step = Math.min(f.speed * slow * dt, dist);
    const lim = MAP_HALF - 0.5;
    const ndx = dx / dist, ndz = dz / dist;
    const nx = Math.max(-lim, Math.min(lim, px + ndx * step));
    const nz = Math.max(-lim, Math.min(lim, pz + ndz * step));
    f.facing = Math.atan2(dx, dz);
    if (!collidesSolid(nx, nz, BODY_R) && !collidesFish(nx, nz, BODY_R)) {
      f.group.position.x = nx; f.group.position.z = nz;
      f.walkPhase += dt * f.speed * 1.6;
      f.moving = true;
      return false;
    }

    // Direct path blocked — find the nearest solid intersecting our path.
    let blocker = null, blockerDSq = Infinity;
    const clearance = BODY_R;
    for (const s of solids) {
      const sdx = s.x - px, sdz = s.z - pz;
      const t = Math.max(0, Math.min(dist, sdx * ndx + sdz * ndz));
      const cx = px + ndx * t, cz = pz + ndz * t;
      const perpSq = (s.x - cx) ** 2 + (s.z - cz) ** 2;
      const limit = s.r + clearance;
      if (perpSq < limit * limit) {
        const dSq = sdx * sdx + sdz * sdz;
        if (dSq < blockerDSq) { blockerDSq = dSq; blocker = s; }
      }
    }

    if (blocker) {
      // Steer around the blocker on the same side as the target.
      const toSolidX = blocker.x - px, toSolidZ = blocker.z - pz;
      const toSolidLen = Math.hypot(toSolidX, toSolidZ) || 1;
      // 2D cross: positive → target is CCW (left) of the solid from player's view.
      const cross = toSolidX * (tz - pz) - toSolidZ * (tx - px);
      const side = cross >= 0 ? 1 : -1;
      const perpX =  side * (-toSolidZ / toSolidLen);
      const perpZ =  side * ( toSolidX / toSolidLen);
      const tangentX = blocker.x + perpX * (blocker.r + BODY_R + 0.35);
      const tangentZ = blocker.z + perpZ * (blocker.r + BODY_R + 0.35);
      const tdx = tangentX - px, tdz = tangentZ - pz;
      const tdist = Math.hypot(tdx, tdz) || 1;
      const anx = Math.max(-lim, Math.min(lim, px + (tdx / tdist) * step));
      const anz = Math.max(-lim, Math.min(lim, pz + (tdz / tdist) * step));
      if (!collidesSolid(anx, anz, BODY_R) && !collidesFish(anx, anz, BODY_R)) {
        f.group.position.x = anx; f.group.position.z = anz;
        f.facing = Math.atan2(tdx, tdz);
        f.walkPhase += dt * f.speed * 1.6;
        f.moving = true;
        return false;
      }
    }

    // Tangent also blocked (tight gap) — try sliding along each axis separately.
    const axX = Math.max(-lim, Math.min(lim, px + ndx * step));
    if (!collidesSolid(axX, pz, BODY_R) && !collidesFish(axX, pz, BODY_R)) {
      f.group.position.x = axX;
      f.walkPhase += dt * f.speed * 1.6; f.moving = true;
    } else {
      const azZ = Math.max(-lim, Math.min(lim, pz + ndz * step));
      if (!collidesSolid(px, azZ, BODY_R) && !collidesFish(px, azZ, BODY_R)) {
        f.group.position.z = azZ;
        f.walkPhase += dt * f.speed * 1.6; f.moving = true;
      }
    }
    return false;
  }
  // Networked opponent interpolation: snap on big jumps (teleport / first
  // packet), otherwise close the gap fast enough to keep pace with the remote
  // player. A fixed catch-up rate keeps motion smooth without trailing behind.
  function netMove(f, tx, tz, dt) {
    const dx = tx - f.group.position.x, dz = tz - f.group.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= ARRIVE) { f.moving = false; return; }
    if (dist > 6) {
      f.group.position.x = tx; f.group.position.z = tz;
      f.facing = Math.atan2(dx, dz);
      return;
    }
    const step = Math.min(dist, Math.max(dist * 16, 8) * dt);
    f.group.position.x += dx / dist * step;
    f.group.position.z += dz / dist * step;
    f.facing = Math.atan2(dx, dz);
    f.walkPhase += dt * f.speed * 1.6;
    f.moving = true;
  }
  // Broadcast the local player's authoritative state. Throttled in the loop,
  // but also forced the instant our HP changes so opponents' bars track damage.
  function emitState() {
    if (perspective !== "player") return;
    emitAcc = 0;
    options.onLocalState?.({
      x: +player.group.position.x.toFixed(2), z: +player.group.position.z.toFixed(2),
      hp: player.hp, maxHp: player.maxHp, facing: +player.facing.toFixed(2),
      weapon: player.weapon.id, name: player.name, level: player.level
    });
  }
  function applyDamage(def, dmg, bySelf = false) {
    if (def.dead) return;
    def.hp = Math.max(0, def.hp - dmg);
    def.hurt = 0.18;
    if (def.hp <= 0) {
      killFighter(def);
      // Shadow-ledger (Option A): when the LOCAL player lands a lethal blow on a
      // networked opponent, surface a kill event so the server can corroborate
      // the death independently of any client's self-reported HP.
      if (bySelf && def !== player && def.userId && foeMode === "net") {
        options.onLocalKill?.({ victimId: def.userId });
      }
    }
    if (def === player && foeMode === "net") emitState();
  }
  // `impact` is an { x, z } point where the shot is stopped by a solid before it
  // can reach `def`. When given, the bullet flies to that point and deals no
  // damage — the obstruction soaks the round.
  function fireBullet(att, def, dmg, deal, weapon, impact = null) {
    const bulletSize  = weapon?.bulletSize  ?? 0.13;
    const bulletSpeed = weapon?.bulletSpeed ?? 46;
    const bGroup = new THREE.Group();
    const baseM = new THREE.Mesh(
      new THREE.SphereGeometry(bulletSize * 1.35, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0x0a0a0a })
    );
    const tipM = new THREE.Mesh(
      new THREE.SphereGeometry(bulletSize, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0xFFD700 })
    );
    bGroup.add(baseM, tipM);
    const fx = Math.sin(att.facing), fz = Math.cos(att.facing);
    bGroup.position.set(att.group.position.x + fx * 0.8, 1.5, att.group.position.z + fz * 0.8);
    scene.add(bGroup);
    const target = impact
      ? new THREE.Vector3(impact.x, 1.45, impact.z)
      : new THREE.Vector3(def.group.position.x, 1.45, def.group.position.z);
    bullets.push({ mesh: bGroup, def: impact ? null : (deal ? def : null), dmg, bySelf: att === player, speed: bulletSpeed, target });
  }
  function updateBullets(dt) {
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      _bulletDir.subVectors(b.target, b.mesh.position);
      const dist = _bulletDir.length(), step = b.speed * dt;
      if (dist <= step || dist < 0.5) {
        if (b.def && !b.def.dead) applyDamage(b.def, b.dmg, b.bySelf);
        scene.remove(b.mesh);
        disposeObject3D(b.mesh);
        bullets.splice(i, 1);
      } else {
        b.mesh.position.addScaledVector(_bulletDir.normalize(), step);
      }
    }
  }

  const grenades = [];
  const explosions = [];
  function fireGrenade(att, tx, tz, dmg) {
    const sx = att.group.position.x, sz = att.group.position.z;
    const dist = Math.hypot(tx - sx, tz - sz);
    const duration = Math.max(0.5, dist / 22);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0x222222 })
    );
    mesh.position.set(sx, 1.3, sz);
    scene.add(mesh);
    grenades.push({ mesh, sx, sz, tx, tz, elapsed: 0, duration, phase: "flying", fuseTimer: 0, dmg, deal: att === player });
  }
  function updateGrenades(dt) {
    for (let i = grenades.length - 1; i >= 0; i--) {
      const g = grenades[i];
      if (g.phase === "flying") {
        g.elapsed += dt;
        const t = Math.min(1, g.elapsed / g.duration);
        g.mesh.position.set(
          g.sx + (g.tx - g.sx) * t,
          1.0 + 4.5 * Math.sin(Math.PI * t),
          g.sz + (g.tz - g.sz) * t
        );
        if (t >= 1) { g.phase = "fuse"; g.fuseTimer = 0; }
      } else {
        g.fuseTimer += dt;
        g.mesh.visible = (Math.floor(g.fuseTimer * 10) % 2 === 0);
        if (g.fuseTimer >= 1.0) {
          // AOE explosion
          const blastR = WEAPONS.frag.blastRadius;
          const allFighters = [player, ...foeList()];
          for (const f of allFighters) {
            if (f.dead || !f.connected) continue;
            if (f === player && g.deal) continue; // player doesn't self-damage
            if (f !== player && !g.deal) continue; // AI grenade only hits player
            const d = Math.hypot(f.group.position.x - g.tx, f.group.position.z - g.tz);
            if (d <= blastR) {
              const dmg = Math.max(1, Math.round(g.dmg * (1 - d / blastR)));
              applyDamage(f, dmg, g.deal && f !== player);
              // Grenade damage is only known here — blast falloff, splash on
              // bystanders, or a clean miss — so the settlement ledger is fed
              // per victim actually hit, not from the aim at throw time.
              if (g.deal && f !== player && f.userId && foeMode === "net") {
                options.onGrenadeDamage?.({ victimId: f.userId, dmg });
              }
            }
          }
          // Explosion flash
          const flashGeo = new THREE.SphereGeometry(blastR, 8, 6);
          const flashMat = new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.75 });
          const flash = new THREE.Mesh(flashGeo, flashMat);
          flash.position.set(g.tx, 1, g.tz);
          scene.add(flash);
          explosions.push({ mesh: flash, t: 0 });
          scene.remove(g.mesh);
          disposeObject3D(g.mesh);
          grenades.splice(i, 1);
        }
      }
    }
  }
  function updateExplosions(dt) {
    for (let i = explosions.length - 1; i >= 0; i--) {
      const ex = explosions[i];
      ex.t += dt;
      if (ex.t >= 0.45) {
        scene.remove(ex.mesh);
        disposeObject3D(ex.mesh);
        explosions.splice(i, 1);
      } else {
        ex.mesh.material.opacity = 0.75 * (1 - ex.t / 0.45);
        ex.mesh.scale.setScalar(1 + ex.t * 3);
      }
    }
  }
  // Returns true once the attack is committed (cooldown started), so the
  // caller can stop after a single strike rather than auto-repeating.
  function playerAttack(def) {
    if (player.cdTimer > 0 || def.dead || player.hp <= 0) return false;
    const w = player.weapon;
    player.cdTimer = w.cd;
    player.atkAnim = 0.32;
    // Trees / snow mountains in the way stop the attack. Melee simply deflects
    // (swing plays, no hit); a ranged shot still leaves the barrel and thuds
    // into the obstruction, dealing no damage to the sheltered target.
    if (losBlocked(player.group.position.x, player.group.position.z, def.group.position.x, def.group.position.z)) {
      if (w.ranged) {
        const impact = rayBlockHit(player.group.position.x, player.group.position.z, def.group.position.x, def.group.position.z)
          || { x: def.group.position.x, z: def.group.position.z };
        fireBullet(player, def, 0, false, w, impact);
      }
      return true;
    }
    let dmg = Math.max(1, Math.round(w.atk + (Math.random() * 2 - 1) * w.atkVar));
    if (inRiver(player.group.position.x, player.group.position.z)) dmg = Math.max(1, Math.round(dmg * RIVER_ATK));
    if (foeMode === "net") {
      // Optimistic: apply the same damage locally and tell everyone. All
      // clients compute from the identical dmg, so the target's bar drops
      // instantly here instead of after a network round-trip.
      if (w.ranged) fireBullet(player, def, dmg, true, w);
      else applyDamage(def, dmg, true);
      options.onAttack?.({ fromId: localUserId, targetId: def.userId, weapon: w.id, dmg, ranged: !!w.ranged });
    } else {
      if (w.ranged) fireBullet(player, def, dmg, true, w);
      else applyDamage(def, dmg);
    }
    return true;
  }
  function aiAttackOne(e) {
    if (e.cdTimer > 0 || player.dead || e.hp <= 0) return;
    const w = e.weapon;
    e.cdTimer = w.cd;
    e.atkAnim = 0.32;
    if (losBlocked(e.group.position.x, e.group.position.z, player.group.position.x, player.group.position.z)) {
      if (w.ranged) {
        const impact = rayBlockHit(e.group.position.x, e.group.position.z, player.group.position.x, player.group.position.z)
          || { x: player.group.position.x, z: player.group.position.z };
        fireBullet(e, player, 0, false, w, impact);
      }
      return;
    }
    let dmg = Math.max(1, Math.round(w.atk + (Math.random() * 2 - 1) * w.atkVar));
    if (inRiver(e.group.position.x, e.group.position.z)) dmg = Math.max(1, Math.round(dmg * RIVER_ATK));
    if (w.ranged) fireBullet(e, player, dmg, false, w);
    else applyDamage(player, dmg);
  }
  function killFighter(f) {
    f.dead = true;
    f.moving = false;
    f.deadTimer = f.isPlayer ? 1.8 : 2.2;
    if (foeMode === "ai" && aiRaiders.includes(f)) kills++;
    if (f.isPlayer) fragRing.visible = false;
  }
  function handleDead(f, dt) {
    f.group.rotation.z = Math.min(Math.PI / 2, f.group.rotation.z + dt * 5);
    f.group.position.y = Math.max(-0.5, f.group.position.y - dt * 0.7);
    if (foeMode === "net") return; // no respawns in PvP
    f.deadTimer -= dt;
    if (f.deadTimer <= 0) respawn(f);
  }
  function respawn(f) {
    f.hp = f.maxHp; f.dead = false;
    f.group.rotation.z = 0; f.group.position.y = 0;
    f.cdTimer = 0; f.atkAnim = 0; f.hurt = 0; f.moving = false;
    const sp = randomSpawn();
    f.group.position.set(sp.x, 0, sp.z);
    if (f.isPlayer) { f.attackTarget = null; f.target = null; camCenter.set(sp.x, 0, sp.z); fragRing.visible = player.weapon?.isGrenade ?? false; }
  }
  function regen(f, dt) {
    // No regeneration in PvP: opponents clamp our HP with min() so it can never
    // rise on their screens, and the server derives HP as 100 − damage with no
    // regen either — local healing would only desync the three views and cause
    // "I survived on my screen but the server says I lost". Demo mode keeps it.
    if (foeMode === "net") return;
    if (f.hp >= f.maxHp || f.dead) { f.regenAcc = 0; return; }
    f.regenAcc += dt;
    if (f.regenAcc >= 2) { f.hp = Math.min(f.maxHp, f.hp + 1); f.regenAcc -= 2; }
  }
  function nearestFoe() {
    let best = null, bestD = Infinity;
    for (const f of foeList()) {
      if (!f.connected || f.dead) continue;
      const d = Math.hypot(f.group.position.x - player.group.position.x, f.group.position.z - player.group.position.z);
      if (d < bestD) { bestD = d; best = f; }
    }
    return best;
  }
  function updatePlayer(dt) {
    const p = player;
    if (p.dead) { handleDead(p, dt); return; }
    if (p.cdTimer > 0) p.cdTimer -= dt;
    if (p.atkAnim > 0) p.atkAnim -= dt;
    regen(p, dt);
    p.moving = false;
    if (!controllable) return;
    // Melee or ranged: close to weapon range, then face the target and fire.
    // Sniper requires holding still for chargeTime before the shot is released.
    if (p.attackTarget && !p.attackTarget.dead && p.attackTarget.connected) {
      const e = p.attackTarget;
      const dx = e.group.position.x - p.group.position.x, dz = e.group.position.z - p.group.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > p.weapon.range) {
        p.chargeTimer = 0;
        moveStep(p, e.group.position.x, e.group.position.z, dt);
      } else {
        p.facing = Math.atan2(dx, dz);
        const ct = p.weapon.chargeTime ?? 0;
        if (ct > 0 && p.cdTimer <= 0) {
          // Sniper: stand still, hold aim pose, then fire after chargeTime.
          p.chargeTimer += dt;
          p.atkAnim = Math.max(p.atkAnim, 0.1);
          if (p.chargeTimer >= ct) {
            p.chargeTimer = 0;
            if (playerAttack(e)) p.attackTarget = null;
          }
        } else {
          p.chargeTimer = 0;
          if (playerAttack(e)) p.attackTarget = null;
        }
      }
    } else {
      p.attackTarget = null;
      p.chargeTimer = 0;
      const anyWasd = wasd.w || wasd.a || wasd.s || wasd.d;
      if (anyWasd) {
        // Derive screen-right and screen-up projected on ground from camera matrix
        camera.updateMatrixWorld(false);
        _wasdR.setFromMatrixColumn(camera.matrixWorld, 0); _wasdR.y = 0; _wasdR.normalize();
        _wasdF.setFromMatrixColumn(camera.matrixWorld, 1); _wasdF.y = 0; _wasdF.normalize();
        let mdx = 0, mdz = 0;
        if (wasd.w) { mdx += _wasdF.x; mdz += _wasdF.z; }
        if (wasd.s) { mdx -= _wasdF.x; mdz -= _wasdF.z; }
        if (wasd.a) { mdx -= _wasdR.x; mdz -= _wasdR.z; }
        if (wasd.d) { mdx += _wasdR.x; mdz += _wasdR.z; }
        const mlen = Math.hypot(mdx, mdz) || 1;
        moveStep(p, p.group.position.x + mdx / mlen * 200, p.group.position.z + mdz / mlen * 200, dt);
        p.target = null;
        following = true;
      } else {
        if (p.target && moveStep(p, p.target.x, p.target.z, dt)) p.target = null;
      }
    }
  }
  function updateAi(dt) {
    for (const e of aiRaiders) {
      if (e.dead) { handleDead(e, dt); continue; }
      if (e.cdTimer > 0) e.cdTimer -= dt;
      if (e.atkAnim > 0) e.atkAnim -= dt;
      e.moving = false;
      regen(e, dt);
      if (player.dead || !controllable) continue;
      const dx = player.group.position.x - e.group.position.x, dz = player.group.position.z - e.group.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= AI_AGGRO) {
        if (dist > e.weapon.range) moveStep(e, player.group.position.x, player.group.position.z, dt);
        else { e.facing = Math.atan2(dx, dz); aiAttackOne(e); }
      }
    }
  }
  function updateNetFoe(f, dt) {
    if (f.dead) { handleDead(f, dt); return; }
    if (f.cdTimer > 0) f.cdTimer -= dt;
    if (f.atkAnim > 0) f.atkAnim -= dt;
    f.moving = false;
    if (f.netTarget) netMove(f, f.netTarget.x, f.netTarget.z, dt);
  }
  function updateVisual(f, dt) {
    if (f.dead) return;
    let da = f.facing - f.group.rotation.y;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    f.group.rotation.y += da * Math.min(1, dt * 12);
    const ease = Math.min(1, dt * 10);
    if (f.atkAnim > 0) {
      const k = 1 - f.atkAnim / 0.32;
      f.armR.rotation.x = f.weapon.ranged ? -1.25 * Math.sin(k * Math.PI) : (k < 0.4 ? -2 * (k / 0.4) : -2 + 2.9 * ((k - 0.4) / 0.6));
      f.legL.rotation.x += -f.legL.rotation.x * ease;
      f.legR.rotation.x += -f.legR.rotation.x * ease;
      f.armL.rotation.x += -f.armL.rotation.x * ease;
    } else {
      const sw = f.moving ? Math.sin(f.walkPhase) * 0.7 : 0;
      f.legL.rotation.x += (sw - f.legL.rotation.x) * ease;
      f.legR.rotation.x += (-sw - f.legR.rotation.x) * ease;
      f.armL.rotation.x += (-sw * 0.6 - f.armL.rotation.x) * ease;
      f.armR.rotation.x += (sw * 0.6 - f.armR.rotation.x) * ease;
    }
    const bob = f.moving ? Math.abs(Math.sin(f.walkPhase)) * 0.07 : 0;
    f.group.position.y += (bob - f.group.position.y) * ease;
    if (f.hurt > 0) f.hurt -= dt;
  }

  // -- Health bars ----------------------------------------------------------
  const _bv = new THREE.Vector3();
  const _sunOffset = new THREE.Vector3(20, 40, 12); // pre-alloc: reused every frame
  const _bulletDir = new THREE.Vector3();            // pre-alloc: reused per bullet per frame
  const _wasdR = new THREE.Vector3();
  const _wasdF = new THREE.Vector3();
  const wasd = { w: false, a: false, s: false, d: false };
  function updateBar(f) {
    if (!viewIsGame || !f.connected || f.dead || settings.hideHud) { f.bar.el.style.display = "none"; return; }
    const rect = mount.getBoundingClientRect();
    _bv.set(f.group.position.x, 3.05, f.group.position.z).project(camera);
    if (_bv.z > 1) { f.bar.el.style.display = "none"; return; }
    f.bar.el.style.display = "block";
    f.bar.el.style.left = (rect.left + (_bv.x * 0.5 + 0.5) * rect.width) + "px";
    f.bar.el.style.top = (rect.top + (-_bv.y * 0.5 + 0.5) * rect.height) + "px";
    f.bar.fill.style.width = (Math.max(0, f.hp / f.maxHp) * 100) + "%";
    f.bar.fill.style.background = f.hurt > 0 ? "#ff6b6b" : f.bar.color;
    f.bar.name.textContent = f.name;
    f.bar.level.textContent = "LVL " + (f.level ?? 1);
  }

  // -- Picking --------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const _hit = new THREE.Vector3();
  function pickFoe() {
    let best = null, bestDist = Infinity;
    for (const f of foeList()) {
      if (!f.connected || f.dead) continue;
      const hits = raycaster.intersectObject(f.group, true);
      if (hits.length && hits[0].distance < bestDist) { bestDist = hits[0].distance; best = f; }
    }
    return best;
  }
  function handleTap(cx, cy) {
    if (!controllable || player.dead) return;
    const rect = mount.getBoundingClientRect();
    pointer.x = ((cx - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((cy - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const foe = pickFoe();
    if (foe) {
      if (player.weapon.isGrenade) {
        // Frag equipped — throw grenade to foe's feet instead of pursuing
        if (fragCd > 0) return;
        const tx = foe.group.position.x, tz = foe.group.position.z;
        const dist = Math.hypot(tx - player.group.position.x, tz - player.group.position.z);
        if (dist > player.weapon.range) {
          player.target = new THREE.Vector3(tx, 0, tz);
          setMarker(tx, tz, theme.markerMove[0], theme.markerMove[1]);
          selectSlot(prevSlot !== 1 ? prevSlot : 2);
          return;
        }
        const dmg = Math.max(1, Math.round(player.weapon.atk + (Math.random() * 2 - 1) * player.weapon.atkVar));
        fragCd = WEAPONS.frag.cd;
        player.atkAnim = 0.32;
        fireGrenade(player, tx, tz, dmg);
        options.onAttack?.({ fromId: localUserId, targetId: foe.userId, weapon: "frag", dmg, ranged: false, isGrenade: true, tx, tz });
        setMarker(tx, tz, 0xff8800, 0xcc5500);
        selectSlot(prevSlot !== 1 ? prevSlot : 2);
        return;
      }
      if (settings.centerCamera) following = true;
      setMarker(foe.group.position.x, foe.group.position.z, theme.markerAttack[0], theme.markerAttack[1]);
      player.target = null;
      player.attackTarget = foe; // pursue into range (melee or ranged), then fire
      return;
    }
    const hit = raycaster.ray.intersectPlane(groundPlane, _hit);
    if (hit) {
      const lim = MAP_HALF - TILE / 2;
      const tx = Math.max(-lim, Math.min(lim, (Math.floor(hit.x / TILE) + 0.5) * TILE));
      const tz = Math.max(-lim, Math.min(lim, (Math.floor(hit.z / TILE) + 0.5) * TILE));
      if (player.weapon.isGrenade) {
        if (fragCd > 0) return;
        const dist = Math.hypot(tx - player.group.position.x, tz - player.group.position.z);
        if (dist > player.weapon.range) {
          player.attackTarget = null;
          player.target = new THREE.Vector3(tx, 0, tz);
          if (settings.centerCamera) following = true;
          setMarker(tx, tz, theme.markerMove[0], theme.markerMove[1]);
          selectSlot(prevSlot !== 1 ? prevSlot : 2);
          return;
        }
        const dmg = Math.max(1, Math.round(player.weapon.atk + (Math.random() * 2 - 1) * player.weapon.atkVar));
        fragCd = WEAPONS.frag.cd;
        player.atkAnim = 0.32;
        fireGrenade(player, tx, tz, dmg);
        options.onAttack?.({ fromId: localUserId, targetId: null, weapon: "frag", dmg, ranged: false, isGrenade: true, tx, tz });
        setMarker(tx, tz, 0xff8800, 0xcc5500);
        selectSlot(prevSlot !== 1 ? prevSlot : 2);
        return;
      }
      player.attackTarget = null;
      player.target = new THREE.Vector3(tx, 0, tz);
      if (settings.centerCamera) following = true;
      setMarker(tx, tz, theme.markerMove[0], theme.markerMove[1]);
    }
  }
  let isDown = false, dragging = false, sx = 0, sy = 0, lx = 0, ly = 0;
  const panRight = new THREE.Vector3(), panUp = new THREE.Vector3();
  const canvas = renderer.domElement;
  function _onPointerDown(e) { canvas.setPointerCapture(e.pointerId); isDown = true; dragging = false; sx = lx = e.clientX; sy = ly = e.clientY; }
  function _onPointerMove(e) {
    if (!isDown) return;
    if (settings.centerCamera) { lx = e.clientX; ly = e.clientY; return; }
    if (!dragging && Math.hypot(e.clientX - sx, e.clientY - sy) > 5) { dragging = true; following = false; }
    if (dragging) {
      const dx = e.clientX - lx, dy = e.clientY - ly;
      const wpp = (2 * FRUSTUM / size().h) / camera.zoom;
      panRight.setFromMatrixColumn(camera.matrixWorld, 0); panRight.y = 0; panRight.normalize();
      panUp.setFromMatrixColumn(camera.matrixWorld, 1); panUp.y = 0; panUp.normalize();
      camCenter.addScaledVector(panRight, -dx * wpp);
      camCenter.addScaledVector(panUp, dy * wpp);
    }
    lx = e.clientX; ly = e.clientY;
  }
  function _onPointerUp(e) { if (!isDown) return; isDown = false; if (!dragging) handleTap(e.clientX, e.clientY); }
  function _onWheel(e) {
    e.preventDefault();
    camera.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, camera.zoom * Math.exp(-e.deltaY * 0.0012)));
    camera.updateProjectionMatrix();
  }
  canvas.addEventListener("pointerdown", _onPointerDown);
  canvas.addEventListener("pointermove", _onPointerMove);
  canvas.addEventListener("pointerup", _onPointerUp);
  canvas.addEventListener("wheel", _onWheel, { passive: false });

  // -- HUD (attached reference set) -----------------------------------------
  const hud = buildHud();
  const { coords, mmCanvas, hotbar, slots, rivalsEl, fpsEl, pingEl, overlay, renderDistBtn, matchTimerEl, matchNoEl, raiderCountCtrl, raiderCountEl, scorePanel, weaponPanel, keysInfoPanel } = hud;

  // Top-right menu button: open the app's in-game menu (resume / how to play /
  // settings / leave) rather than jumping straight into settings — on touch
  // devices there is no Esc key, so this is the only way into that menu.
  hud.gearBtn.addEventListener("click", () => {
    if (options.onMenu) options.onMenu();
    else overlay.classList.add("show");
  });

  // Separate frag cooldown — never pollutes the active weapon's cdTimer
  let fragCd = 0;

  // Weapon stat pikes — normalised 0-100 against max values across all weapons
  const _wImg = { sword: "/sword.png", pistol: "/pistol.png", sniper: "/sniper.png", frag: "/frag.png" };
  const _wStats = {
    sword:  { pwr: 89, rng:  4, spd: 100, aoe:  0 },
    pistol: { pwr: 54, rng: 30, spd:  78, aoe:  0 },
    sniper: { pwr: 71, rng:100, spd:  32, aoe:  0 },
    frag:   { pwr: 79, rng: 38, spd:  20, aoe: 100 },
  };
  function renderWeaponPanel(w) {
    const s = _wStats[w.id] || _wStats.sword;
    const img = _wImg[w.id] || "";
    const bars = [
      { lbl: "PWR", pct: s.pwr },
      { lbl: "RNG", pct: s.rng },
      { lbl: "SPD", pct: s.spd },
      { lbl: "AOE", pct: s.aoe },
    ];
    weaponPanel.innerHTML =
      `<img src="${img}" class="wp-icon" alt="${w.name}" />` +
      `<div class="wp-name">${w.name.toUpperCase()}</div>` +
      `<div class="wp-stats">${bars.map((b) =>
        `<div class="wp-stat">` +
        `<div class="wp-bar-wrap"><div class="wp-bar" style="height:${Math.max(4, b.pct)}%"></div></div>` +
        `<div class="wp-lbl">${b.lbl}</div></div>`
      ).join("")}</div>`;
  }

  let activeSlot = 2, prevSlot = 2;
  function selectSlot(n) {
    if (n < 1 || n > 5) return;
    if (activeSlot !== n) prevSlot = activeSlot;
    activeSlot = n;
    slots.forEach((s) => s.classList.toggle("active", parseInt(s.dataset.slot, 10) === n));
    fragRing.visible = false;
    if (n === 1) { player.weapon = WEAPONS.frag;   player.attackTarget = null; player.chargeTimer = 0; updateWeaponVis(player); fragRing.visible = !player.dead; }
    else if (n === 2) { player.weapon = WEAPONS.sword;  player.chargeTimer = 0; updateWeaponVis(player); }
    else if (n === 3) { player.weapon = WEAPONS.pistol; player.attackTarget = null; player.chargeTimer = 0; updateWeaponVis(player); }
    else if (n === 4) { player.weapon = WEAPONS.sniper; player.attackTarget = null; player.chargeTimer = 0; updateWeaponVis(player); }
    renderWeaponPanel(player.weapon);
  }
  slots.forEach((s) => s.addEventListener("click", () => selectSlot(parseInt(s.dataset.slot, 10))));
  function _onKeyDown(e) {
    if (e.key === "w" || e.key === "W") { wasd.w = true; e.preventDefault(); }
    if (e.key === "a" || e.key === "A") { wasd.a = true; }
    if (e.key === "s" || e.key === "S") { wasd.s = true; e.preventDefault(); }
    if (e.key === "d" || e.key === "D") { wasd.d = true; }
    if (e.key >= "1" && e.key <= "5") selectSlot(parseInt(e.key, 10));
    if (e.key === "Tab") {
      e.preventDefault();
      const all = [player, ...foeList()];
      scorePanel.innerHTML = '<div class="sp-title">SCOREBOARD</div>' +
        all.filter((f) => f.connected).map((f) => {
          const pct = Math.round(Math.max(0, f.hp) / f.maxHp * 100);
          const barCol = f === player ? "#33b14a" : "#e0473c";
          return `<div class="sp-row">
            <span class="sp-name">${escapeHtml(f.name || "Player")}</span>
            <div class="sp-bar-wrap"><div class="sp-bar" style="width:${pct}%;background:${barCol}"></div></div>
            <span class="sp-hp">${Math.max(0, f.hp)}/${f.maxHp}</span>
          </div>`;
        }).join('');
      scorePanel.classList.remove("hidden");
    }
  }
  function _onKeyUp(e) {
    if (e.key === "Tab") scorePanel.classList.add("hidden");
    if (e.key === "w" || e.key === "W") wasd.w = false;
    if (e.key === "a" || e.key === "A") wasd.a = false;
    if (e.key === "s" || e.key === "S") wasd.s = false;
    if (e.key === "d" || e.key === "D") wasd.d = false;
  }
  window.addEventListener("keydown", _onKeyDown);
  window.addEventListener("keyup", _onKeyUp);
  // Reset movement keys on blur so held keys don't keep the player moving after alt-tab.
  function _onBlur() { wasd.w = false; wasd.a = false; wasd.s = false; wasd.d = false; }
  window.addEventListener("blur", _onBlur);

  // Settings
  const settings = { renderDistance: "Far", fog: false, msaa: true, animations: true, centerCamera: false, hideHud: false, fps: true, ping: true, location: false };
  function applyFog() {
    if (settings.fog) { const r = RD_FOG[settings.renderDistance]; scene.fog = new THREE.Fog(theme.bg, r[0], r[1]); }
    else scene.fog = null;
  }
  function applyMsaa() { renderer.setPixelRatio(settings.msaa ? Math.min(window.devicePixelRatio, 2) : 1); }
  function refreshHud() {
    document.body.classList.toggle("hud-hidden", settings.hideHud);
    fpsEl.style.display = settings.fps && !settings.hideHud ? "block" : "none";
    pingEl.style.display = settings.ping && !settings.hideHud ? "block" : "none";
    coords.style.display = settings.location && !settings.hideHud ? "block" : "none";
  }
  hud.bindSettings({ settings, applyFog, applyMsaa, refreshHud, onCenter: () => { if (settings.centerCamera) following = true; } });
  applyFog(); applyMsaa(); refreshHud();

  // Raider count control (demo only)
  raiderCountCtrl.querySelector(".rc-minus").addEventListener("click", () => {
    const next = Math.max(1, aiRaiders.length - 1);
    while (aiRaiders.length < next) aiRaiders.push(makeAiRaider(aiRaiders.length));
    while (aiRaiders.length > next) disposeAiRaider(aiRaiders.pop());
    raiderCountEl.textContent = next;
  });
  raiderCountCtrl.querySelector(".rc-plus").addEventListener("click", () => {
    const next = Math.min(10, aiRaiders.length + 1);
    while (aiRaiders.length < next) aiRaiders.push(makeAiRaider(aiRaiders.length));
    while (aiRaiders.length > next) disposeAiRaider(aiRaiders.pop());
    raiderCountEl.textContent = next;
  });
  renderDistBtn.textContent = settings.renderDistance;

  // Minimap
  const MM = 160;
  const mmDpr = Math.min(window.devicePixelRatio, 2);
  mmCanvas.width = MM * mmDpr; mmCanvas.height = MM * mmDpr;
  const mmCtx = mmCanvas.getContext("2d");
  mmCtx.scale(mmDpr, mmDpr);
  const mmScale = MM / MAP_WORLD;
  const wToMM = (w) => (w + MAP_HALF) * mmScale;

  // Offscreen canvas for static minimap elements (grid, river, solids, border).
  // Rebuilt after generateMap() or applyTheme(); composited each frame.
  const mmStatic = document.createElement("canvas");
  mmStatic.width = MM * mmDpr; mmStatic.height = MM * mmDpr;
  const mmSCtx = mmStatic.getContext("2d");
  mmSCtx.scale(mmDpr, mmDpr);

  function buildMinimapStatic() {
    mmSCtx.clearRect(0, 0, MM, MM);
    mmSCtx.strokeStyle = theme.mm.grid; mmSCtx.lineWidth = 1;
    for (let g = -MAP_HALF; g <= MAP_HALF + 0.01; g += TILE * 5) {
      const p = wToMM(g);
      mmSCtx.beginPath(); mmSCtx.moveTo(p, 0); mmSCtx.lineTo(p, MM); mmSCtx.stroke();
      mmSCtx.beginPath(); mmSCtx.moveTo(0, p); mmSCtx.lineTo(MM, p); mmSCtx.stroke();
    }
    if (riverSegments.length > 1) {
      // Pixelated river — sample the polyline and stamp grid-snapped squares
      const CELL   = 5;   // minimap pixels per block (matches screenshot style)
      const hwSnap = Math.ceil(riverHalfW * mmScale / CELL) * CELL;
      mmSCtx.fillStyle = "rgba(61,127,176,0.62)";
      const seen = new Set();
      for (let i = 0; i < riverSegments.length - 1; i++) {
        const a = riverSegments[i], b = riverSegments[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const steps = Math.ceil(Math.hypot(dx, dz) / 0.8);
        for (let s = 0; s <= steps; s++) {
          const t  = s / steps;
          const mx = Math.round(wToMM(a.x + dx * t) / CELL) * CELL;
          const mz = Math.round(wToMM(a.z + dz * t) / CELL) * CELL;
          const key = `${mx},${mz}`;
          if (seen.has(key)) continue;
          seen.add(key);
          mmSCtx.fillRect(mx - hwSnap, mz - hwSnap, hwSnap * 2, hwSnap * 2);
        }
      }
    }
    mmSCtx.fillStyle = "rgba(40,46,40,0.7)";
    for (const s of solids) {
      mmSCtx.fillRect(wToMM(s.x) - 1.5, wToMM(s.z) - 1.5, 3, 3);
    }
    mmSCtx.strokeStyle = theme.mm.border; mmSCtx.lineWidth = 1.5;
    mmSCtx.strokeRect(0.75, 0.75, MM - 1.5, MM - 1.5);
  }
  buildMinimapStatic();

  function arrow(ctx, x, y, ry, color) {
    const hx = Math.sin(ry), hy = Math.cos(ry), px = -hy, py = hx;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x + hx * 6, y + hy * 6);
    ctx.lineTo(x - hx * 4 + px * 3.5, y - hy * 4 + py * 3.5);
    ctx.lineTo(x - hx * 4 - px * 3.5, y - hy * 4 - py * 3.5);
    ctx.closePath();
    ctx.fill();
  }
  function drawMinimap() {
    mmCtx.clearRect(0, 0, MM, MM);
    mmCtx.drawImage(mmStatic, 0, 0, MM, MM);
    mmCtx.strokeStyle = theme.mm.cam; mmCtx.lineWidth = 1;
    mmCtx.strokeRect(wToMM(camCenter.x) - 9, wToMM(camCenter.z) - 9, 18, 18);
    mmCtx.fillStyle = theme.mm.enemy;
    for (const f of foeList()) {
      if (!f.connected || f.dead) continue;
      mmCtx.beginPath();
      mmCtx.arc(wToMM(f.group.position.x), wToMM(f.group.position.z), 3.5, 0, Math.PI * 2);
      mmCtx.fill();
    }
    if (player.connected && !player.dead) arrow(mmCtx, wToMM(player.group.position.x), wToMM(player.group.position.z), player.group.rotation.y, theme.mm.player);
  }

  // Attack cursor
  let cursorAttack = false;
  function cursorUrl() {
    return "url(\"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='32'%20height='32'%20viewBox='0%200%2032%2032'%3E%3Cg%20fill='none'%20stroke='" + theme.cursor + "'%20stroke-width='2.5'%20stroke-linecap='round'%3E%3Ccircle%20cx='16'%20cy='16'%20r='8'/%3E%3Cpath%20d='M16%202v5M16%2025v5M2%2016h5M25%2016h5'/%3E%3C/g%3E%3C/svg%3E\") 16 16, crosshair";
  }
  function setCursor(on) {
    if (on === cursorAttack) return;
    cursorAttack = on;
    canvas.style.cursor = on ? cursorUrl() : "default";
  }

  // -- Theme switch ---------------------------------------------------------
  let currentMapVariant = "game"; // "game" | "golden"

  function applyTheme(name) {
    theme = THEMES[name] || THEMES.lobby;
    renderer.setClearColor(theme.bg, 1);
    scene.background = new THREE.Color(theme.bg);
    applyFog();
    if (name === "game") makeFight10Decal();
    const newTex = makeGroundTex(theme.ground);
    ground.material.map.dispose();
    ground.material.map = newTex;
    ground.material.needsUpdate = true;
    buildGrid();
    border.material.color.setHex(theme.border);
    if ("game" !== currentMapVariant) {
      currentMapVariant = "game";
      buildArenaWalls("game");
    }
    recolorFighter(player, theme.player);
    player.bar.color = theme.playerBar;
    aiRaiders.forEach((r) => { recolorFighter(r, theme.enemy); r.bar.color = theme.enemyBar; });
    opponents.forEach((o) => { recolorFighter(o, theme.enemy); o.bar.color = theme.enemyBar; });
    cursorAttack = !cursorAttack; setCursor(false);
    buildMinimapStatic();
  }

  // Home / lobby background: dress the idle arena with the full map — river,
  // trees, snow peaks, corner towers — plus the FIGHT10 ground mark, so the
  // landing page shows the real arena instead of an empty grid.
  function idleArena() {
    generateMap("home-showcase");
    makeFight10Decal();
    buildMinimapStatic();
  }

  // -- Resize ---------------------------------------------------------------
  function onResize() {
    dim = size();
    aspect = dim.w / dim.h;
    camera.left = -FRUSTUM * aspect; camera.right = FRUSTUM * aspect;
    camera.top = FRUSTUM; camera.bottom = -FRUSTUM;
    camera.updateProjectionMatrix();
    renderer.setSize(dim.w, dim.h, false);
  }
  const ro = new ResizeObserver(onResize);
  ro.observe(mount);
  onResize();

  // Opponents start at random free spots (placeholders; their real positions
  // arrive over the network and snap into place on the first packet).
  function placeOpponents() {
    opponents.forEach((o) => {
      // Use per-seat seeded RNG when available so all clients agree on positions.
      const rng = o.spawnSeed ? makeRng(o.spawnSeed) : null;
      const sp = randomSpawn(rng);
      o.group.position.set(sp.x, 0, sp.z);
      o.netTarget = { x: sp.x, z: sp.z };
      o.group.rotation.set(0, o.group.rotation.y, 0);
    });
  }

  // -- Result detection -----------------------------------------------------
  function buildStandings() {
    const list = [{ name: player.name, hp: Math.max(0, player.dead ? 0 : player.hp), me: true }];
    if (foeMode === "ai") {
      aiRaiders.forEach((r) => { if (r.connected) list.push({ name: r.name, hp: Math.max(0, r.dead ? 0 : r.hp), me: false }); });
    } else {
      opponents.forEach((o) => { if (o.connected) list.push({ name: o.name, hp: Math.max(0, o.dead ? 0 : o.hp), me: false }); });
    }
    list.sort((a, b) => b.hp - a.hp);
    return list.map((f, i) => ({ rank: i + 1, ...f }));
  }
  function checkResult() {
    if (foeMode !== "net" || matchPhase !== "active" || resultSent) return;
    if (player.hp <= 0) {
      resultSent = true;
      controllable = false; // stop all input immediately
      options.onResultSuggestion?.("loss", buildStandings());
      return;
    }
    if (opponents.size === 0) return; // no rivals yet
    let anyAlive = false;
    opponents.forEach((o) => { if (o.connected && !o.dead) anyAlive = true; });
    if (!anyAlive && player.hp > 0) {
      resultSent = true;
      controllable = false; // stop all input immediately
      options.onResultSuggestion?.("win", buildStandings());
    }
  }

  // -- Match timer ----------------------------------------------------------
  // Wall-clock based: the countdown is derived from an absolute end timestamp
  // (matchEndsAt) every tick, not by accumulating per-frame dt. This keeps it
  // correct across tab-switches (requestAnimationFrame pauses while a tab is
  // hidden and dt is clamped, which would otherwise freeze/desync the timer).
  let matchEndsAt = 0;   // epoch ms when the match ends
  let matchTimerOn = false;
  function fmtTime(s) {
    s = Math.max(0, Math.ceil(s));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  function matchSecsLeft() {
    return matchTimerOn ? Math.max(0, (matchEndsAt - Date.now()) / 1000) : 0;
  }
  function showTimer() {
    matchTimerEl.style.display = matchTimerOn && viewIsGame ? "block" : "none";
  }
  // Friendly sequential match number (matches.match_no), shown under the timer
  // so players can reference the match in support requests / history.
  let matchNumber = null;
  function showMatchNo() {
    matchNoEl.textContent = matchNumber ? `MATCH #${matchNumber}` : "";
    matchNoEl.style.display = matchNumber && viewIsGame ? "block" : "none";
  }
  function tickTimer() {
    if (!matchTimerOn || resultSent || matchPhase !== "active") return;
    const left = matchSecsLeft();
    matchTimerEl.textContent = fmtTime(left);
    matchTimerEl.classList.toggle("low", left <= 30);
    if (left <= 0) { matchTimerOn = false; resolveByHp(); }
  }
  // Fallback tick independent of requestAnimationFrame so the match still ends
  // (and the player still reports) if the tab is backgrounded at 0:00. Browsers
  // throttle setInterval to ~1s in background but, unlike rAF, keep firing it.
  const _timerFallback = setInterval(tickTimer, 1000);
  // Time's up: highest HP among the survivors wins (tie-break by id).
  function resolveByHp() {
    if (resultSent) return;
    resultSent = true;
    controllable = false;
    const field = [{ id: localUserId ?? "", hp: player.dead ? -1 : player.hp, me: true, name: player.name }];
    opponents.forEach((o) => field.push({ id: o.userId, hp: o.dead ? -1 : o.hp, me: false, name: o.name }));
    field.sort((a, b) => b.hp - a.hp || (a.id < b.id ? -1 : 1));
    const standings = field.map((f, i) => ({ rank: i + 1, name: f.name, hp: Math.max(0, f.hp), me: f.me }));
    options.onResultSuggestion?.(field[0].me ? "win" : "loss", standings);
  }

  // -- Loop -----------------------------------------------------------------
  let destroyed = false;
  let fpsAcc = 0, fpsFrames = 0;
  let fpsLastTime = performance.now();
  const clock = new THREE.Clock();
  function animate() {
    if (destroyed) return;
    _foeCache = null; // invalidate per-frame foeList() cache
    const dt = Math.min(clock.getDelta(), 0.05);

    updatePlayer(dt);
    if (foeMode === "ai") updateAi(dt);
    else opponents.forEach((o) => updateNetFoe(o, dt));

    if (settings.animations) {
      updateVisual(player, dt);
      foeList().forEach((f) => updateVisual(f, dt));
    } else {
      player.group.rotation.y = player.facing;
      foeList().forEach((f) => { f.group.rotation.y = f.facing; });
    }
    updateBullets(dt);
    updateGrenades(dt);
    updateExplosions(dt);

    // Tick frag's independent cooldown
    if (fragCd > 0) fragCd = Math.max(0, fragCd - dt);

    // Cooldown swirl — slot 1 uses fragCd, active slot uses player.cdTimer
    slots.forEach((s, i) => {
      const cd = s.querySelector(".slot-cd");
      if (!cd) return;
      if (i === 0) {
        cd.style.setProperty("--cd", Math.min(1, Math.max(0, fragCd / WEAPONS.frag.cd)));
      } else {
        const isActive = i === activeSlot - 1;
        const frac = (isActive && player.weapon && player.weapon.cd > 0)
          ? Math.min(1, Math.max(0, player.cdTimer / player.weapon.cd))
          : 0;
        cd.style.setProperty("--cd", frac);
      }
    });

    if (perspective === "player") {
      emitAcc += dt * 1000;
      if (emitAcc >= EMIT_MS) emitState();
      checkResult();
      tickTimer();
    }

    if (settings.centerCamera) following = true;
    if (following) {
      const k = 1 - Math.pow(0.0016, dt);
      camCenter.x += (player.group.position.x - camCenter.x) * k;
      camCenter.z += (player.group.position.z - camCenter.z) * k;
    }
    camCenter.x = Math.max(-MAP_HALF, Math.min(MAP_HALF, camCenter.x));
    camCenter.z = Math.max(-MAP_HALF, Math.min(MAP_HALF, camCenter.z));
    camera.position.set(camCenter.x + CAM_OFFSET.x, CAM_OFFSET.y, camCenter.z + CAM_OFFSET.z);
    camera.lookAt(camCenter.x, 1, camCenter.z);
    sun.position.copy(player.group.position).add(_sunOffset);
    sun.target.position.copy(player.group.position);

    const sp = snowGeo.attributes.position.array, t = clock.elapsedTime;
    for (let i = 0; i < SNOW_COUNT; i++) {
      sp[i * 3 + 1] -= snowVel[i] * dt;
      sp[i * 3] += Math.sin(snowPhase[i] + t * 1.4) * dt * 0.4;
      if (sp[i * 3 + 1] < 0) { sp[i * 3 + 1] = SNOW_TOP; sp[i * 3] = (Math.random() - 0.5) * SNOW_AREA; sp[i * 3 + 2] = (Math.random() - 0.5) * SNOW_AREA; }
    }
    snowGeo.attributes.position.needsUpdate = true;
    snow.position.set(camCenter.x, 0, camCenter.z);

    if (markerLife > 0) {
      markerLife = Math.max(0, markerLife - dt * 1.4);
      markerFill.material.opacity = markerLife * 0.26;
      markerEdge.material.opacity = markerLife * 0.95;
      const s = 1 + (1 - markerLife) * 0.3;
      marker.scale.set(s, s, 1);
    }

    player.group.visible = player.connected;
    aiRaiders.forEach((r) => { r.group.visible = foeMode === "ai" && r.connected; });
    opponents.forEach((o) => { o.group.visible = foeMode === "net" && o.connected; });
    updateBar(player);
    aiRaiders.forEach((r) => updateBar(r));
    opponents.forEach((o) => updateBar(o));
    setCursor(controllable && !player.dead && ((player.attackTarget && !player.attackTarget.dead) || player.atkAnim > 0));

    if (settings.fps) {
      fpsFrames++;
      const now = performance.now();
      const elapsed = now - fpsLastTime;
      if (elapsed >= 500) {
        const fps = Math.round(fpsFrames / (elapsed / 1000));
        fpsEl.textContent = "FPS " + fps;
        fpsEl.style.color = fps >= 50 ? "#6fcf6f" : fps >= 30 ? "#f0c040" : "#e04040";
        fpsFrames = 0;
        fpsLastTime = now;
      }
    }
    const aliveRivals = foeList().filter((f) => f.connected && !f.dead).length;
    rivalsEl.textContent = foeMode === "net" ? `RAIDERS ${aliveRivals}` : `RAIDERS ${aliveRivals} · KILLS ${kills}`;
    coords.textContent = `x ${player.group.position.x.toFixed(1)} · z ${player.group.position.z.toFixed(1)} · ${foeMode === "net" ? `rivals ${aliveRivals}` : `kills ${kills}`}`;

    // Frag range ring — follow player, pulse opacity
    if (fragRing.visible) {
      fragRing.position.x = player.group.position.x;
      fragRing.position.z = player.group.position.z;
      fragRing.material.opacity = 0.35 + 0.25 * Math.abs(Math.sin(clock.elapsedTime * 2.8));
    }

    // Edge flame lamps — cheap two-sine flicker, per-lamp phase offset
    for (const L of edgeLamps) {
      const f = 0.82 + 0.18 * (0.6 * Math.sin(t * 8 + L.phase) + 0.4 * Math.sin(t * 21 + L.phase * 2.3));
      L.sprite.material.opacity = f;
      L.sprite.scale.set(1.0 + 0.25 * f, 1.45 + 0.45 * f, 1);
      L.glow.material.opacity = 0.6 * f;
    }

    // River fish — glide along the curve, drift across lanes, wiggle the nose
    for (const F of riverFish) {
      F.dist += F.speed * dt;
      const p = F.posAt(F.dist);
      const sgn = F.speed < 0 ? -1 : 1;
      const lat = Math.sin(t * 0.5 + F.latPhase) * F.lat;
      F.g.position.x = p.x - p.dirz * lat;
      F.g.position.z = p.z + p.dirx * lat;
      F.g.rotation.y = Math.atan2(-p.dirz * sgn, p.dirx * sgn) + Math.sin(t * 7 + F.wigglePhase) * 0.18;
    }

    drawMinimap();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
  idleArena(); // populate the home/landing background on first load

  // -- Public API -----------------------------------------------------------
  return {
    setView(view) {
      viewIsGame = view === "game";
      document.body.classList.toggle("in-game", viewIsGame);
      applyTheme(viewIsGame ? "game" : "lobby");
      if (!viewIsGame) idleArena(); // returning to the lobby restores the showcase arena
      showTimer();
      showMatchNo();
      if (viewIsGame) { renderWeaponPanel(player.weapon); }
    },
    // Friendly match number for the HUD (null hides it, e.g. demo mode).
    setMatchNumber(n) {
      matchNumber = n || null;
      showMatchNo();
    },
    setMode(mode) {
      perspective = mode;
      controllable = mode === "player";
    },
    setMapVariant(_variant) { applyTheme("game"); },
    showMapToggle(_on) {},
    showRaiderCount(on) { raiderCountCtrl.classList.toggle("hidden", !on); },
    setAiCount(n) {
      const target = Math.max(1, Math.min(10, n));
      while (aiRaiders.length < target) aiRaiders.push(makeAiRaider(aiRaiders.length));
      while (aiRaiders.length > target) disposeAiRaider(aiRaiders.pop());
      raiderCountEl.textContent = target;
    },
    setMatchPhase(phase) { matchPhase = phase; },
    setControllable(on) { controllable = !!on; },
    // endsAtMs anchors the countdown to an absolute wall-clock time (ideally the
    // server's started_at + duration) so it matches the settlement deadline and
    // survives tab-switching. Falls back to now + seconds if not provided.
    setMatchTimer(seconds, endsAtMs) {
      matchEndsAt = endsAtMs || (Date.now() + (seconds || 0) * 1000);
      matchTimerOn = matchEndsAt > Date.now();
      matchTimerEl.textContent = fmtTime(matchSecsLeft());
      matchTimerEl.classList.remove("low");
      showTimer();
    },
    playerAlive() { return !player.dead && player.hp > 0; },
    // Local player's genuine current HP (0 if dead). Used to report a final HP to
    // the server on demand when a peer signals the match is over.
    currentHp() { return player.dead ? 0 : Math.max(0, Math.round(player.hp)); },
    standings() { return buildStandings(); },
    setLocalUser({ userId, displayName, level }) {
      perspective = "player";
      // Do not touch controllable here — callers call setControllable() explicitly
      // after this so they can disable input during countdown without a race.
      localUserId = userId || null;
      player.name = displayName || "You";
      if (typeof level === "number") player.level = level;
      player.connected = true;
    },
    // Demo: single AI raider.
    useAiFoe() {
      foeMode = "ai";
      clearOpponents();
      // Keep only the first raider; extras cleared when count is set
      while (aiRaiders.length > 1) disposeAiRaider(aiRaiders.pop());
      aiEnemy.networked = false;
      aiEnemy.connected = true;
      aiEnemy.name = "Raider";
      aiEnemy.weapon = randomAiWeapon();
      updateWeaponVis(aiEnemy);
    },
    // PvP: switch to networked opponents.
    usePvpFoes() {
      foeMode = "net";
      aiEnemy.connected = false;
    },
    addOpponent({ userId, displayName, seat, matchId }) {
      if (!userId || opponents.has(userId)) {
        const ex = opponents.get(userId);
        if (ex && displayName) ex.name = displayName;
        return;
      }
      const f = makeFighter({
        userId, name: displayName || "Rival", palette: theme.enemy,
        pos: new THREE.Vector3(0, 0, 0), hp: 100, weapon: WEAPONS.sword, speed: 6.5, barColor: theme.enemyBar
      });
      f.networked = true;
      f.connected = true;
      // Deterministic spawn: same seed → same position on every client.
      f.spawnSeed = (matchId && seat != null) ? `${matchId}-spawn-${seat}` : null;
      opponents.set(userId, f);
      const rng = f.spawnSeed ? makeRng(f.spawnSeed) : null;
      const sp = randomSpawn(rng);
      f.group.position.set(sp.x, 0, sp.z);
      f.netTarget = { x: sp.x, z: sp.z };
    },
    removeOpponent(userId) {
      const f = opponents.get(userId);
      if (!f) return opponents.size;
      if (player.attackTarget === f) player.attackTarget = null;
      disposeFighter(f);
      opponents.delete(userId);
      return opponents.size;
    },
    clearRemote() { clearOpponents(); },
    resetForMatch(matchId, localSeat) {
      resultSent = false;
      matchTimerOn = false; showTimer();
      // Clear leftover projectiles from a previous match. Bullets are Groups
      // (the old per-mesh dispose calls hit the group, which has no
      // geometry/material, and leaked the children) — and in-flight grenades /
      // explosion flashes were never cleared at all.
      bullets.splice(0).forEach((b) => { scene.remove(b.mesh); disposeObject3D(b.mesh); });
      grenades.splice(0).forEach((g) => { scene.remove(g.mesh); disposeObject3D(g.mesh); });
      explosions.splice(0).forEach((ex) => { scene.remove(ex.mesh); disposeObject3D(ex.mesh); });
      Object.assign(player, { hp: player.maxHp, dead: false, cdTimer: 0, atkAnim: 0, hurt: 0, moving: false, attackTarget: null, target: null, chargeTimer: 0 });
      player.group.rotation.set(0, player.group.rotation.y, 0);
      const spawnSeed = (matchId && localSeat != null) ? `${matchId}-spawn-${localSeat}` : null;
      const ps = randomSpawn(spawnSeed ? makeRng(spawnSeed) : null);
      player.group.position.set(ps.x, 0, ps.z);
      player.connected = true;
      if (foeMode === "ai") {
        aiRaiders.forEach((r) => {
          Object.assign(r, { hp: r.maxHp, dead: false, cdTimer: 0, atkAnim: 0, hurt: 0, moving: false });
          r.group.rotation.set(0, r.group.rotation.y, 0);
          const es = randomSpawn();
          r.group.position.set(es.x, 0, es.z);
          r.netTarget = { x: es.x, z: es.z };
          r.connected = true;
        });
      } else {
        opponents.forEach((o) => {
          Object.assign(o, { hp: o.maxHp, dead: false, cdTimer: 0, atkAnim: 0, hurt: 0, moving: false });
        });
        placeOpponents();
      }
      camCenter.set(ps.x, 0, ps.z);
      following = true;
      // Start every match fully zoomed out; the player can scroll in from there.
      camera.zoom = ZOOM_MIN;
      camera.updateProjectionMatrix();
    },
    receivePlayerState(userId, snap) {
      if (!snap || foeMode !== "net") return;
      const f = opponents.get(userId);
      if (!f) return;
      f.connected = true;
      f.netTarget = { x: clamp(snap.x, -MAP_HALF, MAP_HALF), z: clamp(snap.z, -MAP_HALF, MAP_HALF) };
      // maxHp is fixed at fighter creation — never trust the network for it.
      // HP only drops within a match (no respawns). Take the lower of our
      // optimistic value and their authoritative report to avoid bounce-back.
      const snapHp = clamp(snap.hp ?? f.hp, 0, f.maxHp);
      const prevHp = f.hp;
      f.hp = Math.min(f.hp, snapHp);
      if (typeof snap.facing === "number") f.facing = snap.facing;
      if (snap.weapon && WEAPONS[snap.weapon]) { f.weapon = WEAPONS[snap.weapon]; updateWeaponVis(f); }
      if (snap.name) f.name = snap.name;
      if (typeof snap.level === "number") f.level = snap.level;
      // State packets may only confirm a death that attack events already drove near-zero.
      // Threshold = 5 HP (lowest weapon min-damage is 1, so ≤5 means 1–5 hits away).
      // This blocks a spoofed jump from full health to 0; real deaths come via
      // receiveAttack → applyDamage → killFighter with per-weapon damage capping.
      if (f.hp <= 0 && !f.dead && prevHp <= 5) killFighter(f);
    },
    receiveAttack(payload) {
      if (!payload || foeMode !== "net") return;
      const attacker = payload.fromId ? opponents.get(payload.fromId) : null;
      // Clamp to the attacker's known weapon cap; fall back to the global max
      // only when the sender is unknown so a cheating client can't send sniper
      // damage while holding a sword.
      const weaponCap = attacker?.weapon
        ? attacker.weapon.atk + attacker.weapon.atkVar
        : Math.max(...Object.values(WEAPONS).map((w) => w.atk + w.atkVar));
      const dmg = Math.min(Math.max(0, payload.dmg || 0), weaponCap);

      // Coarse plausibility net for a KNOWN attacker: drop events that arrive
      // faster than the weapon's cooldown allows or hit from beyond its reach.
      // Thresholds are deliberately loose (network jitter compresses arrival
      // times; positions are interpolated) — this blocks the blatant hacks
      // (cross-map melee, machine-gun sniper) from wrecking the live match,
      // while the money is protected by the server's settlement caps anyway.
      // The declared weapon is considered alongside the snapshot weapon so a
      // legit attack right after a weapon switch (snapshot still in flight)
      // isn't dropped; a false declaration can only widen these sanity bounds,
      // never the damage cap above.
      if (attacker) {
        const declared = WEAPONS[payload.weapon];
        const w = payload.isGrenade ? WEAPONS.frag : (attacker.weapon || declared || WEAPONS.sword);
        const cdMs = Math.min(w.cd, declared?.cd ?? w.cd) * 600; // 40% jitter slack
        const nowMs = performance.now();
        const lastKey = payload.isGrenade ? "lastFragAt" : "lastAtkAt";
        if (attacker[lastKey] && nowMs - attacker[lastKey] < cdMs) return;
        const reach = Math.max(w.range, declared?.range ?? 0) * 1.5 + 4;
        const ix = payload.isGrenade && typeof payload.tx === "number" ? payload.tx
          : (payload.targetId === localUserId ? player.group.position.x
             : opponents.get(payload.targetId)?.group.position.x);
        const iz = payload.isGrenade && typeof payload.tz === "number" ? payload.tz
          : (payload.targetId === localUserId ? player.group.position.z
             : opponents.get(payload.targetId)?.group.position.z);
        if (typeof ix === "number" && typeof iz === "number") {
          const d = Math.hypot(ix - attacker.group.position.x, iz - attacker.group.position.z);
          if (d > reach) return;
        }
        attacker[lastKey] = nowMs;
      }

      if (payload.isGrenade && attacker) {
        const tx = typeof payload.tx === "number" ? payload.tx : attacker.group.position.x;
        const tz = typeof payload.tz === "number" ? payload.tz : attacker.group.position.z;
        attacker.atkAnim = 0.32;
        fireGrenade(attacker, tx, tz, dmg);
        return;
      }
      if (payload.targetId === localUserId) {
        if (player.dead) return;
        if (attacker) attacker.atkAnim = 0.32;
        if (payload.ranged && attacker) fireBullet(attacker, player, dmg, true, attacker.weapon);
        else applyDamage(player, dmg);
      } else {
        const target = opponents.get(payload.targetId);
        if (!target || target.dead) return;
        if (attacker) attacker.atkAnim = 0.32;
        if (payload.ranged && attacker) fireBullet(attacker, target, dmg, true, attacker.weapon);
        else applyDamage(target, dmg);
      }
    },
    generateMap(seed) { generateMap(seed); buildMinimapStatic(); },
    clearAll() {
      perspective = "offline";
      controllable = false;
      foeMode = "ai";
      clearOpponents();
      clearMap();
      // Trim extra AI raiders back to 1
      while (aiRaiders.length > 1) disposeAiRaider(aiRaiders.pop());
      aiEnemy.networked = false;
      aiEnemy.connected = false;
      aiEnemy.name = "Raider";
      player.connected = false;
      matchTimerOn = false; showTimer();
      matchNumber = null; showMatchNo();
      viewIsGame = false;
      document.body.classList.remove("in-game");
      applyTheme("lobby");
      idleArena(); // restore the populated showcase arena behind the home page
    },
    setPing(ms) {
      if (!pingEl) return;
      if (ms == null) { pingEl.textContent = "-- ms"; pingEl.style.color = ""; return; }
      pingEl.textContent = ms + " ms";
      pingEl.style.color = ms < 80 ? "#6fcf6f" : ms < 160 ? "#f0c040" : "#e04040";
    },
    openSettings() { overlay.classList.add("show"); },
    destroy() {
      destroyed = true;
      clearInterval(_timerFallback);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", _onPointerDown);
      canvas.removeEventListener("pointermove", _onPointerMove);
      canvas.removeEventListener("pointerup", _onPointerUp);
      canvas.removeEventListener("wheel", _onWheel);
      window.removeEventListener("keydown", _onKeyDown);
      window.removeEventListener("keyup", _onKeyUp);
      window.removeEventListener("blur", _onBlur);
      player.bar.el.remove();
      aiRaiders.forEach((r) => r.bar.el.remove());
      clearOpponents();
      hud.root.remove();
      // Release everything still attached to the scene (ground + its canvas
      // texture, walls, snow, map objects, fighters, projectiles) before
      // dropping the GL context.
      disposeObject3D(scene);
      renderer.dispose();
      mount.innerHTML = "";
    }
  };

  function clearOpponents() {
    opponents.forEach((f) => disposeFighter(f));
    opponents.clear();
  }
}

// Builds the attached reference HUD (hint, coords, minimap+label, hotbar,
// gear+settings, fps, ping). Everything is tagged .game-ui so CSS only shows it
// while body.in-game is set.
function buildHud() {
  const root = document.createElement("div");
  root.className = "game-hud-root";
  document.body.appendChild(root);
  const add = (html) => {
    const tpl = document.createElement("template");
    tpl.innerHTML = html.trim();
    const el = tpl.content.firstChild;
    root.appendChild(el);
    return el;
  };

  const hint = add('<div class="hint game-ui"><span class="key">wasd</span> move &middot; <span class="key">click</span> move &middot; <span class="key">click rival</span> attack &middot; <span class="key">drag</span> pan &middot; <span class="key">scroll</span> zoom &middot; <span class="key">Esc</span> leave</div>');
  const matchTimerEl = add('<div class="match-timer game-ui">0:00</div>');
  const matchNoEl = add('<div class="match-no game-ui"></div>');
  const coords = add('<div class="coords game-ui">x 0.0 &middot; z 0.0</div>');
  add('<div class="mm-label game-ui">map</div>');
  const mmCanvas = add('<canvas class="game-minimap game-ui"></canvas>');
  const hotbar = add('<div class="hotbar game-ui"></div>');
  // Slots 1-4 only: 1=frag, 2=sword, 3=pistol, 4=sniper. No slot 5 (nothing assigned).
  for (let n = 1; n <= 4; n++) {
    const imgSrc = n === 1 ? "/frag.png" : n === 2 ? "/sword.png" : n === 3 ? "/pistol.png" : "/sniper.png";
    const s = document.createElement("div");
    s.className = "slot" + (n === 2 ? " active" : ""); // start on sword
    s.dataset.slot = String(n);
    s.innerHTML = `<img src="${imgSrc}" class="slot-icon" alt="" /><span class="num">${n}</span><div class="slot-cd"></div>`;
    hotbar.appendChild(s);
  }
  const slots = Array.from(hotbar.querySelectorAll(".slot"));
  const raiderCountCtrl = add('<div class="raider-count-ctrl game-ui hidden"><button class="rc-btn rc-minus">−</button><span class="rc-label"><span class="rc-num">1</span> Raiders</span><button class="rc-btn rc-plus">+</button></div>');
  const raiderCountEl = raiderCountCtrl.querySelector(".rc-num");
  const scorePanel = add('<div class="score-panel game-ui hidden"></div>');
  const weaponPanel = add('<div class="wpanel game-ui"></div>');
  const keysInfoPanel = add(`<div class="keys-info-panel game-ui hidden">
    <div class="ki-title">CONTROLS</div>
    <div class="ki-row"><span class="ki-key">Click</span><span class="ki-desc">Move / Attack</span></div>
    <div class="ki-row"><span class="ki-key">Drag</span><span class="ki-desc">Pan camera</span></div>
    <div class="ki-row"><span class="ki-key">Scroll</span><span class="ki-desc">Zoom</span></div>
    <div class="ki-row"><span class="ki-key">WASD</span><span class="ki-desc">Move</span></div>
    <div class="ki-row"><span class="ki-key">1–4</span><span class="ki-desc">Select weapon</span></div>
    <div class="ki-row"><span class="ki-key">Tab</span><span class="ki-desc">Scoreboard</span></div>
    <div class="ki-row"><span class="ki-key">Esc</span><span class="ki-desc">Leave match</span></div>
    <div class="ki-row"><span class="ki-key">Frag ring</span><span class="ki-desc">Throw range</span></div>
  </div>`);
  add('<button class="gear game-ui" title="Menu">&#9776;</button>');
  const gearBtn = root.querySelector(".gear");
  const rivalsEl = add('<div class="game-rivals game-ui">--</div>');
  const fpsEl = add('<div class="game-fps game-ui">FPS --</div>');
  const pingEl = add('<div class="game-ping game-ui">-- ms</div>');
  const overlay = add(`
    <div class="overlay game-ui">
      <div class="panel">
        <div class="panel-head">Settings<button class="close">&times;</button></div>
        <div class="tabs">
          <button class="tab active" data-tab="options">OPTIONS</button>
          <button class="tab" data-tab="keys">KEY BINDINGS</button>
          <button class="tab" data-tab="commands">COMMANDS</button>
        </div>
        <div class="tab-body" data-body="options">
          <div class="row"><span>Render Distance</span><button class="cycle" data-rd>Far</button></div>
          <div class="row"><span>Fog</span><button class="toggle" data-setting="fog"></button></div>
          <div class="row"><span>Anti-aliasing (MSAA)</span><button class="toggle" data-setting="msaa"></button></div>
          <div class="row"><span>Animations</span><button class="toggle" data-setting="animations"></button></div>
          <div class="row"><span>Center Camera</span><button class="toggle" data-setting="centerCamera"></button></div>
          <div class="divider"></div>
          <div class="section">OTHER</div>
          <div class="row"><span>Hide HUD</span><button class="toggle" data-setting="hideHud"></button></div>
          <div class="row"><span>FPS Counter</span><button class="toggle" data-setting="fps"></button></div>
          <div class="row"><span>Ping</span><button class="toggle" data-setting="ping"></button></div>
          <div class="row"><span>Location</span><button class="toggle" data-setting="location"></button></div>
        </div>
        <div class="tab-body hidden keys-list" data-body="keys">
          <div class="row"><span>Move</span><span class="k">click tile</span></div>
          <div class="row"><span>Attack / Shoot</span><span class="k">click the rival</span></div>
          <div class="row"><span>Pan camera</span><span class="k">click + drag</span></div>
          <div class="row"><span>Zoom</span><span class="k">mouse wheel</span></div>
          <div class="row"><span>Weapons</span><span class="k">keys 1 – 4</span></div>
          <div class="row"><span>Leave match</span><span class="k">Esc</span></div>
        </div>
        <div class="tab-body hidden cmd-list" data-body="commands">
          <div class="row"><span>/sword</span><span class="k">equip sword</span></div>
          <div class="row"><span>/pistol</span><span class="k">equip pistol</span></div>
          <div style="opacity:.55;font-size:13px;padding:10px 2px;">More commands coming soon.</div>
        </div>
      </div>
    </div>`);
  const renderDistBtn = overlay.querySelector("[data-rd]");

  // Tabs + open/close
  overlay.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      overlay.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      tab.classList.add("active");
      overlay.querySelectorAll(".tab-body").forEach((b) => b.classList.toggle("hidden", b.dataset.body !== tab.dataset.tab));
    });
  });
  // NB: gearBtn is intentionally NOT bound here — createArenaGame wires it to
  // the app's in-game menu (options.onMenu), falling back to this settings
  // overlay only when no menu callback was provided.
  overlay.querySelector(".close").addEventListener("click", () => overlay.classList.remove("show"));
  overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) overlay.classList.remove("show"); });

  function bindSettings(ctx) {
    overlay.querySelectorAll(".toggle").forEach((t) => {
      const key = t.dataset.setting;
      t.classList.toggle("on", !!ctx.settings[key]);
      t.addEventListener("click", () => {
        ctx.settings[key] = !ctx.settings[key];
        t.classList.toggle("on", ctx.settings[key]);
        if (key === "fog") ctx.applyFog();
        else if (key === "msaa") ctx.applyMsaa();
        else if (key === "centerCamera") ctx.onCenter();
        else ctx.refreshHud();
      });
    });
    renderDistBtn.addEventListener("click", () => {
      const i = RD_ORDER.indexOf(ctx.settings.renderDistance);
      ctx.settings.renderDistance = RD_ORDER[(i + 1) % RD_ORDER.length];
      renderDistBtn.textContent = ctx.settings.renderDistance;
      ctx.applyFog();
    });
  }

  return { root, coords, matchTimerEl, matchNoEl, mmCanvas, hotbar, slots, rivalsEl, fpsEl, pingEl, overlay, renderDistBtn, bindSettings, raiderCountCtrl, raiderCountEl, scorePanel, weaponPanel, keysInfoPanel, gearBtn };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// Degraded no-op API used when the 3D engine can't start. MUST implement every
// method the real API returns — a missing one throws deep inside init()/teardown
// and strands the app on the loading screen (setPing was missed here once and
// bricked boot whenever the three.js CDN failed).
function stubApi() {
  const noop = () => {};
  return {
    setView: noop, setMode: noop, setMatchPhase: noop, setControllable: noop, setMatchTimer: noop, setMatchNumber: noop, setLocalUser: noop,
    playerAlive: () => false,
    currentHp: () => 0, standings: () => [],
    useAiFoe: noop, usePvpFoes: noop, addOpponent: noop, removeOpponent: () => 0,
    clearRemote: noop, resetForMatch: noop, receivePlayerState: noop,
    receiveAttack: noop, generateMap: noop, clearAll: noop, destroy: noop,
    setMapVariant: noop, showMapToggle: noop, showRaiderCount: noop, setAiCount: noop,
    setPing: noop, openSettings: noop
  };
}
