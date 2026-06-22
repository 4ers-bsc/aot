const WORLD_SIZE = 100;
const PLAYER_RADIUS = 3;
const STATE_EMIT_MS = 90;

const WEAPONS = {
  sword: { id: "sword", label: "Sword", emoji: "⚔", color: "#89d078", range: 9, damage: 22, cooldown: 650, bullet: false },
  pistol: { id: "pistol", label: "Pistol", emoji: "🔫", color: "#f0c06f", range: 25, damage: 12, cooldown: 460, bullet: true, bulletSpeed: 78 }
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function normalize(vector) {
  const len = Math.hypot(vector.x, vector.y) || 1;
  return { x: vector.x / len, y: vector.y / len };
}

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createDefaultEntity(name, x) {
  return {
    userId: null,
    x,
    y: 50,
    hp: 100,
    maxHp: 100,
    weaponId: "sword",
    displayName: name,
    connected: false
  };
}

export function createArenaGame(options) {
  const mount = options.mount;
  mount.innerHTML = "";

  const canvas = document.createElement("canvas");
  const overlay = document.createElement("div");
  const hotbar = document.createElement("div");
  overlay.className = "arena-overlay";
  hotbar.className = "hotbar";
  mount.append(canvas, overlay, hotbar);

  const localCard = document.createElement("div");
  localCard.className = "arena-card";
  localCard.innerHTML = '<div class="title">Side A</div><div class="value" id="localHealth">100 / 100 HP</div>';
  const remoteCard = document.createElement("div");
  remoteCard.className = "arena-card";
  remoteCard.innerHTML = '<div class="title">Side B</div><div class="value" id="remoteHealth">Waiting for player</div>';
  const matchCard = document.createElement("div");
  matchCard.className = "arena-card";
  matchCard.innerHTML = '<div class="title">Match State</div><div class="value" id="matchStateText">Offline practice</div>';
  overlay.append(localCard, remoteCard, matchCard);

  const localHealthEl = localCard.querySelector("#localHealth");
  const remoteHealthEl = remoteCard.querySelector("#remoteHealth");
  const matchStateTextEl = matchCard.querySelector("#matchStateText");

  const ctx = canvas.getContext("2d");
  const local = createDefaultEntity("You", 24);
  const remote = createDefaultEntity("Opponent", 76);

  let weaponOrder = ["sword", "pistol"];
  let activeWeapon = weaponOrder[0];
  let matchPhase = "offline";
  let perspective = "offline";
  let processedEvents = new Set();
  const bullets = [];

  let destroyed = false;
  let lastFrame = performance.now();
  let lastEmit = 0;
  let lastKnownRemoteState = null;

  function renderSlots() {
    hotbar.innerHTML = "";
    weaponOrder.forEach((weaponId, index) => {
      const weapon = WEAPONS[weaponId];
      const button = document.createElement("button");
      button.className = "slot";
      button.type = "button";
      button.innerHTML = `<span class="emoji">${weapon.emoji}</span><span class="meta">${index + 1} · ${weapon.label}</span>`;
      button.classList.toggle("active", weaponId === activeWeapon);
      button.disabled = perspective !== "player";
      button.addEventListener("click", () => {
        if (perspective !== "player") return;
        selectWeapon(weaponId);
      });
      hotbar.appendChild(button);
    });
  }

  function selectWeapon(weaponId) {
    if (!weaponOrder.includes(weaponId)) return;
    activeWeapon = weaponId;
    local.weaponId = weaponId;
    renderSlots();
    emitState(true);
  }

  function applyLoadout(primaryItemId, secondaryItemId) {
    const filtered = [primaryItemId, secondaryItemId].filter((itemId) => WEAPONS[itemId]);
    weaponOrder = filtered.length ? Array.from(new Set(filtered)) : ["sword", "pistol"];
    if (!weaponOrder.includes(activeWeapon)) {
      activeWeapon = weaponOrder[0];
      local.weaponId = activeWeapon;
    }
    renderSlots();
  }

  applyLoadout("sword", "pistol");

  function resize() {
    const rect = mount.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function worldToCanvas(point) {
    const rect = mount.getBoundingClientRect();
    return {
      x: (point.x / WORLD_SIZE) * rect.width,
      y: (point.y / WORLD_SIZE) * rect.height
    };
  }

  function canvasToWorld(clientX, clientY) {
    const rect = mount.getBoundingClientRect();
    const x = clamp(((clientX - rect.left) / rect.width) * WORLD_SIZE, 0, WORLD_SIZE);
    const y = clamp(((clientY - rect.top) / rect.height) * WORLD_SIZE, 0, WORLD_SIZE);
    return { x, y };
  }

  function hitRemote(worldPoint) {
    if (!remote.connected) return false;
    return distance(worldPoint, remote) <= PLAYER_RADIUS * 1.8;
  }

  function handlePointer(clientX, clientY) {
    if (perspective !== "player") return;
    const world = canvasToWorld(clientX, clientY);
    if (hitRemote(world)) {
      if (!remote.connected || local.hp <= 0 || remote.hp <= 0) return;
      local.attackTarget = true;
      local.moveTarget = null;
      return;
    }
    local.attackTarget = false;
    local.moveTarget = world;
    emitState(true);
  }

  canvas.addEventListener("pointerdown", (event) => {
    handlePointer(event.clientX, event.clientY);
  });

  window.addEventListener("resize", resize);
  resize();

  function emitState(force = false) {
    if (perspective !== "player") return;
    const now = performance.now();
    if (!force && now - lastEmit < STATE_EMIT_MS) return;
    lastEmit = now;
    options.onLocalState?.({
      x: Number(local.x.toFixed(2)),
      y: Number(local.y.toFixed(2)),
      hp: local.hp,
      maxHp: local.maxHp,
      weaponId: local.weaponId,
      displayName: local.displayName
    });
  }

  function queueBullet(origin, target, color, speed, onHit) {
    bullets.push({
      x: origin.x,
      y: origin.y,
      tx: target.x,
      ty: target.y,
      color,
      speed,
      onHit
    });
  }

  function tryLocalAttack() {
    if (perspective !== "player") return;
    if (!remote.connected || local.hp <= 0 || remote.hp <= 0) return;
    const weapon = WEAPONS[local.weaponId];
    const dist = distance(local, remote);

    if (dist > weapon.range) {
      local.moveTarget = { x: remote.x, y: remote.y };
      return;
    }

    const now = performance.now();
    if (now < local.cooldownUntil) return;
    local.cooldownUntil = now + weapon.cooldown;
    local.attackTarget = false;
    local.moveTarget = null;

    const attackEvent = {
      id: randomId(),
      attackerId: local.userId,
      targetId: remote.userId,
      weaponId: weapon.id,
      damage: weapon.damage,
      range: weapon.range,
      origin: { x: Number(local.x.toFixed(2)), y: Number(local.y.toFixed(2)) },
      sentAt: Date.now()
    };

    if (weapon.bullet) {
      queueBullet(local, remote, weapon.color, weapon.bulletSpeed, () => {});
    }

    options.onAttack?.(attackEvent);
  }

  function applyAttackEvent(event) {
    if (!event || processedEvents.has(event.id)) return;
    processedEvents.add(event.id);
    if (processedEvents.size > 400) {
      processedEvents = new Set(Array.from(processedEvents).slice(-200));
    }

    const weapon = WEAPONS[event.weaponId] || WEAPONS.sword;
    if (perspective === "spectator") {
      const from = event.attackerId === local.userId ? local : remote;
      const to = event.targetId === local.userId ? local : remote;
      if (!from.userId || !to.userId) return;
      if (weapon.bullet) {
        queueBullet(from, to, "#ff8f70", weapon.bulletSpeed, () => {});
      }
      return;
    }

    if (!local.userId || event.targetId !== local.userId || local.hp <= 0) return;
    if (!lastKnownRemoteState) return;
    const attackerDrift = distance(event.origin, lastKnownRemoteState);
    if (attackerDrift > 8) return;

    const dist = distance(event.origin, local);
    if (dist > event.range + 5) return;

    if (weapon.bullet) {
      queueBullet(event.origin, local, "#ff8f70", weapon.bulletSpeed, () => {
        local.hp = clamp(local.hp - event.damage, 0, local.maxHp);
        emitState(true);
        if (local.hp === 0) options.onResultSuggestion?.("loss");
      });
      return;
    }

    local.hp = clamp(local.hp - event.damage, 0, local.maxHp);
    emitState(true);
    if (local.hp === 0) options.onResultSuggestion?.("loss");
  }

  function updateBullets(dt) {
    for (let i = bullets.length - 1; i >= 0; i -= 1) {
      const bullet = bullets[i];
      const vector = { x: bullet.tx - bullet.x, y: bullet.ty - bullet.y };
      const len = Math.hypot(vector.x, vector.y);
      const step = bullet.speed * dt;

      if (len <= step || len < 0.8) {
        bullets.splice(i, 1);
        bullet.onHit?.();
        continue;
      }

      const dir = normalize(vector);
      bullet.x += dir.x * step;
      bullet.y += dir.y * step;
    }
  }

  function updateMovement(dt) {
    if (perspective !== "player") return;
    const speed = 22;
    if (local.attackTarget) {
      tryLocalAttack();
    }

    if (!local.moveTarget) return;
    const vector = { x: local.moveTarget.x - local.x, y: local.moveTarget.y - local.y };
    const len = Math.hypot(vector.x, vector.y);
    if (len < 0.35) {
      local.moveTarget = null;
      emitState(true);
      return;
    }
    const dir = normalize(vector);
    local.x = clamp(local.x + dir.x * speed * dt, 0, WORLD_SIZE);
    local.y = clamp(local.y + dir.y * speed * dt, 0, WORLD_SIZE);
    emitState();
  }

  function drawGrid(width, height) {
    const spacing = width / 10;
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= width; x += spacing) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y <= height; y += spacing) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  function drawPawn(entity, color, accent, label, hpText) {
    if (!entity.connected) return;
    const point = worldToCanvas(entity);
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = "rgba(6,10,11,0.86)";
    ctx.fillRect(-36, -40, 72, 9);
    ctx.fillStyle = accent;
    ctx.fillRect(-36, -40, 72 * (entity.hp / entity.maxHp), 9);

    ctx.fillStyle = "#edf6ef";
    ctx.font = "700 13px IBM Plex Sans";
    ctx.textAlign = "center";
    ctx.fillText(label, 0, -48);
    ctx.fillStyle = "rgba(237,246,239,0.72)";
    ctx.font = "12px IBM Plex Sans";
    ctx.fillText(hpText, 0, 42);
    ctx.restore();
  }

  function render() {
    const rect = mount.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);

    const gradient = ctx.createLinearGradient(0, 0, 0, rect.height);
    gradient.addColorStop(0, "#dce6e6");
    gradient.addColorStop(1, "#a6b3b5");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, rect.width, rect.height);

    drawGrid(rect.width, rect.height);

    if (perspective === "player" && local.moveTarget) {
      const target = worldToCanvas(local.moveTarget);
      ctx.fillStyle = "rgba(55,168,73,0.16)";
      ctx.strokeStyle = "rgba(55,168,73,0.72)";
      ctx.beginPath();
      ctx.arc(target.x, target.y, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    drawPawn(local, "rgba(63,136,71,0.9)", "#cbf1b6", local.displayName, `${local.hp} HP`);
    drawPawn(remote, "rgba(194,72,72,0.88)", "#f9a7a7", remote.displayName, `${remote.hp} HP`);

    bullets.forEach((bullet) => {
      const point = worldToCanvas(bullet);
      ctx.fillStyle = bullet.color;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function tick(now) {
    if (destroyed) return;
    const dt = Math.min((now - lastFrame) / 1000, 0.05);
    lastFrame = now;
    updateMovement(dt);
    updateBullets(dt);
    render();
    localHealthEl.textContent = local.connected ? `${local.hp} / ${local.maxHp} HP` : "Waiting for player";
    remoteHealthEl.textContent = remote.connected ? `${remote.hp} / ${remote.maxHp} HP` : "Waiting for player";
    matchStateTextEl.textContent = matchPhase;
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);

  return {
    setMode(nextMode) {
      perspective = nextMode;
      renderSlots();
    },
    setMatchPhase(nextPhase) {
      matchPhase = nextPhase;
    },
    setLoadout(primaryItemId, secondaryItemId) {
      applyLoadout(primaryItemId, secondaryItemId);
    },
    setPlayerPerspective({ userId, displayName }) {
      perspective = "player";
      local.userId = userId;
      local.displayName = displayName || "You";
      local.connected = true;
      renderSlots();
      emitState(true);
    },
    setSpectatorCombatants(combatants) {
      perspective = "spectator";
      const [left, right] = combatants || [];
      if (left) {
        local.userId = left.userId;
        local.displayName = left.displayName || "Player One";
        local.connected = true;
      }
      if (right) {
        remote.userId = right.userId;
        remote.displayName = right.displayName || "Player Two";
        remote.connected = true;
      }
      renderSlots();
    },
    setRemoteIdentity({ userId, displayName }) {
      remote.userId = userId;
      remote.displayName = displayName || "Opponent";
      remote.connected = !!userId;
      render();
    },
    receivePlayerState(state) {
      if (!state) return;
      lastKnownRemoteState = { x: state.x, y: state.y };
      remote.connected = true;
      remote.x = clamp(state.x, 0, WORLD_SIZE);
      remote.y = clamp(state.y, 0, WORLD_SIZE);
      remote.hp = clamp(state.hp ?? remote.hp, 0, remote.maxHp);
      remote.maxHp = state.maxHp ?? remote.maxHp;
      remote.weaponId = state.weaponId || remote.weaponId;
      remote.displayName = state.displayName || remote.displayName;
      if (remote.hp === 0 && perspective === "player") {
        options.onResultSuggestion?.("win");
      }
    },
    receiveSpectatorState(userId, state) {
      if (!userId || !state) return;
      const entity = userId === local.userId ? local : userId === remote.userId ? remote : null;
      if (!entity) return;
      entity.connected = true;
      entity.x = clamp(state.x, 0, WORLD_SIZE);
      entity.y = clamp(state.y, 0, WORLD_SIZE);
      entity.hp = clamp(state.hp ?? entity.hp, 0, entity.maxHp);
      entity.maxHp = state.maxHp ?? entity.maxHp;
      entity.weaponId = state.weaponId || entity.weaponId;
      entity.displayName = state.displayName || entity.displayName;
    },
    receiveAttack(event) {
      applyAttackEvent(event);
    },
    resetForMatch() {
      Object.assign(local, {
        x: 24,
        y: 50,
        hp: 100,
        maxHp: 100,
        moveTarget: null,
        attackTarget: false,
        cooldownUntil: 0,
        connected: !!local.userId
      });
      Object.assign(remote, {
        x: 76,
        y: 50,
        hp: 100,
        maxHp: 100,
        connected: !!remote.userId
      });
      bullets.length = 0;
      emitState(true);
    },
    clearRemote() {
      remote.userId = null;
      remote.connected = false;
      remote.hp = 100;
      remote.maxHp = 100;
      remote.displayName = "Opponent";
      lastKnownRemoteState = null;
    },
    clearAll() {
      perspective = "offline";
      Object.assign(local, createDefaultEntity("You", 24), { moveTarget: null, attackTarget: false, cooldownUntil: 0 });
      Object.assign(remote, createDefaultEntity("Opponent", 76));
      bullets.length = 0;
      renderSlots();
    },
    destroy() {
      destroyed = true;
      window.removeEventListener("resize", resize);
      mount.innerHTML = "";
    }
  };
}
