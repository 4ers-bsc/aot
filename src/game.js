// 3D isometric voxel arena for Age of Trenches.
// Two visual views share one scene:
//   - "lobby": monochrome, shown behind the app chrome before a match.
//   - "game":  the attached reference look (light battlefield, green/red
//              fighters) with its own HUD; all app chrome is hidden.
// The local player is simulated and emits state/attacks. Demo mode pits the
// player against one AI raider. PvP mode supports up to ten network-driven
// opponents in a free-for-all; the last fighter standing wins.

const TILE = 2;
const MAP_TILES = 50;
const MAP_WORLD = MAP_TILES * TILE; // 100
const MAP_HALF = MAP_WORLD / 2; // 50
const EMIT_MS = 50;

const WEAPONS = {
  sword:  { id: "sword",   name: "Sword",   atk: 20, atkVar: 3, cd: 0.7,  range: 2.4, ranged: false },
  pistol: { id: "pistol",  name: "Pistol",  atk: 15, atkVar: 4, cd: 0.9,  range: 18,  ranged: true  },
  sniper: { id: "sniper",  name: "Sniper",  atk: 25, atkVar: 2, cd: 2.2,  range: 40,  ranged: true  },
};
const AI_WEAPON = { id: "sword", name: "Sword", atk: 9, atkVar: 2, cd: 1.1, range: 2.4, ranged: false };

const THEMES = {
  game: {
    bg: 0xf0f2f5,
    fogColor: 0xf0f2f5,
    ground: ["#ffffff", "#ffffff", "#f8f8f8", "#f4f4f4", "#f0f0f0", "#ebebeb", "#e4e4e4", "#e0e0e0", "#d8d8d8", "#d2d2d2", "#cccccc", "#c6c6c6"],
    grid: [0x999fa6, 0xaab0b6], gridOpacity: 0.28,
    border: 0x3a6a3a,
    player: { boots: 0x2c4a2c, jacket: 0x4a8a45, helmet: 0x33572f, face: 0xcda882 },
    enemy: { boots: 0x4a2222, jacket: 0xa83a32, helmet: 0x6a1f1f, face: 0xd0a884 },
    bullet: 0xffe08a,
    markerMove: [0x2f8a2f, 0x1f6f1f], markerAttack: [0xd23b3b, 0xa02020],
    playerBar: "#33b14a", enemyBar: "#e0473c",
    cursor: "%23e0473c",
    mm: { grid: "rgba(110,120,128,0.16)", border: "rgba(58,106,58,0.8)", cam: "rgba(47,138,47,0.5)", enemy: "#d23b3b", player: "#2f8a2f" }
  },
  lobby: {
    bg: 0x0a0a0c,
    fogColor: 0x0a0a0c,
    ground: ["#3a3a3a", "#343434", "#2e2e2e", "#2a2a2a", "#404040", "#363636", "#444444", "#383838", "#303030", "#4a4a4a", "#2c2c2c", "#3d3d3d"],
    grid: [0x5a5a5a, 0x404040], gridOpacity: 0.18,
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
  const renderer = new THREE.WebGLRenderer({ antialias: true });
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
  scene.fog = new THREE.Fog(theme.fogColor ?? theme.bg, RD_FOG.Far[0], RD_FOG.Far[1]);

  const FRUSTUM = 16;
  let dim = size();
  let aspect = dim.w / dim.h;
  const camera = new THREE.OrthographicCamera(-FRUSTUM * aspect, FRUSTUM * aspect, FRUSTUM, -FRUSTUM, 0.1, 1000);
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

  const borderLinePts = [
    new THREE.Vector3(-MAP_HALF, 0.02, -MAP_HALF), new THREE.Vector3(MAP_HALF, 0.02, -MAP_HALF),
    new THREE.Vector3(MAP_HALF, 0.02, MAP_HALF), new THREE.Vector3(-MAP_HALF, 0.02, MAP_HALF),
    new THREE.Vector3(-MAP_HALF, 0.02, -MAP_HALF)
  ];
  const border = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(borderLinePts),
    new THREE.LineBasicMaterial({ color: theme.border, transparent: true, opacity: 0 })
  );
  scene.add(border); // kept for applyTheme reference; invisible

  // -- Stone ledge + glass walls --------------------------------------------
  (function buildArenaEdge() {
    const LW = 4.0;   // ledge width/depth
    const LH = 1.8;   // ledge height above ground
    const SH = 0.32;  // snow cap height
    const SO = 0.22;  // snow overhang past stone edge

    const stoneMat = new THREE.MeshStandardMaterial({
      color: 0x7a7e88, roughness: 0.96, metalness: 0.04, flatShading: true
    });
    const snowMat = new THREE.MeshStandardMaterial({
      color: 0xdde8f2, roughness: 0.82, metalness: 0.0
    });

    const H = MAP_HALF;
    // sides: [w, d, cx, cz]
    const sides = [
      [MAP_WORLD, LW, 0, -(H + LW / 2)],
      [MAP_WORLD, LW, 0,  (H + LW / 2)],
      [LW, MAP_WORLD, -(H + LW / 2), 0],
      [LW, MAP_WORLD,  (H + LW / 2), 0],
    ];
    const corners = [
      [-(H + LW / 2), -(H + LW / 2)],
      [ (H + LW / 2), -(H + LW / 2)],
      [-(H + LW / 2),  (H + LW / 2)],
      [ (H + LW / 2),  (H + LW / 2)],
    ];
    [...sides.map(([w, d, cx, cz]) => ({ w, d, cx, cz })),
     ...corners.map(([cx, cz]) => ({ w: LW, d: LW, cx, cz }))
    ].forEach(({ w, d, cx, cz }) => {
      const stone = new THREE.Mesh(new THREE.BoxGeometry(w, LH, d), stoneMat);
      stone.position.set(cx, LH / 2, cz);
      stone.castShadow = true; stone.receiveShadow = true;
      scene.add(stone);

      const snowCap = new THREE.Mesh(new THREE.BoxGeometry(w + SO * 2, SH, d + SO * 2), snowMat);
      snowCap.position.set(cx, LH + SH / 2, cz);
      snowCap.castShadow = true; snowCap.receiveShadow = true;
      scene.add(snowCap);
    });

    // Glass panels that fade downward outside the stone ledge
    const gc = document.createElement("canvas");
    gc.width = 2; gc.height = 128;
    const gctx = gc.getContext("2d");
    const grad = gctx.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0,    "rgba(190, 215, 245, 0.45)");
    grad.addColorStop(0.35, "rgba(170, 205, 240, 0.25)");
    grad.addColorStop(1,    "rgba(150, 195, 235, 0.0)");
    gctx.fillStyle = grad; gctx.fillRect(0, 0, 2, 128);
    const glassTex = new THREE.CanvasTexture(gc);

    const glassMat = new THREE.MeshBasicMaterial({
      map: glassTex, transparent: true, side: THREE.DoubleSide, depthWrite: false
    });

    const GH = 16;
    const GW = MAP_WORLD + LW * 2 + 4;
    const off = H + LW;
    [
      { x: 0,    z: -off, ry: 0 },
      { x: 0,    z:  off, ry: Math.PI },
      { x: -off, z: 0,    ry:  Math.PI / 2 },
      { x:  off, z: 0,    ry: -Math.PI / 2 },
    ].forEach(({ x, z, ry }) => {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(GW, GH), glassMat);
      panel.position.set(x, -GH / 2, z);
      panel.rotation.y = ry;
      scene.add(panel);
    });

    // Dark bottom cap
    const btm = new THREE.Mesh(
      new THREE.PlaneGeometry(MAP_WORLD + LW * 2, MAP_WORLD + LW * 2),
      new THREE.MeshStandardMaterial({ color: 0x020203, roughness: 1 })
    );
    btm.rotation.x = Math.PI / 2;
    btm.position.y = -GH;
    scene.add(btm);
  })();

  // -- Pixelated FIGHT10 ground decals (black pixel squares, random) --------
  const fight10Groups = [];
  function makeFight10Decal() {
    fight10Groups.forEach((g) => scene.remove(g));
    fight10Groups.length = 0;
    const CW = 56, CH = 10;
    for (let i = 0; i < 1; i++) {
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
  function makeBar(barColor) {
    const el = document.createElement("div");
    el.className = "bar game-ui";
    const name = document.createElement("div"); name.className = "bar-name";
    const track = document.createElement("div"); track.className = "bar-track";
    const fill = document.createElement("div"); fill.className = "bar-fill";
    fill.style.background = barColor;
    track.appendChild(fill);
    el.append(name, track);
    document.body.appendChild(el);
    return { el, name, fill, color: barColor };
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
    g.add(legL, legR, torso, shlL, shlR, armL, armR, head, helmet, visor);
    g.position.copy(cfg.pos);
    g.visible = false;
    scene.add(g);
    const f = {
      userId: cfg.userId || null,
      name: cfg.name, isPlayer: !!cfg.isPlayer, group: g,
      legL, legR, armL, armR, swordMesh, pistolMesh,
      maxHp: cfg.hp, hp: cfg.hp, weapon: cfg.weapon, speed: cfg.speed,
      cdTimer: 0, atkAnim: 0, hurt: 0, regenAcc: 0,
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
    if (f.pistolMesh) f.pistolMesh.visible = f.weapon.id !== "sword";
  }
  function recolorFighter(f, palette) {
    Object.keys(f.parts).forEach((key) => f.parts[key].forEach((mat) => mat.color.setHex(palette[key])));
  }
  function disposeFighter(f) {
    scene.remove(f.group);
    f.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    f.bar.el.remove();
  }

  const player = makeFighter({ name: "You", isPlayer: true, palette: theme.player, pos: new THREE.Vector3(-12, 0, 4), hp: 100, weapon: WEAPONS.sword, speed: 6.5, barColor: theme.playerBar });
  // Demo AI raider (foeMode === "ai"). PvP uses the opponents map instead.
  const aiEnemy = makeFighter({ name: "Raider", palette: theme.enemy, pos: new THREE.Vector3(12, 0, -4), hp: 100, weapon: AI_WEAPON, speed: 4.6, barColor: theme.enemyBar });
  const opponents = new Map(); // userId -> networked fighter
  let foeMode = "ai"; // "ai" (demo) | "net" (pvp)
  const AI_AGGRO = 14;

  function foeList() {
    return foeMode === "ai" ? [aiEnemy] : [...opponents.values()];
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
  let solids = [];   // { x, z, r } — blocks movement + line of sight
  let river = null;  // { axis: 'x'|'z', min, max }

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
    if (!river) return false;
    const v = river.axis === "x" ? x : z;
    return v >= river.min && v <= river.max;
  }
  function collidesSolid(x, z, selfR) {
    for (const s of solids) {
      const dx = x - s.x, dz = z - s.z, rr = s.r + selfR;
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
  function clearMap() {
    while (mapGroup.children.length) {
      const c = mapGroup.children.pop();
      c.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      mapGroup.remove(c);
    }
    solids = [];
    river = null;
  }
  function addTree(x, z) {
    const g = new THREE.Group();
    const trunk = box(0.5, 1.6, 0.5, 0x5c3d1e); trunk.position.y = 0.8;
    const f1 = box(2.0, 1.4, 2.0, 0x2d5e2a); f1.position.y = 2.0;
    const f2 = box(1.3, 1.2, 1.3, 0x254f22); f2.position.y = 3.0;
    // Snow layers: sit on top of each foliage tier, slightly wider to droop
    const sn1 = box(2.2, 0.3, 2.2, 0xdde9f5); sn1.position.y = 2.85;
    const sn2 = box(1.45, 0.26, 1.45, 0xe4eef7); sn2.position.y = 3.72;
    const snTop = box(0.55, 0.2, 0.55, 0xf0f6ff); snTop.position.y = 4.24;
    g.add(trunk, f1, f2, sn1, sn2, snTop);
    g.position.set(x, 0, z);
    mapGroup.add(g);
    solids.push({ x, z, r: 1.1 });
  }
  function addMountain(x, z, rng) {
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
    g.rotation.y = rng() * Math.PI;
    g.position.set(x, 0, z);
    mapGroup.add(g);
    solids.push({ x, z, r: 1.9 });
  }
  function buildRiver(rng) {
    const axis = rng() < 0.5 ? "x" : "z";
    const half = 5 + rng() * 2;
    const center = (rng() * 2 - 1) * (MAP_HALF - 16);
    river = { axis, min: center - half, max: center + half };
    const w = half * 2;
    const geo = new THREE.PlaneGeometry(axis === "x" ? w : MAP_WORLD, axis === "x" ? MAP_WORLD : w);
    const plane = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0x3d7fb0, transparent: true, opacity: 0.72, roughness: 0.2, metalness: 0.1
    }));
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(axis === "x" ? center : 0, 0.05, axis === "x" ? 0 : center);
    plane.receiveShadow = true;
    mapGroup.add(plane);
  }
  function generateMap(seedStr) {
    clearMap();
    const rng = makeRng(seedStr || "demo");
    buildRiver(rng);
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
    scatter(18, addTree, 2.4);
    scatter(8, (x, z) => addMountain(x, z, rng), 3.4);
  }
  // A free, dry spawn point anywhere on the map.
  function randomSpawn() {
    for (let i = 0; i < 80; i++) {
      const x = (Math.random() * 2 - 1) * (MAP_HALF - 3);
      const z = (Math.random() * 2 - 1) * (MAP_HALF - 3);
      if (!inRiver(x, z) && !collidesSolid(x, z, BODY_R + 0.4)) return { x, z };
    }
    return { x: 0, z: 0 };
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
    const nx = Math.max(-lim, Math.min(lim, px + dx / dist * step));
    const nz = Math.max(-lim, Math.min(lim, pz + dz / dist * step));
    f.facing = Math.atan2(dx, dz);
    if (!collidesSolid(nx, nz, BODY_R)) {
      f.group.position.x = nx; f.group.position.z = nz;
      f.walkPhase += dt * f.speed * 1.6;
      f.moving = true;
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
      weapon: player.weapon.id, name: player.name
    });
  }
  function applyDamage(def, dmg) {
    if (def.dead) return;
    def.hp = Math.max(0, def.hp - dmg);
    def.hurt = 0.18;
    if (def.hp <= 0) killFighter(def);
    if (def === player && foeMode === "net") emitState();
  }
  function fireBullet(att, def, dmg, deal) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), new THREE.MeshBasicMaterial({ color: theme.bullet }));
    const fx = Math.sin(att.facing), fz = Math.cos(att.facing);
    b.position.set(att.group.position.x + fx * 0.8, 1.5, att.group.position.z + fz * 0.8);
    scene.add(b);
    bullets.push({ mesh: b, def: deal ? def : null, dmg, speed: 46, target: new THREE.Vector3(def.group.position.x, 1.45, def.group.position.z) });
  }
  function updateBullets(dt) {
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      const d = b.target.clone().sub(b.mesh.position);
      const dist = d.length(), step = b.speed * dt;
      if (dist <= step || dist < 0.5) {
        if (b.def && !b.def.dead) applyDamage(b.def, b.dmg);
        scene.remove(b.mesh);
        bullets.splice(i, 1);
      } else {
        b.mesh.position.addScaledVector(d.normalize(), step);
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
    // Trees / snow mountains in the way deflect the blow (swing plays, no hit).
    if (losBlocked(player.group.position.x, player.group.position.z, def.group.position.x, def.group.position.z)) return true;
    let dmg = Math.max(1, Math.round(w.atk + (Math.random() * 2 - 1) * w.atkVar));
    if (inRiver(player.group.position.x, player.group.position.z)) dmg = Math.max(1, Math.round(dmg * RIVER_ATK));
    if (foeMode === "net") {
      // Optimistic: apply the same damage locally and tell everyone. All
      // clients compute from the identical dmg, so the target's bar drops
      // instantly here instead of after a network round-trip.
      if (w.ranged) fireBullet(player, def, dmg, true);
      else applyDamage(def, dmg);
      options.onAttack?.({ fromId: localUserId, targetId: def.userId, weapon: w.id, dmg, ranged: !!w.ranged });
    } else {
      if (w.ranged) fireBullet(player, def, dmg, true);
      else applyDamage(def, dmg);
    }
    return true;
  }
  function aiAttack() {
    if (aiEnemy.cdTimer > 0 || player.dead || aiEnemy.hp <= 0) return;
    const w = aiEnemy.weapon;
    aiEnemy.cdTimer = w.cd;
    aiEnemy.atkAnim = 0.32;
    if (losBlocked(aiEnemy.group.position.x, aiEnemy.group.position.z, player.group.position.x, player.group.position.z)) return;
    let dmg = Math.max(1, Math.round(w.atk + (Math.random() * 2 - 1) * w.atkVar));
    if (inRiver(aiEnemy.group.position.x, aiEnemy.group.position.z)) dmg = Math.max(1, Math.round(dmg * RIVER_ATK));
    applyDamage(player, dmg);
  }
  function killFighter(f) {
    f.dead = true;
    f.moving = false;
    f.deadTimer = f.isPlayer ? 1.8 : 2.2;
    if (foeMode === "ai" && f === aiEnemy) kills++;
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
    if (f.isPlayer) { f.attackTarget = null; f.target = null; camCenter.set(sp.x, 0, sp.z); }
  }
  function regen(f, dt) {
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
    // Melee or ranged: close to weapon range, then face the target and fire
    // exactly once. Clearing the target after the strike stops auto-repeat.
    if (p.attackTarget && !p.attackTarget.dead && p.attackTarget.connected) {
      const e = p.attackTarget;
      const dx = e.group.position.x - p.group.position.x, dz = e.group.position.z - p.group.position.z;
      if (Math.hypot(dx, dz) > p.weapon.range) moveStep(p, e.group.position.x, e.group.position.z, dt);
      else { p.facing = Math.atan2(dx, dz); if (playerAttack(e)) p.attackTarget = null; }
    } else {
      p.attackTarget = null;
      if (p.target && moveStep(p, p.target.x, p.target.z, dt)) p.target = null;
    }
  }
  function updateAi(dt) {
    const e = aiEnemy;
    if (e.dead) { handleDead(e, dt); return; }
    if (e.cdTimer > 0) e.cdTimer -= dt;
    if (e.atkAnim > 0) e.atkAnim -= dt;
    e.moving = false;
    regen(e, dt);
    if (player.dead || !controllable) return;
    const dx = player.group.position.x - e.group.position.x, dz = player.group.position.z - e.group.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= AI_AGGRO) {
      if (dist > e.weapon.range) moveStep(e, player.group.position.x, player.group.position.z, dt);
      else { e.facing = Math.atan2(dx, dz); aiAttack(); }
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
      following = true;
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
      player.attackTarget = null;
      player.target = new THREE.Vector3(tx, 0, tz);
      // Don't recenter the camera on the character for a move order; the
      // player can pan freely (Center Camera setting still forces follow).
      if (settings.centerCamera) following = true;
      setMarker(tx, tz, theme.markerMove[0], theme.markerMove[1]);
    }
  }
  let isDown = false, dragging = false, sx = 0, sy = 0, lx = 0, ly = 0;
  const panRight = new THREE.Vector3(), panUp = new THREE.Vector3();
  const canvas = renderer.domElement;
  canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); isDown = true; dragging = false; sx = lx = e.clientX; sy = ly = e.clientY; });
  canvas.addEventListener("pointermove", (e) => {
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
  });
  canvas.addEventListener("pointerup", (e) => { if (!isDown) return; isDown = false; if (!dragging) handleTap(e.clientX, e.clientY); });
  const ZOOM_MIN = 0.4, ZOOM_MAX = 3.2;
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    camera.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, camera.zoom * Math.exp(-e.deltaY * 0.0012)));
    camera.updateProjectionMatrix();
  }, { passive: false });

  // -- HUD (attached reference set) -----------------------------------------
  const hud = buildHud();
  const { hint, coords, mmCanvas, hotbar, slots, fpsEl, pingEl, overlay, renderDistBtn, matchTimerEl } = hud;

  let activeSlot = 1;
  function selectSlot(n) {
    if (n < 1 || n > 5) return;
    activeSlot = n;
    slots.forEach((s) => s.classList.toggle("active", parseInt(s.dataset.slot, 10) === n));
    if (n === 1) { player.weapon = WEAPONS.sword; updateWeaponVis(player); }
    else if (n === 2) { player.weapon = WEAPONS.pistol; player.attackTarget = null; updateWeaponVis(player); }
    else if (n === 3) { player.weapon = WEAPONS.sniper; player.attackTarget = null; updateWeaponVis(player); }
  }
  slots.forEach((s) => s.addEventListener("click", () => selectSlot(parseInt(s.dataset.slot, 10))));
  window.addEventListener("keydown", (e) => {
    if (e.key >= "1" && e.key <= "5") selectSlot(parseInt(e.key, 10));
  });

  // Settings
  const settings = { renderDistance: "Far", fog: false, msaa: true, animations: true, centerCamera: false, hideHud: false, fps: true, ping: true, location: false };
  function applyFog() {
    if (settings.fog) { const r = RD_FOG[settings.renderDistance]; scene.fog = new THREE.Fog(theme.fogColor ?? theme.bg, r[0], r[1]); }
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
  renderDistBtn.textContent = settings.renderDistance;

  // Minimap
  const MM = 160;
  const mmDpr = Math.min(window.devicePixelRatio, 2);
  mmCanvas.width = MM * mmDpr; mmCanvas.height = MM * mmDpr;
  const mmCtx = mmCanvas.getContext("2d");
  mmCtx.scale(mmDpr, mmDpr);
  const mmScale = MM / MAP_WORLD;
  const wToMM = (w) => (w + MAP_HALF) * mmScale;
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
    mmCtx.strokeStyle = theme.mm.grid; mmCtx.lineWidth = 1;
    for (let g = -MAP_HALF; g <= MAP_HALF + 0.01; g += TILE * 5) {
      const p = wToMM(g);
      mmCtx.beginPath(); mmCtx.moveTo(p, 0); mmCtx.lineTo(p, MM); mmCtx.stroke();
      mmCtx.beginPath(); mmCtx.moveTo(0, p); mmCtx.lineTo(MM, p); mmCtx.stroke();
    }
    if (river) {
      mmCtx.fillStyle = "rgba(61,127,176,0.55)";
      if (river.axis === "x") mmCtx.fillRect(wToMM(river.min), 0, (river.max - river.min) * mmScale, MM);
      else mmCtx.fillRect(0, wToMM(river.min), MM, (river.max - river.min) * mmScale);
    }
    mmCtx.fillStyle = "rgba(40,46,40,0.7)";
    for (const s of solids) {
      mmCtx.fillRect(wToMM(s.x) - 1.5, wToMM(s.z) - 1.5, 3, 3);
    }
    mmCtx.strokeStyle = theme.mm.border; mmCtx.lineWidth = 1.5;
    mmCtx.strokeRect(0.75, 0.75, MM - 1.5, MM - 1.5);
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
    recolorFighter(player, theme.player);
    player.bar.color = theme.playerBar;
    recolorFighter(aiEnemy, theme.enemy);
    aiEnemy.bar.color = theme.enemyBar;
    opponents.forEach((o) => { recolorFighter(o, theme.enemy); o.bar.color = theme.enemyBar; });
    cursorAttack = !cursorAttack; setCursor(false);
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
      const sp = randomSpawn();
      o.group.position.set(sp.x, 0, sp.z);
      o.netTarget = { x: sp.x, z: sp.z };
      o.group.rotation.set(0, o.group.rotation.y, 0);
    });
  }

  // -- Result detection -----------------------------------------------------
  function buildStandings() {
    const list = [{ name: player.name, hp: Math.max(0, player.dead ? 0 : player.hp), me: true }];
    if (foeMode === "ai") {
      if (aiEnemy.connected) list.push({ name: aiEnemy.name, hp: Math.max(0, aiEnemy.dead ? 0 : aiEnemy.hp), me: false });
    } else {
      opponents.forEach((o) => { if (o.connected) list.push({ name: o.name, hp: Math.max(0, o.dead ? 0 : o.hp), me: false }); });
    }
    list.sort((a, b) => b.hp - a.hp);
    return list.map((f, i) => ({ rank: i + 1, ...f }));
  }
  function checkResult() {
    if (foeMode !== "net" || matchPhase !== "active" || resultSent) return;
    if (player.hp <= 0) { resultSent = true; options.onResultSuggestion?.("loss", buildStandings()); return; }
    if (opponents.size === 0) return; // no rivals yet
    let anyAlive = false;
    opponents.forEach((o) => { if (o.connected && !o.dead) anyAlive = true; });
    if (!anyAlive && player.hp > 0) { resultSent = true; options.onResultSuggestion?.("win", buildStandings()); }
  }

  // -- Match timer ----------------------------------------------------------
  let matchTimeLeft = 0;
  let matchTimerOn = false;
  function fmtTime(s) {
    s = Math.max(0, Math.ceil(s));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  function showTimer() {
    matchTimerEl.style.display = matchTimerOn && viewIsGame ? "block" : "none";
  }
  function tickTimer(dt) {
    if (!matchTimerOn || resultSent || matchPhase !== "active") return;
    matchTimeLeft -= dt;
    matchTimerEl.textContent = fmtTime(matchTimeLeft);
    matchTimerEl.classList.toggle("low", matchTimeLeft <= 30);
    if (matchTimeLeft <= 0) { matchTimerOn = false; resolveByHp(); }
  }
  // Time's up: highest HP among the survivors wins (tie-break by id).
  function resolveByHp() {
    if (resultSent) return;
    resultSent = true;
    const field = [{ id: localUserId ?? "", hp: player.dead ? -1 : player.hp, me: true, name: player.name }];
    opponents.forEach((o) => field.push({ id: o.userId, hp: o.dead ? -1 : o.hp, me: false, name: o.name }));
    field.sort((a, b) => b.hp - a.hp || String(a.id).localeCompare(String(b.id)));
    const standings = field.map((f, i) => ({ rank: i + 1, name: f.name, hp: Math.max(0, f.hp), me: f.me }));
    options.onResultSuggestion?.(field[0].me ? "win" : "loss", standings);
  }

  // -- Loop -----------------------------------------------------------------
  let destroyed = false;
  let fpsAcc = 0, fpsFrames = 0;
  const clock = new THREE.Clock();
  function animate() {
    if (destroyed) return;
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

    if (perspective === "player") {
      emitAcc += dt * 1000;
      if (emitAcc >= EMIT_MS) emitState();
      checkResult();
      tickTimer(dt);
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
    sun.position.copy(player.group.position).add(new THREE.Vector3(20, 40, 12));
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
    aiEnemy.group.visible = foeMode === "ai" && aiEnemy.connected;
    opponents.forEach((o) => { o.group.visible = foeMode === "net" && o.connected; });
    updateBar(player);
    updateBar(aiEnemy);
    opponents.forEach((o) => updateBar(o));
    setCursor(controllable && !player.dead && ((player.attackTarget && !player.attackTarget.dead) || player.atkAnim > 0));

    if (settings.fps) {
      fpsAcc += dt; fpsFrames++;
      if (fpsAcc >= 0.5) { fpsEl.textContent = "FPS " + Math.round(fpsFrames / fpsAcc); fpsAcc = 0; fpsFrames = 0; }
    }
    if (settings.ping) {
      if (foeMode !== "net") pingEl.textContent = "-- ms";
    }
    const aliveRivals = foeList().filter((f) => f.connected && !f.dead).length;
    coords.textContent = `x ${player.group.position.x.toFixed(1)} · z ${player.group.position.z.toFixed(1)} · ${foeMode === "net" ? `rivals ${aliveRivals}` : `kills ${kills}`}`;

    drawMinimap();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  // -- Public API -----------------------------------------------------------
  return {
    setView(view) {
      viewIsGame = view === "game";
      document.body.classList.toggle("in-game", viewIsGame);
      applyTheme(viewIsGame ? "game" : "lobby");
      showTimer();
      if (viewIsGame) setTimeout(() => { hint.style.opacity = "0"; }, 6000);
    },
    setMode(mode) {
      perspective = mode;
      controllable = mode === "player";
    },
    setMatchPhase(phase) { matchPhase = phase; },
    setControllable(on) { controllable = !!on; },
    setMatchTimer(seconds) {
      matchTimeLeft = seconds || 0;
      matchTimerOn = matchTimeLeft > 0;
      matchTimerEl.textContent = fmtTime(matchTimeLeft);
      matchTimerEl.classList.remove("low");
      showTimer();
    },
    playerAlive() { return !player.dead && player.hp > 0; },
    opponentCount() { return opponents.size; },
    setLocalUser({ userId, displayName }) {
      perspective = "player";
      controllable = true;
      localUserId = userId || null;
      player.name = displayName || "You";
      player.connected = true;
    },
    // Demo: single AI raider.
    useAiFoe() {
      foeMode = "ai";
      clearOpponents();
      aiEnemy.networked = false;
      aiEnemy.connected = true;
      aiEnemy.name = "Raider";
      aiEnemy.weapon = AI_WEAPON;
    },
    // PvP: switch to networked opponents.
    usePvpFoes() {
      foeMode = "net";
      aiEnemy.connected = false;
    },
    addOpponent({ userId, displayName }) {
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
      opponents.set(userId, f);
      const sp = randomSpawn();
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
    resetForMatch() {
      resultSent = false;
      matchTimerOn = false; showTimer();
      bullets.splice(0).forEach((b) => scene.remove(b.mesh));
      Object.assign(player, { hp: player.maxHp, dead: false, cdTimer: 0, atkAnim: 0, hurt: 0, moving: false, attackTarget: null, target: null });
      player.group.rotation.set(0, player.group.rotation.y, 0);
      const ps = randomSpawn();
      player.group.position.set(ps.x, 0, ps.z);
      player.connected = true;
      if (foeMode === "ai") {
        Object.assign(aiEnemy, { hp: aiEnemy.maxHp, dead: false, cdTimer: 0, atkAnim: 0, hurt: 0, moving: false });
        aiEnemy.group.rotation.set(0, aiEnemy.group.rotation.y, 0);
        const es = randomSpawn();
        aiEnemy.group.position.set(es.x, 0, es.z);
        aiEnemy.netTarget = { x: es.x, z: es.z };
        aiEnemy.connected = true;
      } else {
        opponents.forEach((o) => {
          Object.assign(o, { hp: o.maxHp, dead: false, cdTimer: 0, atkAnim: 0, hurt: 0, moving: false });
        });
        placeOpponents();
      }
      camCenter.set(ps.x, 0, ps.z);
      following = true;
    },
    receivePlayerState(userId, snap) {
      if (!snap || foeMode !== "net") return;
      const f = opponents.get(userId);
      if (!f) return;
      f.connected = true;
      f.netTarget = { x: clamp(snap.x, -MAP_HALF, MAP_HALF), z: clamp(snap.z, -MAP_HALF, MAP_HALF) };
      f.maxHp = snap.maxHp ?? f.maxHp;
      // HP only drops within a match (no respawns). Take the lower of our
      // optimistic value and their authoritative report to avoid bounce-back.
      const snapHp = clamp(snap.hp ?? f.hp, 0, f.maxHp);
      f.hp = Math.min(f.hp, snapHp);
      if (typeof snap.facing === "number") f.facing = snap.facing;
      if (snap.weapon && WEAPONS[snap.weapon]) { f.weapon = WEAPONS[snap.weapon]; updateWeaponVis(f); }
      if (snap.name) f.name = snap.name;
      if (f.hp <= 0 && !f.dead) killFighter(f);
    },
    receiveAttack(payload) {
      if (!payload || foeMode !== "net") return;
      const maxWeaponDmg = Math.max(...Object.values(WEAPONS).map((w) => w.atk + w.atkVar));
      const dmg = Math.min(Math.max(0, payload.dmg || 0), maxWeaponDmg);
      const attacker = payload.fromId ? opponents.get(payload.fromId) : null;
      if (payload.targetId === localUserId) {
        if (player.dead) return;
        if (attacker) attacker.atkAnim = 0.32;
        if (payload.ranged && attacker) fireBullet(attacker, player, dmg, true);
        else applyDamage(player, dmg);
      } else {
        const target = opponents.get(payload.targetId);
        if (!target || target.dead) return;
        if (attacker) attacker.atkAnim = 0.32;
        if (payload.ranged && attacker) fireBullet(attacker, target, dmg, true);
        else applyDamage(target, dmg);
      }
    },
    generateMap(seed) { generateMap(seed); },
    clearAll() {
      perspective = "offline";
      controllable = false;
      foeMode = "ai";
      clearOpponents();
      clearMap();
      aiEnemy.networked = false;
      aiEnemy.connected = false;
      aiEnemy.name = "Raider";
      player.connected = false;
      matchTimerOn = false; showTimer();
      viewIsGame = false;
      document.body.classList.remove("in-game");
      applyTheme("lobby");
    },
    setPing(ms) { if (pingEl) pingEl.textContent = ms != null ? ms + " ms" : "-- ms"; },
    openSettings() { overlay.classList.add("show"); },
    destroy() {
      destroyed = true;
      ro.disconnect();
      player.bar.el.remove();
      aiEnemy.bar.el.remove();
      clearOpponents();
      hud.root.remove();
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

  const hint = add('<div class="hint game-ui"><b>Arena</b> — <span class="key">click</span> move &middot; <span class="key">click rival</span> attack &middot; <span class="key">drag</span> pan &middot; <span class="key">scroll</span> zoom &middot; <span class="key">Esc</span> leave</div>');
  const matchTimerEl = add('<div class="match-timer game-ui">0:00</div>');
  const coords = add('<div class="coords game-ui">x 0.0 &middot; z 0.0</div>');
  add('<div class="mm-label game-ui">map</div>');
  const mmCanvas = add('<canvas class="game-minimap game-ui"></canvas>');
  const hotbar = add('<div class="hotbar game-ui"></div>');
  for (let n = 1; n <= 5; n++) {
    const imgSrc = n === 1 ? "/sword.png" : n === 2 ? "/pistol.png" : n === 3 ? "/sniper.png" : "";
    const imgTag = imgSrc ? `<img src="${imgSrc}" class="slot-icon" alt="" />` : "";
    const s = document.createElement("div");
    s.className = "slot" + (n === 1 ? " active" : "");
    s.dataset.slot = String(n);
    s.innerHTML = `${imgTag}<span class="num">${n}</span>`;
    hotbar.appendChild(s);
  }
  const slots = Array.from(hotbar.querySelectorAll(".slot"));
  add('<button class="gear game-ui" title="Settings">&#9881;</button>');
  const gearBtn = root.querySelector(".gear");
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
          <div class="row"><span>Weapons</span><span class="k">keys 1 – 5</span></div>
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
  gearBtn.addEventListener("click", () => overlay.classList.add("show"));
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

  return { root, hint, coords, matchTimerEl, mmCanvas, hotbar, slots, fpsEl, pingEl, overlay, renderDistBtn, bindSettings };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function stubApi() {
  const noop = () => {};
  return {
    setView: noop, setMode: noop, setMatchPhase: noop, setControllable: noop, setMatchTimer: noop, setLocalUser: noop,
    playerAlive: () => false, opponentCount: () => 0,
    useAiFoe: noop, usePvpFoes: noop, addOpponent: noop, removeOpponent: () => 0,
    clearRemote: noop, resetForMatch: noop, receivePlayerState: noop,
    receiveAttack: noop, generateMap: noop, clearAll: noop, destroy: noop
  };
}
