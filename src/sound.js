// Lightweight sound-effect player for the arena.
//
// Each clip is preloaded once and played from a small pool of cloned Audio
// elements so rapid, overlapping events (a burst of pistol fire, two fighters
// dying at once) layer instead of cutting each other off. Everything is
// best-effort: a missing file or a browser autoplay block is swallowed so
// audio can never stall or throw inside the per-frame game loop.
//
// Files live in the Vite public dir (`assets/`, see vite.config.js), so they
// are served from the site root under /sounds/.

const FILES = {
  pistol: "/sounds/pistol.mp3", // ranged: pistol shot
  sniper: "/sounds/sniper.mp3", // ranged: charged sniper shot
  melee:  "/sounds/melee.mp3",  // sword swing / strike
  frag:   "/sounds/frag.mp3",   // grenade detonation
  dead:   "/sounds/dead.mp3",   // a fighter is killed
};

// The water splash is a sustained loop (played while wading), not a one-shot,
// so it gets its own dedicated element rather than a pool.
const WATER_SRC = "/sounds/water.mp3";
const WATER_VOLUME = 0.4;

// Per-clip mix so the loud ones (frag, sniper) don't drown the game.
const VOLUME = {
  pistol: 0.5,
  sniper: 0.6,
  melee:  0.55,
  frag:   0.75,
  dead:   0.7,
};

const POOL_SIZE = 4;

let enabled = true;
let initialized = false;
const pools = {};

let waterEl = null;   // looping wade sound
let waterOn = false;  // is the loop currently meant to be playing

// Build the Audio pool for one clip. The first element loads the resource; the
// rest are clones so they share the buffer without extra network requests.
function makePool(src) {
  const base = new Audio(src);
  base.preload = "auto";
  const pool = [base];
  for (let i = 1; i < POOL_SIZE; i++) pool.push(base.cloneNode());
  return { pool, idx: 0 };
}

// Preload every clip. Safe to call more than once; only the first call builds
// the pools. Best invoked from a user gesture (e.g. match start) so the browser
// permits the later playback.
export function initSfx() {
  if (initialized) return;
  initialized = true;
  try {
    for (const key in FILES) pools[key] = makePool(FILES[key]);
    // The water loop is the largest clip by far and is only heard when a player
    // wades into the river — often never in a match. preload="none" defers the
    // download until the first setWaterLoop(true) calls play(), instead of
    // fetching it up front on every match start.
    waterEl = new Audio(WATER_SRC);
    waterEl.preload = "none";
    waterEl.loop = true;
    waterEl.volume = WATER_VOLUME;
  } catch {
    // Audio unavailable (very old / headless environment) — stay silent.
  }
}

export function setSfxEnabled(on) {
  enabled = !!on;
  // Muting must silence the sustained water loop too, not just future one-shots.
  if (!enabled && waterEl) { try { waterEl.pause(); } catch {} }
  else if (enabled && waterOn) setWaterLoop(true);
}

// Start or stop the looping wade sound. Called every frame with the current
// "player is moving through water" state; guarded so it only touches the
// element on an actual transition.
export function setWaterLoop(active) {
  active = !!active;
  waterOn = active;
  if (!initialized || !waterEl) return;
  if (active && enabled) {
    if (waterEl.paused) {
      try {
        const r = waterEl.play();
        if (r && typeof r.catch === "function") r.catch(() => {});
      } catch {}
    }
  } else if (!waterEl.paused) {
    try { waterEl.pause(); } catch {}
  }
}

// Play a clip by key. No-op when muted, uninitialized, or the key is unknown.
export function playSfx(key) {
  if (!enabled || !initialized) return;
  const p = pools[key];
  if (!p) return;
  const el = p.pool[p.idx];
  p.idx = (p.idx + 1) % p.pool.length;
  try {
    el.currentTime = 0;
    el.volume = VOLUME[key] ?? 0.6;
    const r = el.play();
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch {
    // Ignore — audio must never interrupt gameplay.
  }
}
