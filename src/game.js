// 3D isometric voxel arena for Age of Trenches.
// Renders a pixelated 50x50 battlefield with voxel fighters. Exposes the same
// createArenaGame() contract main.js expects: the local player is simulated
// here and emits state/attacks; the opponent is either driven by the network
// (in a real match) or by a simple AI (solo / waiting demo).

const TILE = 2;
const MAP_TILES = 50;
const MAP_WORLD = MAP_TILES * TILE; // 100
const MAP_HALF = MAP_WORLD / 2; // 50
const EMIT_MS = 90;

// Monochrome palettes — player reads light, opponent reads dark.
const LIGHT = { boots: 0x8f8f8f, jacket: 0xdedede, helmet: 0xf3f3f3, face: 0xb6b6b6 };
const DARK = { boots: 0x242424, jacket: 0x4a4a4a, helmet: 0x1c1c1c, face: 0x6a6a6a };

const WEAPONS = {
  sword: { id: "sword", name: "Sword", atk: 16, atkVar: 3, cd: 0.7, range: 2.4, ranged: false },
  pistol: { id: "pistol", name: "Pistol", atk: 21, atkVar: 4, cd: 0.9, range: 18, ranged: true }
};
const AI_WEAPON = { id: "sword", name: "Sword", atk: 9, atkVar: 2, cd: 1.1, range: 2.4, ranged: false };

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

  // -- Renderer -------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x121212, 1);
  renderer.domElement.classList.add("arena-canvas");
  mount.appendChild(renderer.domElement);

  function size() {
    return {
      w: mount.clientWidth || window.innerWidth,
      h: mount.clientHeight || window.innerHeight
    };
  }

  // -- Scene ----------------------------------------------------------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x121212);
  scene.fog = new THREE.Fog(0x121212, 60, 140);

  const FRUSTUM = 16;
  let dim = size();
  let aspect = dim.w / dim.h;
  const camera = new THREE.OrthographicCamera(-FRUSTUM * aspect, FRUSTUM * aspect, FRUSTUM, -FRUSTUM, 0.1, 1000);
  const CAM_OFFSET = new THREE.Vector3(28, 34, 28);
  const camCenter = new THREE.Vector3(0, 0, 0);
  let following = true;

  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 0.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 120;
  sun.shadow.camera.left = -18;
  sun.shadow.camera.right = 18;
  sun.shadow.camera.top = 18;
  sun.shadow.camera.bottom = -18;
  sun.shadow.bias = -0.0004;
  scene.add(sun, sun.target);

  // -- Ground: pixelated grey base map --------------------------------------
  function makePixelTexture(px) {
    const c = document.createElement("canvas");
    c.width = c.height = px;
    const ctx = c.getContext("2d");
    const palette = ["#3a3a3a", "#343434", "#2e2e2e", "#2a2a2a", "#404040", "#363636", "#444444", "#383838", "#303030", "#4a4a4a", "#2c2c2c", "#3d3d3d"];
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
    return tex;
  }
  const TILE_WORLD = 24;
  const groundTex = makePixelTexture(96);
  groundTex.repeat.set(MAP_WORLD / TILE_WORLD, MAP_WORLD / TILE_WORLD);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP_WORLD, MAP_WORLD),
    new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(MAP_WORLD, MAP_TILES, 0x5a5a5a, 0x404040);
  grid.material.transparent = true;
  grid.material.opacity = 0.32;
  grid.position.y = 0.012;
  scene.add(grid);

  const border = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-MAP_HALF, 0.02, -MAP_HALF),
      new THREE.Vector3(MAP_HALF, 0.02, -MAP_HALF),
      new THREE.Vector3(MAP_HALF, 0.02, MAP_HALF),
      new THREE.Vector3(-MAP_HALF, 0.02, MAP_HALF),
      new THREE.Vector3(-MAP_HALF, 0.02, -MAP_HALF)
    ]),
    new THREE.LineBasicMaterial({ color: 0x808080 })
  );
  scene.add(border);

  // -- Snow -----------------------------------------------------------------
  const SNOW_COUNT = 1200, SNOW_AREA = 48, SNOW_TOP = 30;
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
    size: 0.32, map: makeFlake(), transparent: true, depthWrite: false, opacity: 0.85, sizeAttenuation: true
  }));
  scene.add(snow);

  // -- Move/attack marker ---------------------------------------------------
  const marker = new THREE.Group();
  const markerFill = new THREE.Mesh(
    new THREE.PlaneGeometry(TILE, TILE),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false })
  );
  const markerEdge = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(TILE, TILE)),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 })
  );
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

  // -- Voxel fighter builders ----------------------------------------------
  function box(w, h, d, color) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05 })
    );
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }
  function limb(w, h, d, color) {
    const pivot = new THREE.Group();
    const mesh = box(w, h, d, color);
    mesh.position.y = -h / 2;
    pivot.add(mesh);
    return pivot;
  }
  function makeSword() {
    const s = new THREE.Group();
    const blade = box(0.1, 0.06, 0.95, 0xe6e6e6); blade.position.set(0, 0, 0.55);
    const guard = box(0.34, 0.08, 0.09, 0x3a3f45); guard.position.set(0, 0, 0.05);
    const grip = box(0.09, 0.09, 0.26, 0x6b6b6b); grip.position.set(0, 0, -0.14);
    s.add(blade, guard, grip);
    s.position.set(0, -0.8, 0.05);
    s.rotation.x = -0.15;
    return s;
  }
  function makePistol() {
    const g = new THREE.Group();
    const body = box(0.12, 0.18, 0.3, 0x2a2a2a); body.position.set(0, 0, 0.04);
    const barrel = box(0.09, 0.1, 0.32, 0x161616); barrel.position.set(0, 0.04, 0.26);
    const grip = box(0.11, 0.22, 0.12, 0x444444); grip.position.set(0, -0.16, -0.06); grip.rotation.x = 0.35;
    g.add(body, barrel, grip);
    g.position.set(0, -0.78, 0.08);
    g.rotation.x = -0.05;
    return g;
  }
  function makeBar(barColor) {
    const el = document.createElement("div");
    el.className = "fighter-bar";
    const name = document.createElement("div");
    name.className = "fighter-bar-name";
    const track = document.createElement("div");
    track.className = "fighter-bar-track";
    const fill = document.createElement("div");
    fill.className = "fighter-bar-fill";
    fill.style.background = barColor;
    track.appendChild(fill);
    el.append(name, track);
    document.body.appendChild(el);
    return { el, name, fill, color: barColor };
  }
  function makeFighter(cfg) {
    const P = cfg.palette;
    const g = new THREE.Group();
    const legL = limb(0.34, 0.9, 0.34, P.boots), legR = limb(0.34, 0.9, 0.34, P.boots);
    legL.position.set(-0.22, 0.9, 0); legR.position.set(0.22, 0.9, 0);
    const torso = box(0.92, 0.92, 0.52, P.jacket); torso.position.y = 1.36;
    const armL = limb(0.28, 0.86, 0.28, P.jacket), armR = limb(0.28, 0.86, 0.28, P.jacket);
    armL.position.set(-0.6, 1.74, 0); armR.position.set(0.6, 1.74, 0);
    const head = box(0.56, 0.56, 0.56, P.face); head.position.y = 2.1;
    const helmet = box(0.66, 0.26, 0.66, P.helmet); helmet.position.y = 2.4;
    const swordMesh = makeSword(); armR.add(swordMesh);
    const pistolMesh = makePistol(); pistolMesh.visible = false; armR.add(pistolMesh);
    g.add(legL, legR, torso, armL, armR, head, helmet);
    g.position.copy(cfg.pos);
    g.visible = false;
    scene.add(g);
    const f = {
      name: cfg.name, isPlayer: !!cfg.isPlayer, group: g,
      legL, legR, armL, armR, swordMesh, pistolMesh,
      maxHp: cfg.hp, hp: cfg.hp, weapon: cfg.weapon, speed: cfg.speed,
      cdTimer: 0, atkAnim: 0, hurt: 0, regenAcc: 0,
      moving: false, facing: 0, walkPhase: 0,
      target: null, attackTarget: null, dead: false, deadTimer: 0,
      connected: false, networked: false, netTarget: null,
      bar: makeBar(cfg.barColor)
    };
    updateWeaponVis(f);
    return f;
  }
  function updateWeaponVis(f) {
    if (f.swordMesh) f.swordMesh.visible = !f.weapon.ranged;
    if (f.pistolMesh) f.pistolMesh.visible = !!f.weapon.ranged;
  }

  const player = makeFighter({
    name: "You", isPlayer: true, palette: LIGHT, pos: new THREE.Vector3(-12, 0, 4),
    hp: 100, weapon: WEAPONS.sword, speed: 6.5, barColor: "#f0f0f0"
  });
  const enemy = makeFighter({
    name: "Raider", palette: DARK, pos: new THREE.Vector3(12, 0, -4),
    hp: 100, weapon: AI_WEAPON, speed: 4.6, barColor: "#8c8c8c"
  });
  const AI_AGGRO = 14;

  // -- State ----------------------------------------------------------------
  let perspective = "offline"; // offline | player
  let controllable = false;
  let localUserId = null;
  let matchPhase = "offline";
  let resultSent = false;
  let emitAcc = 0;

  // -- Combat ---------------------------------------------------------------
  const ARRIVE = 0.06;
  const bullets = [];

  function moveStep(f, tx, tz, dt) {
    const dx = tx - f.group.position.x, dz = tz - f.group.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= ARRIVE) return true;
    const step = Math.min(f.speed * dt, dist);
    const lim = MAP_HALF - 0.5;
    f.group.position.x = Math.max(-lim, Math.min(lim, f.group.position.x + dx / dist * step));
    f.group.position.z = Math.max(-lim, Math.min(lim, f.group.position.z + dz / dist * step));
    f.facing = Math.atan2(dx, dz);
    f.walkPhase += dt * f.speed * 1.6;
    f.moving = true;
    return false;
  }
  function applyDamage(def, dmg) {
    if (def.dead) return;
    def.hp = Math.max(0, def.hp - dmg);
    def.hurt = 0.18;
    if (def.hp <= 0) killFighter(def);
  }
  function fireBullet(att, def, dmg, deal) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    const fx = Math.sin(att.facing), fz = Math.cos(att.facing);
    b.position.set(att.group.position.x + fx * 0.8, 1.5, att.group.position.z + fz * 0.8);
    scene.add(b);
    bullets.push({
      mesh: b, def: deal ? def : null, dmg, speed: 46,
      target: new THREE.Vector3(def.group.position.x, 1.45, def.group.position.z)
    });
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
  // Local player attacking the opponent.
  function playerAttack(def) {
    if (player.cdTimer > 0 || def.dead || player.hp <= 0) return;
    const w = player.weapon;
    player.cdTimer = w.cd;
    player.atkAnim = 0.32;
    const dmg = Math.max(1, Math.round(w.atk + (Math.random() * 2 - 1) * w.atkVar));
    if (enemy.networked) {
      // Networked: don't touch opponent HP locally (they own it); just signal.
      if (w.ranged) fireBullet(player, def, dmg, false);
      options.onAttack?.({ weapon: w.id, dmg, ranged: !!w.ranged });
    } else {
      if (w.ranged) fireBullet(player, def, dmg, true);
      else applyDamage(def, dmg);
    }
  }
  // AI opponent attacking the player (solo demo only).
  function aiAttack() {
    if (enemy.cdTimer > 0 || player.dead || enemy.hp <= 0) return;
    const w = enemy.weapon;
    enemy.cdTimer = w.cd;
    enemy.atkAnim = 0.32;
    const dmg = Math.max(1, Math.round(w.atk + (Math.random() * 2 - 1) * w.atkVar));
    applyDamage(player, dmg);
  }
  function shootAt(target) {
    if (player.dead || target.dead) return;
    const dx = target.group.position.x - player.group.position.x;
    const dz = target.group.position.z - player.group.position.z;
    player.facing = Math.atan2(dx, dz);
    player.moving = false;
    if (Math.hypot(dx, dz) <= player.weapon.range) playerAttack(target);
  }
  function killFighter(f) {
    f.dead = true;
    f.moving = false;
    f.deadTimer = f.isPlayer ? 1.8 : 2.2;
  }
  function handleDead(f, dt) {
    f.group.rotation.z = Math.min(Math.PI / 2, f.group.rotation.z + dt * 5);
    f.group.position.y = Math.max(-0.5, f.group.position.y - dt * 0.7);
    if (enemy.networked) return; // networked deaths wait for the match to reset
    f.deadTimer -= dt;
    if (f.deadTimer <= 0) respawn(f);
  }
  function respawn(f) {
    f.hp = f.maxHp;
    f.dead = false;
    f.group.rotation.z = 0;
    f.group.position.y = 0;
    f.cdTimer = 0;
    f.atkAnim = 0;
    f.hurt = 0;
    f.moving = false;
    if (f.isPlayer) {
      f.group.position.set(-12, 0, 4);
      f.attackTarget = null;
      f.target = null;
      camCenter.set(-12, 0, 4);
    } else {
      let rx, rz;
      do {
        rx = (Math.random() * 2 - 1) * (MAP_HALF - 4);
        rz = (Math.random() * 2 - 1) * (MAP_HALF - 4);
      } while (Math.hypot(rx - player.group.position.x, rz - player.group.position.z) < 12);
      f.group.position.set(rx, 0, rz);
    }
  }
  function regen(f, dt) {
    if (f.hp >= f.maxHp || f.dead) { f.regenAcc = 0; return; }
    f.regenAcc += dt;
    if (f.regenAcc >= 2) {
      const add = Math.floor(f.regenAcc / 2);
      f.hp = Math.min(f.maxHp, f.hp + add);
      f.regenAcc -= add * 2;
    }
  }

  function updatePlayer(dt) {
    const p = player;
    if (p.dead) { handleDead(p, dt); return; }
    if (p.cdTimer > 0) p.cdTimer -= dt;
    if (p.atkAnim > 0) p.atkAnim -= dt;
    regen(p, dt);
    p.moving = false;
    if (!controllable) return;
    if (!p.weapon.ranged && p.attackTarget && !p.attackTarget.dead) {
      const e = p.attackTarget;
      const dx = e.group.position.x - p.group.position.x;
      const dz = e.group.position.z - p.group.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > p.weapon.range) moveStep(p, e.group.position.x, e.group.position.z, dt);
      else { p.facing = Math.atan2(dx, dz); playerAttack(e); }
    } else {
      p.attackTarget = null;
      if (p.target) {
        if (moveStep(p, p.target.x, p.target.z, dt)) p.target = null;
      }
    }
  }
  function updateEnemy(dt) {
    const e = enemy;
    if (e.dead) { handleDead(e, dt); return; }
    if (e.cdTimer > 0) e.cdTimer -= dt;
    if (e.atkAnim > 0) e.atkAnim -= dt;
    e.moving = false;

    if (e.networked) {
      // Driven by remote snapshots; just glide toward the latest position.
      if (e.netTarget) moveStep(e, e.netTarget.x, e.netTarget.z, dt);
      return;
    }
    // Solo demo: simple AI raider.
    regen(e, dt);
    if (player.dead || !controllable) return;
    const dx = player.group.position.x - e.group.position.x;
    const dz = player.group.position.z - e.group.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= AI_AGGRO) {
      if (dist > e.weapon.range) moveStep(e, player.group.position.x, player.group.position.z, dt);
      else { e.facing = Math.atan2(dx, dz); aiAttack(); }
    }
  }
  function updateVisual(f, dt) {
    if (f.dead) return;
    let da = f.facing - f.group.rotation.y;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    f.group.rotation.y += da * Math.min(1, dt * 12);
    const ease = Math.min(1, dt * 10);
    if (f.atkAnim > 0) {
      const k = 1 - f.atkAnim / 0.32;
      if (f.weapon.ranged) {
        f.armR.rotation.x = -1.25 * Math.sin(k * Math.PI);
      } else {
        f.armR.rotation.x = k < 0.4 ? -2 * (k / 0.4) : -2 + 2.9 * ((k - 0.4) / 0.6);
      }
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
    if (!f.connected || f.dead) { f.bar.el.style.display = "none"; return; }
    const rect = mount.getBoundingClientRect();
    _bv.set(f.group.position.x, 3.05, f.group.position.z).project(camera);
    if (_bv.z > 1) { f.bar.el.style.display = "none"; return; }
    f.bar.el.style.display = "block";
    f.bar.el.style.left = (rect.left + (_bv.x * 0.5 + 0.5) * rect.width) + "px";
    f.bar.el.style.top = (rect.top + (-_bv.y * 0.5 + 0.5) * rect.height) + "px";
    f.bar.fill.style.width = (Math.max(0, f.hp / f.maxHp) * 100) + "%";
    f.bar.fill.style.background = f.hurt > 0 ? "#ffffff" : f.bar.color;
    const ic = f.weapon.ranged ? "⌖" : "⚔";
    f.bar.name.textContent = `${f.name}  ${f.hp}/${f.maxHp}  ${ic}`;
  }

  // -- Picking: tap = move/attack, drag = pan -------------------------------
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const _hit = new THREE.Vector3();
  function handleTap(cx, cy) {
    if (!controllable || player.dead) return;
    const rect = mount.getBoundingClientRect();
    pointer.x = ((cx - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((cy - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    if (enemy.connected && !enemy.dead && raycaster.intersectObject(enemy.group, true).length) {
      following = true;
      setMarker(enemy.group.position.x, enemy.group.position.z, 0xbbbbbb, 0xffffff);
      if (player.weapon.ranged) { player.attackTarget = null; shootAt(enemy); }
      else player.attackTarget = enemy;
      return;
    }
    const hit = raycaster.ray.intersectPlane(groundPlane, _hit);
    if (hit) {
      const lim = MAP_HALF - TILE / 2;
      let tx = Math.max(-lim, Math.min(lim, (Math.floor(hit.x / TILE) + 0.5) * TILE));
      let tz = Math.max(-lim, Math.min(lim, (Math.floor(hit.z / TILE) + 0.5) * TILE));
      player.attackTarget = null;
      player.target = new THREE.Vector3(tx, 0, tz);
      following = true;
      setMarker(tx, tz, 0xffffff, 0xffffff);
    }
  }

  let isDown = false, dragging = false;
  let sx = 0, sy = 0, lx = 0, ly = 0;
  const panRight = new THREE.Vector3(), panUp = new THREE.Vector3();
  const canvas = renderer.domElement;
  canvas.addEventListener("pointerdown", (e) => { isDown = true; dragging = false; sx = lx = e.clientX; sy = ly = e.clientY; });
  window.addEventListener("pointermove", (e) => {
    if (!isDown) return;
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
  window.addEventListener("pointerup", (e) => {
    if (!isDown) return;
    isDown = false;
    if (!dragging) handleTap(e.clientX, e.clientY);
  });
  const ZOOM_MIN = 0.4, ZOOM_MAX = 3.2;
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    camera.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, camera.zoom * Math.exp(-e.deltaY * 0.0012)));
    camera.updateProjectionMatrix();
  }, { passive: false });

  // -- Weapon hotbar --------------------------------------------------------
  const hotbar = document.createElement("div");
  hotbar.className = "hotbar";
  const slotDefs = [
    { n: 1, weapon: "sword", glyph: "⚔" },
    { n: 2, weapon: "pistol", glyph: "🔫" },
    { n: 3, glyph: "" }, { n: 4, glyph: "" }, { n: 5, glyph: "" }
  ];
  const slots = slotDefs.map((d) => {
    const s = document.createElement("button");
    s.type = "button";
    s.className = "slot" + (d.n === 1 ? " active" : "");
    s.innerHTML = `<span class="emoji">${d.glyph}</span><span class="num">${d.n}</span>`;
    if (d.weapon) s.addEventListener("click", () => selectSlot(d.n));
    hotbar.appendChild(s);
    return s;
  });
  mount.appendChild(hotbar);
  let activeSlot = 1;
  function selectSlot(n) {
    const def = slotDefs[n - 1];
    if (!def || !def.weapon) return;
    activeSlot = n;
    slots.forEach((s, i) => s.classList.toggle("active", i === n - 1));
    player.weapon = WEAPONS[def.weapon];
    if (def.weapon === "pistol") player.attackTarget = null;
    updateWeaponVis(player);
  }
  window.addEventListener("keydown", (e) => {
    if (e.key >= "1" && e.key <= "5") selectSlot(parseInt(e.key, 10));
  });

  // -- Overlay cards (Side A / Side B / Match state) ------------------------
  const overlay = document.createElement("div");
  overlay.className = "arena-overlay";
  overlay.innerHTML = `
    <div class="arena-card"><div class="title">Side A</div><div class="value" id="aHp">--</div></div>
    <div class="arena-card"><div class="title">Side B</div><div class="value" id="bHp">--</div></div>
    <div class="arena-card"><div class="title">Match State</div><div class="value" id="mState">Offline</div></div>`;
  mount.appendChild(overlay);
  const aHpEl = overlay.querySelector("#aHp");
  const bHpEl = overlay.querySelector("#bHp");
  const mStateEl = overlay.querySelector("#mState");

  // -- Minimap --------------------------------------------------------------
  const mm = document.createElement("canvas");
  mm.className = "arena-minimap";
  mount.appendChild(mm);
  const MM = 150;
  const mmDpr = Math.min(window.devicePixelRatio, 2);
  mm.width = MM * mmDpr; mm.height = MM * mmDpr;
  const mmCtx = mm.getContext("2d");
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
    mmCtx.fillStyle = "rgba(255,255,255,0.02)";
    mmCtx.fillRect(0, 0, MM, MM);
    mmCtx.strokeStyle = "rgba(255,255,255,0.08)";
    mmCtx.lineWidth = 1;
    for (let g = -MAP_HALF; g <= MAP_HALF + 0.01; g += TILE * 5) {
      const p = wToMM(g);
      mmCtx.beginPath(); mmCtx.moveTo(p, 0); mmCtx.lineTo(p, MM); mmCtx.stroke();
      mmCtx.beginPath(); mmCtx.moveTo(0, p); mmCtx.lineTo(MM, p); mmCtx.stroke();
    }
    mmCtx.strokeStyle = "rgba(255,255,255,0.5)";
    mmCtx.lineWidth = 1.5;
    mmCtx.strokeRect(0.75, 0.75, MM - 1.5, MM - 1.5);
    if (enemy.connected && !enemy.dead) {
      mmCtx.fillStyle = "#9a9a9a";
      mmCtx.beginPath();
      mmCtx.arc(wToMM(enemy.group.position.x), wToMM(enemy.group.position.z), 3.5, 0, Math.PI * 2);
      mmCtx.fill();
    }
    if (player.connected && !player.dead) {
      arrow(mmCtx, wToMM(player.group.position.x), wToMM(player.group.position.z), player.group.rotation.y, "#ffffff");
    }
  }

  // -- Hint -----------------------------------------------------------------
  const hint = document.createElement("div");
  hint.className = "arena-hint";
  hint.innerHTML = '<span class="key">click</span> move &middot; <span class="key">click rival</span> attack &middot; <span class="key">drag</span> pan &middot; <span class="key">scroll</span> zoom &middot; <span class="key">1/2</span> weapon';
  mount.appendChild(hint);
  setTimeout(() => { hint.style.opacity = "0"; }, 6000);

  // -- Attack cursor --------------------------------------------------------
  const CURSOR_ATTACK = "url(\"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='32'%20height='32'%20viewBox='0%200%2032%2032'%3E%3Cg%20fill='none'%20stroke='%23ffffff'%20stroke-width='2.5'%20stroke-linecap='round'%3E%3Ccircle%20cx='16'%20cy='16'%20r='8'/%3E%3Cpath%20d='M16%202v5M16%2025v5M2%2016h5M25%2016h5'/%3E%3C/g%3E%3C/svg%3E\") 16 16, crosshair";
  let cursorAttack = false;
  function setCursor(on) {
    if (on === cursorAttack) return;
    cursorAttack = on;
    canvas.style.cursor = on ? CURSOR_ATTACK : "default";
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

  // -- Loop -----------------------------------------------------------------
  let destroyed = false;
  const clock = new THREE.Clock();
  function animate() {
    if (destroyed) return;
    const dt = Math.min(clock.getDelta(), 0.05);

    updatePlayer(dt);
    updateEnemy(dt);
    updateVisual(player, dt);
    updateVisual(enemy, dt);
    updateBullets(dt);

    // Emit local state for networked play.
    if (perspective === "player") {
      emitAcc += dt * 1000;
      if (emitAcc >= EMIT_MS) {
        emitAcc = 0;
        options.onLocalState?.({
          x: +player.group.position.x.toFixed(2),
          z: +player.group.position.z.toFixed(2),
          hp: player.hp,
          maxHp: player.maxHp,
          facing: +player.facing.toFixed(2),
          weapon: player.weapon.id,
          name: player.name
        });
      }
      if (enemy.networked && !resultSent) {
        if (player.hp <= 0) { resultSent = true; options.onResultSuggestion?.("loss"); }
        else if (enemy.connected && enemy.hp <= 0) { resultSent = true; options.onResultSuggestion?.("win"); }
      }
    }

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
      if (sp[i * 3 + 1] < 0) {
        sp[i * 3 + 1] = SNOW_TOP;
        sp[i * 3] = (Math.random() - 0.5) * SNOW_AREA;
        sp[i * 3 + 2] = (Math.random() - 0.5) * SNOW_AREA;
      }
    }
    snowGeo.attributes.position.needsUpdate = true;
    snow.position.set(camCenter.x, 0, camCenter.z);

    if (markerLife > 0) {
      markerLife = Math.max(0, markerLife - dt * 1.4);
      markerFill.material.opacity = markerLife * 0.22;
      markerEdge.material.opacity = markerLife * 0.95;
      const s = 1 + (1 - markerLife) * 0.3;
      marker.scale.set(s, s, 1);
    }

    player.group.visible = player.connected;
    enemy.group.visible = enemy.connected;

    updateBar(player);
    updateBar(enemy);
    setCursor(controllable && !player.dead && ((player.attackTarget && !player.attackTarget.dead) || player.atkAnim > 0));

    aHpEl.textContent = player.connected ? `${player.hp} / ${player.maxHp} HP` : "--";
    bHpEl.textContent = enemy.connected ? `${enemy.hp} / ${enemy.maxHp} HP` : "Waiting for rival";
    mStateEl.textContent = labelPhase(matchPhase);

    drawMinimap();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  function labelPhase(p) {
    if (p === "active") return "In combat";
    if (p === "waiting") return "Waiting";
    return "Offline";
  }

  // -- Public API -----------------------------------------------------------
  return {
    setMode(mode) {
      perspective = mode;
      controllable = mode === "player";
      if (mode === "offline") {
        enemy.networked = false;
        enemy.connected = true; // AI raider available for solo practice
        player.connected = true;
      }
    },
    setMatchPhase(phase) {
      matchPhase = phase;
    },
    setPlayerPerspective({ userId, displayName }) {
      perspective = "player";
      controllable = true;
      localUserId = userId;
      player.name = displayName || "You";
      player.connected = true;
    },
    setRemoteIdentity({ userId, displayName }) {
      enemy.name = displayName || "Rival";
      enemy.networked = true;
      enemy.connected = true;
      enemy.netTarget = { x: enemy.group.position.x, z: enemy.group.position.z };
    },
    clearRemote() {
      // Fall back to the AI raider so the demo stays playable while waiting.
      enemy.networked = false;
      enemy.connected = true;
      enemy.name = "Raider";
      enemy.weapon = AI_WEAPON;
    },
    resetForMatch() {
      resultSent = false;
      bullets.splice(0).forEach((b) => scene.remove(b.mesh));
      Object.assign(player, { hp: player.maxHp, dead: false, cdTimer: 0, atkAnim: 0, hurt: 0, moving: false, attackTarget: null, target: null });
      player.group.rotation.set(0, player.group.rotation.y, 0);
      player.group.position.set(-12, 0, 4);
      player.connected = true;
      Object.assign(enemy, { hp: enemy.maxHp, dead: false, cdTimer: 0, atkAnim: 0, hurt: 0, moving: false });
      enemy.group.rotation.set(0, enemy.group.rotation.y, 0);
      enemy.group.position.set(12, 0, -4);
      enemy.netTarget = { x: 12, z: -4 };
      camCenter.set(-12, 0, 4);
      following = true;
    },
    receivePlayerState(snap) {
      if (!snap || !enemy.networked) return;
      enemy.connected = true;
      enemy.netTarget = { x: clamp(snap.x, -MAP_HALF, MAP_HALF), z: clamp(snap.z, -MAP_HALF, MAP_HALF) };
      enemy.hp = clamp(snap.hp ?? enemy.hp, 0, enemy.maxHp);
      enemy.maxHp = snap.maxHp ?? enemy.maxHp;
      if (typeof snap.facing === "number") enemy.facing = snap.facing;
      if (snap.weapon && WEAPONS[snap.weapon]) { enemy.weapon = WEAPONS[snap.weapon]; updateWeaponVis(enemy); }
      if (snap.name) enemy.name = snap.name;
      if (enemy.hp <= 0 && !enemy.dead) killFighter(enemy);
    },
    receiveAttack(payload) {
      if (!payload || !enemy.networked || player.dead) return;
      enemy.atkAnim = 0.32;
      if (payload.ranged) fireBullet(enemy, player, payload.dmg || 0, true);
      else applyDamage(player, payload.dmg || 0);
    },
    clearAll() {
      perspective = "offline";
      controllable = false;
      enemy.networked = false;
      enemy.connected = false;
      enemy.name = "Raider";
      player.connected = false;
      player.bar.el.style.display = "none";
      enemy.bar.el.style.display = "none";
    },
    destroy() {
      destroyed = true;
      ro.disconnect();
      player.bar.el.remove();
      enemy.bar.el.remove();
      renderer.dispose();
      mount.innerHTML = "";
    }
  };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function stubApi() {
  const noop = () => {};
  return {
    setMode: noop, setMatchPhase: noop, setPlayerPerspective: noop,
    setRemoteIdentity: noop, clearRemote: noop, resetForMatch: noop,
    receivePlayerState: noop, receiveAttack: noop, clearAll: noop, destroy: noop
  };
}
