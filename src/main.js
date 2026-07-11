// All dependencies are bundled from node_modules (NOT CDN imports), so the app
// never depends on a third-party CDN being reachable — and no third party can
// alter the code we run. The Ethereum lib (ethers) is still loaded lazily as a
// separate local chunk — see loadEthers().
import { createClient } from "@supabase/supabase-js";
import { importEthers, importDevtoolsDetector } from "./lazy-deps.js";
import { NETWORK, RPC_URL as ROBINHOOD_RPC_URL, txExplorerUrl } from "./network.js";
import { createArenaGame } from "./game.js";
import { escapeHtml } from "./utils.js";
import { mountViews } from "./views/index.js";
import { initHomeAnimations } from "./home-anim.js";
import { initHomeTutorial } from "./tutorial.js";
import { initAdmin } from "./admin.js";
import { APPEARANCE_PRESETS } from "./appearance.js";

mountViews();
initHomeAnimations();
// First-visit walkthrough — shows once when the home page loads (reveals after
// the boot splash lifts) and can be permanently dismissed via "Don't show again".
initHomeTutorial();

const SUPABASE_URL =
  import.meta.env?.VITE_SUPABASE_URL?.trim() || "https://sajvismyvcgaszjcafcr.supabase.co";
const SUPABASE_ANON_KEY =
  import.meta.env?.VITE_SUPABASE_ANON_KEY?.trim() || "";
if (!SUPABASE_ANON_KEY) console.error("VITE_SUPABASE_ANON_KEY is not set — Supabase calls will fail.");
const SIGN_IN_STATEMENT = "Sign in to FIGHT10 to play realtime PvP duels.";

// ---------------------------------------------------------------------------
// FIGHT10 Tokenomics constants
// Fill in FIGHT10_TOKEN and ESCROW_WALLET after deploying the ERC-20 token on
// Robinhood Chain + generating the escrow account. The network (mainnet) these
// live on is defined in network.js.
// ---------------------------------------------------------------------------
const FIGHT10_TOKEN   = import.meta.env?.VITE_FIGHT10_TOKEN?.trim()  || "<FIGHT10_TOKEN_ADDRESS>";
const ESCROW_WALLET   = import.meta.env?.VITE_ESCROW_WALLET?.trim()  || "<ESCROW_WALLET_ADDRESS>";
const ENTRY_FEE       = 2500;         // FIGHT10 tokens per player
const FIGHT10_DECIMALS = Number(import.meta.env?.VITE_FIGHT10_DECIMALS ?? 18); // standard ERC-20 decimals
const ENTRY_FEE_RAW   = BigInt(ENTRY_FEE) * BigInt(10) ** BigInt(FIGHT10_DECIMALS);
// Winner's share of the pot. MUST match f10treasurer's payout math
// ((total * 900) / 1000): every place the UI promises a prize derives from this.
const WINNER_SHARE    = 0.9;

// The ethers library (~350 KB) is only needed for deposits and balance
// checks, never to reach the menu — so it is dynamically imported on first
// use instead of at boot. Vite code-splits it into a separate chunk served
// from our own origin: nothing to download at boot, and no third-party CDN
// (the old esm.sh imports were a boot-hang and supply-chain risk). A failed
// chunk load just surfaces as a deposit/balance error message, and a later
// retry re-attempts the download.
let _ethersPromise = null;
function loadEthers() {
  if (!_ethersPromise) {
    _ethersPromise = importEthers().catch((err) => {
      _ethersPromise = null; // allow a retry on the next call
      throw new Error("Could not load the Ethereum libraries — check your connection and try again.");
    });
  }
  return _ethersPromise;
}

// Minimal ERC-20 surface the app needs: $FIGHT10 is a standard ERC-20 on
// Robinhood Chain, so transfer + balanceOf cover deposits and balance checks.
const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// Lazy singleton — one HTTP JSON-RPC provider for all read-only calls.
// staticNetwork skips the eth_chainId round-trip on every request.
let _readProvider = null;
async function getReadProvider() {
  const ethers = await loadEthers();
  if (!_readProvider) {
    _readProvider = new ethers.JsonRpcProvider(ROBINHOOD_RPC_URL, NETWORK.chainId, { staticNetwork: true });
  }
  return _readProvider;
}

async function getFight10Contract() {
  const ethers = await loadEthers();
  return new ethers.Contract(FIGHT10_TOKEN, ERC20_ABI, await getReadProvider());
}

// Wallet addresses are compared all over (login wallet vs deposit wallet,
// leaderboard rows vs the connected wallet). Ethereum addresses come in
// checksummed and lowercase forms, and Supabase may store a "chain:" prefix
// (e.g. "ethereum:0x…") — normalise to the lowercased trailing segment.
function normWallet(w) {
  return (w ?? "").trim().split(":").pop().trim().toLowerCase();
}

const els = {
  signInWalletBtn: document.getElementById("signInWalletBtn"),
  howToPlayBtn: document.getElementById("howToPlayBtn"),
  profileBtn: document.getElementById("profileBtn"),
  profileOverlay: document.getElementById("profileOverlay"),
  profileClose: document.getElementById("profileClose"),
  profileNameInput: document.getElementById("profileNameInput"),
  profileHint: document.getElementById("profileHint"),
  profileWins: document.getElementById("profileWins"),
  profileLosses: document.getElementById("profileLosses"),
  profileWinRate: document.getElementById("profileWinRate"),
  profileGames: document.getElementById("profileGames"),
  profileStreak: document.getElementById("profileStreak"),
  profileBest: document.getElementById("profileBest"),
  profileLevel: document.getElementById("profileLevel"),
  profilePoints: document.getElementById("profilePoints"),
  profileLevelFill: document.getElementById("profileLevelFill"),
  profileLevelNext: document.getElementById("profileLevelNext"),
  profileSaveBtn: document.getElementById("profileSaveBtn"),
  profileTabs: Array.from(document.querySelectorAll("[data-ptab]")),
  profileBodies: Array.from(document.querySelectorAll("[data-pbody]")),
  historyList: document.getElementById("historyList"),
  pfWins: document.getElementById("pfWins"),
  pfLosses: document.getElementById("pfLosses"),
  demoBtn: document.getElementById("demoBtn"),
  pvpBtn: document.getElementById("pvpBtn"),
  signOutBtn: document.getElementById("signOutBtn"),
  appStatus: document.getElementById("appStatus"),
  arenaMount: document.getElementById("arenaMount"),
  howToOverlay: document.getElementById("howToOverlay"),
  howToClose: document.getElementById("howToClose"),
  whitepaperBtn: document.getElementById("whitepaperBtn"),
  whitepaperOverlay: document.getElementById("whitepaperOverlay"),
  whitepaperClose: document.getElementById("whitepaperClose"),
  pauseOverlay: document.getElementById("pauseOverlay"),
  pauseClose: document.getElementById("pauseClose"),
  resumeBtn: document.getElementById("resumeBtn"),
  pauseHowToBtn: document.getElementById("pauseHowToBtn"),
  leaveMatchBtn: document.getElementById("leaveMatchBtn"),
  pvpSizeOverlay: document.getElementById("pvpSizeOverlay"),
  pvpSizeClose: document.getElementById("pvpSizeClose"),
  pvpSizeBtns: Array.from(document.querySelectorAll("[data-size]")),
  pvpLobby: document.getElementById("pvpLobby"),
  pvpLobbyStatus: document.getElementById("pvpLobbyStatus"),
  pvpLobbyMeta: document.getElementById("pvpLobbyMeta"),
  pvpLobbyWarning: document.getElementById("pvpLobbyWarning"),
  pvpLobbyOnline: document.getElementById("pvpLobbyOnline"),
  lobbyPlayers: document.getElementById("lobbyPlayers"),
  pvpCancelBtn: document.getElementById("pvpCancelBtn"),
  onlineCount: document.getElementById("onlineCount"),
  matchStarting: document.getElementById("matchStarting"),
  matchStartCount: document.getElementById("matchStartCount"),
  gameOver: document.getElementById("gameOver"),
  gameOverTitle: document.getElementById("gameOverTitle"),
  gameOverReason: document.getElementById("gameOverReason"),
  gameOverWins: document.getElementById("gameOverWins"),
  gameOverLosses: document.getElementById("gameOverLosses"),
  gameOverName: document.getElementById("gameOverName"),
  gameOverMenuBtn: document.getElementById("gameOverMenuBtn"),
  logFeed: document.getElementById("logFeed"),
  homePlayHint: document.getElementById("homePlayHint")
};

// createClient throws on an empty key, which would kill the whole module and
// strand the loading screen. A placeholder key lets the app reach the menu in a
// degraded state (every Supabase call fails visibly) instead of bricking boot.
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY || "anon-key-not-configured", {
  auth: { persistSession: true, autoRefreshToken: true }
});

// Internal ops dashboard (#admin or Ctrl/Cmd+Shift+A). Access is gated by the
// f10admin edge function's admin allowlist — non-admins just see "Not authorized".
initAdmin(supabase);

const state = {
  user: null,
  profile: null,
  match: null, // { id, mode: 'demo'|'pvp', status, finished, maxPlayers, matchNo }
  seat: null,
  remoteIds: new Set(),
  remoteNames: new Map(), // userId -> display_name, for disconnect/reconnect toasts
  remoteSeen: new Set(),  // every rival seen this match — re-adding one means a reconnect
  started: false,
  channel: null,
  iRoomFiller: false,
  pingInterval: null,
  depositPollTimer: null,
  startFallbackTimer: null,
  pendingDepositTx: null, // deposit sig saved across join retries so player never pays twice
  pendingDepositWallet: null, // wallet that signed the deposit, recorded with the seat for payout verification
  // Per-lobby match length, loaded from the match_config table (single source of
  // truth shared with the server). Seeded with the defaults as a fallback.
  matchDurations: { 2: 300, 5: 420, 10: 600 },
  presenceChannel: null,
};

// ---------------------------------------------------------------------------
// Pending-deposit persistence. A confirmed on-chain deposit that hasn't bought
// a seat yet must survive reloads/crashes — the fee is non-refundable, and
// before this the signature lived only in memory: a reload between "deposit
// confirmed" and "seat taken" stranded 2,500 $FIGHT10 in escrow with no way to
// retry. Keyed per user so one wallet's deposit can never leak to another.
// ---------------------------------------------------------------------------
function pendingDepositKey() {
  return state.user?.id ? `f10_pending_deposit_${state.user.id}` : null;
}
function savePendingDeposit(tx, wallet) {
  state.pendingDepositTx = tx || null;
  state.pendingDepositWallet = wallet || null;
  const key = pendingDepositKey();
  if (!key) return;
  try {
    if (tx) localStorage.setItem(key, JSON.stringify({ tx, wallet }));
    else localStorage.removeItem(key);
  } catch (_) { /* private browsing — in-memory copy still works this session */ }
}
function loadPendingDeposit() {
  const key = pendingDepositKey();
  if (!key) return;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved?.tx) {
      state.pendingDepositTx = saved.tx;
      state.pendingDepositWallet = saved.wallet || null;
    }
  } catch (_) {}
}

// Load per-lobby match durations from the DB so the client timer matches the
// server's settlement deadline. Best-effort: the defaults above are used on
// failure, and a too-short client timer can't shorten the match anyway (the
// server enforces started_at + config duration).
async function loadMatchConfig() {
  try {
    const { data, error } = await supabase.from("match_config").select("max_players, duration_seconds");
    if (error || !data) return;
    for (const r of data) state.matchDurations[r.max_players] = r.duration_seconds;
  } catch (e) {
    console.error("loadMatchConfig error:", e);
  }
}

// ---------------------------------------------------------------------------
// Live "players online" count — anyone with the app open, not just players in
// a match. Uses a Realtime presence channel rather than a DB table: presence
// membership already IS the count, no polling or writes needed. Independent
// of login — an anonymous per-tab key (cached in sessionStorage so a reload
// doesn't register as a second visitor) is used until/unless the wallet
// connects, at which point tracking continues under the same channel.
function startOnlinePresence() {
  // crypto.randomUUID needs a secure context and iOS 15.4+, and sessionStorage
  // can throw in private browsing — neither may stop the app from booting.
  let key = null;
  try { key = sessionStorage.getItem("f10_presence_key"); } catch (_) {}
  if (!key) {
    key = typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID()
      : `f10-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    try { sessionStorage.setItem("f10_presence_key", key); } catch (_) {}
  }
  try {
    const channel = supabase.channel("online-players", { config: { presence: { key } } });
    channel
      .on("presence", { event: "sync" }, () => {
        renderOnlineCount(Object.keys(channel.presenceState()).length);
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") channel.track({ online_at: Date.now() });
      });
    state.presenceChannel = channel;
  } catch (e) {
    console.error("startOnlinePresence error:", e);
  }
}

function renderOnlineCount(count) {
  if (els.onlineCount) els.onlineCount.textContent = String(count);
  if (els.pvpLobbyOnline) {
    els.pvpLobbyOnline.textContent = `${count} player${count === 1 ? "" : "s"} online`;
  }
}

// ---------------------------------------------------------------------------
// Shadow damage ledger (Option A, Phase 0)
// ---------------------------------------------------------------------------
// Records the outgoing damage the LOCAL player deals to each opponent, plus any
// kills it lands. Flushed to the server at match end so finalize_match can
// derive each player's HP from what *others* reported — independently of the
// self-reported HP that currently decides the winner. Runs in shadow mode: it
// only populates matches.shadow_winner for comparison and does NOT yet affect
// payouts. See supabase migration 20260627_shadow_damage_ledger.sql.
const ledger = {
  startMs: 0,
  flushed: false,
  damage: new Map(), // victimId -> { total, hits, firstT, lastT }
  kills: new Map(),  // victimId -> t_ms
  reset() {
    this.startMs = Date.now();
    this.flushed = false;
    this.damage.clear();
    this.kills.clear();
  },
  recordHit(victimId, dmg) {
    if (!victimId || !dmg) return;
    const t = Date.now() - this.startMs;
    const e = this.damage.get(victimId) ?? { total: 0, hits: 0, firstT: t, lastT: t };
    e.total += dmg;
    e.hits += 1;
    e.lastT = t;
    this.damage.set(victimId, e);
  },
  recordKill(victimId) {
    if (!victimId || this.kills.has(victimId)) return;
    this.kills.set(victimId, Date.now() - this.startMs);
  },
};

// ── Anti-manipulation (client side) ──────────────────────────────────────────
// The server rejects impossible/out-of-context combat writes and over-rate RPCs
// with an error message we can recognise. When the SERVER says a request was a
// manipulation attempt, we remove the player from the match immediately. We only
// react to server verdicts — never to local guesses — so honest players are
// never wrongly kicked.
let _kicked = false;
function isIntegrityError(err) {
  const m = (err?.message || err?.error || err?.error_description || "").toString().toLowerCase();
  return m.includes("cheat_detected") || m.includes("rate_limited");
}
function kickForManipulation(reason) {
  if (_kicked) return;
  _kicked = true;
  stopIntegrityWatch();
  stopHeartbeat();
  try { if (state.channel) supabase.removeChannel(state.channel); } catch (_) {}
  // NON-blocking notice — window.alert() freezes the whole page (no input at all)
  // until dismissed, so we show an overlay and hard-reload to a clean menu shortly
  // after (the match settles server-side).
  try {
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(0,0,0,0.9);color:#fff;font-family:var(--font-head);font-size:18px;" +
      "text-align:center;padding:24px;letter-spacing:0.04em";
    el.textContent = reason || "You were removed from the match.";
    document.body.appendChild(el);
  } catch (_) {}
  setTimeout(() => { try { window.location.reload(); } catch (_) {} }, 1600);
}

// Devtools watch during a live match — TELEMETRY ONLY. Detection libraries
// misfire (docked panels, unusual browsers, extensions that touch console), and
// with a real, non-refundable entry fee at stake a false-positive kick costs an
// honest player money. So an open console is recorded as an integrity signal
// for review, never auto-punished; actual cheating is caught server-side
// (write-time validation + settlement rate caps), where kicks remain in force.
let _devtoolsDetector = null;
let _dtListenerAdded = false;
let _dtReported = false;
function onDevtoolsChange(isOpen) {
  if (!isOpen || _kicked || _dtReported) return;
  if (state.match?.mode === "pvp" && !state.match?.finished) {
    _dtReported = true; // one signal per match is enough for review
    reportIntegritySignal("devtools_open", {});
  }
}
// Prefer a NON-PAUSING checker set (exclude the debugger checker so the game
// never freezes); fall back to the library default if the module shape differs.
function buildDetector(mod) {
  const ns = (mod.default && typeof mod.default === "object") ? mod.default : mod;
  const Detector = mod.DevtoolsDetector || ns.DevtoolsDetector;
  const checkers = mod.checkers || ns.checkers;
  if (Detector && checkers) {
    const list = [
      "regToStringChecker", "elementIdChecker", "functionToStringChecker",
      "dateToStringChecker", "depRegToStringChecker", "devtoolsFormatterChecker",
      "erudaChecker",
    ].map((k) => checkers[k]).filter(Boolean);
    if (list.length) { try { return new Detector({ checkers: list }); } catch (_) { /* fall through */ } }
  }
  const d = mod.devtoolsDetector
    || (mod.default && typeof mod.default.launch === "function" ? mod.default : null)
    || (typeof mod.launch === "function" ? mod : null);
  return (d && typeof d.addListener === "function" && typeof d.launch === "function") ? d : null;
}
async function startIntegrityWatch() {
  _dtReported = false; // fresh signal budget for the new match
  try {
    if (!_devtoolsDetector) {
      const mod = await importDevtoolsDetector();
      _devtoolsDetector = buildDetector(mod);
      if (!_devtoolsDetector) { console.error("devtools detector: unexpected module shape"); return; }
    }
    if (!_dtListenerAdded) { _devtoolsDetector.addListener(onDevtoolsChange); _dtListenerAdded = true; }
    _devtoolsDetector.launch();
  } catch (e) {
    console.error("devtools detector unavailable:", e);
  }
}
function stopIntegrityWatch() {
  try { _devtoolsDetector?.stop(); } catch (_) { /* not launched */ }
}

// Liveness heartbeat: while in an active match, tell the server we're still here
// every few seconds. If this lapses (tab closed / dropped), finalize_match marks
// us disconnected so the match can settle without waiting on us.
let _heartbeatTimer = null;
function startHeartbeat(matchId) {
  stopHeartbeat();
  if (!matchId) return;
  // NB: supabase.rpc() returns a thenable (not a real Promise), so `.catch()`
  // does not exist on it — calling it would throw synchronously. Await inside a
  // try/catch instead so a heartbeat failure can never break the caller.
  const beat = async () => {
    try { await supabase.rpc("heartbeat", { p_match_id: matchId }); } catch (_) {}
  };
  beat();
  _heartbeatTimer = setInterval(beat, 5000);
}
function stopHeartbeat() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}
let _integrityRpcDisabled = false;
async function reportIntegritySignal(kind, detail) {
  if (_integrityRpcDisabled) return;
  try {
    const { error } = await supabase.rpc("report_integrity_signal", {
      p_match_id: state.match?.id ?? null, p_kind: kind, p_detail: detail ?? null,
    });
    // If the RPC isn't available yet (migration not applied), stop calling it so
    // we don't spam the console with 404s.
    if (error) _integrityRpcDisabled = true;
  } catch (_) { _integrityRpcDisabled = true; }
}

// Insert this player's offense (damage dealt + kills landed) before reporting
// the match result. Idempotent: a match flushes at most once. Best-effort — a
// failure here must never block the existing settlement/payout path, EXCEPT a
// server 'cheat_detected' verdict, which removes the player immediately.
async function flushLedger(matchId) {
  if (!matchId || ledger.flushed) return;
  ledger.flushed = true;
  const uid = state.user?.id;
  if (!uid) return;
  const damageRows = [...ledger.damage].map(([victim, e]) => ({
    match_id: matchId, attacker: uid, victim,
    total_damage: Math.round(e.total), hit_count: e.hits,
    first_t_ms: e.firstT, last_t_ms: e.lastT,
  }));
  const killRows = [...ledger.kills].map(([victim, t]) => ({
    match_id: matchId, attacker: uid, victim, t_ms: t,
  }));
  try {
    if (damageRows.length) {
      // ignoreDuplicates makes this ON CONFLICT DO NOTHING. Without it supabase-js
      // emits ON CONFLICT DO UPDATE, which needs UPDATE privilege — match_damage is
      // deliberately insert-only under RLS, so the flush would fail with
      // "permission denied" on every match and settlement would see zero damage.
      const { error } = await supabase.from("match_damage").upsert(damageRows, { onConflict: "match_id,attacker,victim", ignoreDuplicates: true });
      if (error) {
        if (isIntegrityError(error)) return kickForManipulation("Removed: invalid combat data detected.");
        console.error("ledger flush error:", error);
      }
    }
    if (killRows.length) {
      const { error } = await supabase.from("match_kills").upsert(killRows, { onConflict: "match_id,victim", ignoreDuplicates: true });
      if (error) {
        if (isIntegrityError(error)) return kickForManipulation("Removed: invalid combat data detected.");
        console.error("ledger flush error:", error);
      }
    }
  } catch (e) {
    if (isIntegrityError(e)) return kickForManipulation("Removed: invalid combat data detected.");
    console.error("ledger flush error:", e);
  }
}

// Read this player's kill count back from the server (match_kills). RLS lets a
// member read the match's rows, and every row is write-guarded to attacker =
// auth.uid(), so this is a server-sourced count rather than the client's word.
// Returns null on any failure so callers can fall back to the local ledger.
async function fetchVerifiedKills(matchId) {
  if (!matchId || !state.user?.id) return null;
  try {
    const { count, error } = await supabase
      .from("match_kills")
      .select("victim", { count: "exact", head: true })
      .eq("match_id", matchId)
      .eq("attacker", state.user.id);
    if (error) { console.error("fetchVerifiedKills error:", error); return null; }
    return count ?? 0;
  } catch (e) {
    console.error("fetchVerifiedKills error:", e);
    return null;
  }
}

const game = createArenaGame({
  mount: els.arenaMount,
  onLocalState: (snapshot) => {
    state.channel?.send({ type: "broadcast", event: "state", payload: { userId: state.user?.id, snapshot } });
  },
  onAttack: (attackEvent) => {
    state.channel?.send({ type: "broadcast", event: "attack", payload: attackEvent });
    // Shadow ledger: accumulate damage we dealt to a networked opponent.
    // Grenades are excluded here — their real damage (blast falloff, splash on
    // other opponents, or a miss) is only known when the explosion resolves,
    // so it arrives through onGrenadeDamage instead.
    if (state.match?.mode === "pvp" && attackEvent?.targetId && attackEvent.fromId === state.user?.id && !attackEvent.isGrenade) {
      ledger.recordHit(attackEvent.targetId, attackEvent.dmg);
    }
  },
  onGrenadeDamage: ({ victimId, dmg }) => {
    if (state.match?.mode === "pvp") ledger.recordHit(victimId, dmg);
  },
  onLocalKill: ({ victimId }) => {
    if (state.match?.mode === "pvp") ledger.recordKill(victimId);
  },
  onResultSuggestion: (result, standings) => {
    reportResult(result, { standings }).catch((err) => console.error(err));
  },
  // HUD menu button (top-right): open the in-game menu, same as pressing Esc.
  // Settings stays reachable through that menu's Settings entry.
  onMenu: () => {
    if (state.match && !state.match.finished) els.pauseOverlay.classList.add("show");
    else if (game.isHomePlaying()) game.stopHomePlay();
    else game.openSettings();
  },
  // Gate for starting landing free-play on a map tap: only on a clean home
  // screen — never during a match, matchmaking, or with a menu overlay open.
  canHomePlay: () => canStartHomePlay(),
  // Enter/leave landing free-play: hide the landing chrome and show the game
  // HUD + the "press Esc to return" hint (and the reverse).
  onHomePlay: (active) => {
    document.body.classList.toggle("home-free-play", active);
    game.showRaiderCount(active);
    els.homePlayHint?.classList.toggle("hidden", !active);
  }
});

// True only on the idle landing page — no match in flight, matchmaking closed,
// and no menu overlay or nav dropdown open — so a stray map tap can't hijack
// matchmaking or a modal.
function canStartHomePlay() {
  if (state.match) return false;
  if (els.pvpLobby && !els.pvpLobby.classList.contains("hidden")) return false;
  if (document.querySelector(".overlay.show")) return false;
  if (document.getElementById("navMenu")?.classList.contains("open")) return false;
  return true;
}

// -- Player skin (profile → APPEARANCE tab) ----------------------------------
// Two fixed skins. Picking a card applies the skin live and remembers it on
// this device; the Save button writes the preference to the wallet profile
// (profiles.skin_id — the "default character"). Which skins a player has at
// all comes from profiles.skins (server-managed; everyone has 1 and 2 today).
const SKIN_KEY = "f10_skin";
let activeSkin = "1";
let availableSkins = [1, 2];
try { if (JSON.parse(localStorage.getItem(SKIN_KEY) || "null") === "2") activeSkin = "2"; } catch { /* corrupted storage → default */ }

function applySkin(id) {
  activeSkin = id === "2" ? "2" : "1";
  game.setPlayerAppearance({ style: activeSkin, colors: APPEARANCE_PRESETS[activeSkin] });
  if (appearancePreview) appearancePreview.setAppearance(activeSkin, APPEARANCE_PRESETS[activeSkin]);
  try { localStorage.setItem(SKIN_KEY, JSON.stringify(activeSkin)); } catch { /* private mode */ }
  renderSkinCards();
}

function renderSkinCards() {
  document.querySelectorAll("#skinCards .skin-card").forEach((c) => {
    c.classList.toggle("active", c.dataset.skin === activeSkin);
    c.disabled = !availableSkins.includes(Number(c.dataset.skin));
  });
}

async function saveSkin() {
  const hint = document.getElementById("skinHint");
  if (!state.user?.id) {
    if (hint) hint.textContent = "Saved on this device. Connect your wallet to sync it to your profile.";
    return;
  }
  const { error } = await supabase.from("profiles").update({ skin_id: Number(activeSkin) }).eq("user_id", state.user.id);
  if (error) {
    console.error("skin save error:", error);
    if (hint) hint.textContent = "Could not save — try again.";
    return;
  }
  if (state.profile) state.profile.skin_id = Number(activeSkin);
  if (hint) hint.textContent = "Saved to your wallet profile.";
}

// The preview owns a WebGL context, so it's created lazily the first time the
// APPEARANCE tab is opened rather than at boot.
let appearancePreview = null;
function updateAppearancePreview() {
  const host = document.getElementById("appearancePreview");
  if (!host) return;
  if (!appearancePreview) appearancePreview = game.mountAppearancePreview(host);
  appearancePreview?.setAppearance(activeSkin, APPEARANCE_PRESETS[activeSkin]);
}

bindUi();
applySkin(activeSkin);
init();

function bindUi() {
  els.signInWalletBtn.addEventListener("click", signIn);
  document.getElementById("joinFightBtn")?.addEventListener("click", signIn);
  // Tapping the hint leaves free-play too (touch devices have no Esc key).
  els.homePlayHint?.addEventListener("click", () => game.stopHomePlay());
  els.demoBtn.addEventListener("click", startDemo);
  els.pvpBtn.addEventListener("click", startPvp);
  els.howToPlayBtn.addEventListener("click", () => els.howToOverlay.classList.add("show"));
  els.howToClose.addEventListener("click", () => els.howToOverlay.classList.remove("show"));
  els.whitepaperBtn?.addEventListener("click", () => els.whitepaperOverlay.classList.add("show"));
  document.getElementById("homeLeaderboardBtn")?.addEventListener("click", () => { openLeaderboard().catch((e) => console.error(e)); });
  // Landing-section CTAs (below the fold) — same actions as the hero buttons.
  document.getElementById("secPlayBtn")?.addEventListener("click", startPvp);
  document.getElementById("secHowToBtn")?.addEventListener("click", () => els.howToOverlay.classList.add("show"));
  document.getElementById("secWhitepaperBtn")?.addEventListener("click", () => els.whitepaperOverlay?.classList.add("show"));
  els.whitepaperClose?.addEventListener("click", () => els.whitepaperOverlay.classList.remove("show"));
  els.whitepaperOverlay?.addEventListener("pointerdown", (e) => {
    if (e.target === els.whitepaperOverlay) els.whitepaperOverlay.classList.remove("show");
  });
  els.profileBtn.addEventListener("click", () => openProfile());
  // The nav $FIGHT10 balance chip jumps straight to the profile's $FIGHT10 tab.
  document.getElementById("fight10Balance")?.addEventListener("click", () => openProfile("holdings"));
  // Holder perk "PLAY FIGHT10 PVP": close the profile and enter the PvP flow.
  document.getElementById("perkPlayPvpBtn")?.addEventListener("click", () => {
    els.profileOverlay.classList.remove("show");
    startPvp();
  });
  els.profileClose.addEventListener("click", () => els.profileOverlay.classList.remove("show"));
  els.profileOverlay.addEventListener("pointerdown", (e) => {
    if (e.target === els.profileOverlay) els.profileOverlay.classList.remove("show");
  });
  els.profileSaveBtn.addEventListener("click", saveProfile);
  els.profileNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveProfile(); });
  els.profileTabs.forEach((t) => t.addEventListener("click", () => selectProfileTab(t.dataset.ptab)));
  document.querySelectorAll("#skinCards .skin-card").forEach((c) => c.addEventListener("click", () => {
    const hint = document.getElementById("skinHint");
    if (hint) hint.textContent = "";
    applySkin(c.dataset.skin);
  }));
  document.getElementById("skinSaveBtn")?.addEventListener("click", () => saveSkin().catch((e) => console.error("skin save error:", e)));
  els.pvpCancelBtn.addEventListener("click", () => leaveMatch());
  // Returning to the menu after a match fully reloads the page. This guarantees a
  // clean slate (3D scene, realtime channel, match state) for the next game.
  els.gameOverMenuBtn.addEventListener("click", () => { window.location.reload(); });
  document.getElementById("gameOverRetryBtn")?.addEventListener("click", () => retryPayout());
  els.pvpSizeClose.addEventListener("click", () => els.pvpSizeOverlay.classList.remove("show"));
  els.pvpSizeOverlay.addEventListener("pointerdown", (e) => {
    if (e.target === els.pvpSizeOverlay) els.pvpSizeOverlay.classList.remove("show");
  });
  els.pvpSizeBtns.forEach((b) =>
    b.addEventListener("click", () => {
      els.pvpSizeOverlay.classList.remove("show");
      joinPvp(parseInt(b.dataset.size, 10));
    })
  );
  els.howToOverlay.addEventListener("pointerdown", (e) => {
    if (e.target === els.howToOverlay) els.howToOverlay.classList.remove("show");
  });
  // Hamburger menu — same actions as the home buttons.
  // startPvp() already falls back to signIn() when no wallet is connected.
  const navMenu = document.getElementById("navMenu");
  const hamburgerBtn = document.getElementById("navHamburgerBtn");
  const closeNavMenu = () => {
    navMenu?.classList.remove("open");
    hamburgerBtn?.setAttribute("aria-expanded", "false");
  };
  const navActions = [
    ["menuPlayPvpBtn",    startPvp],
    ["menuLeaderboardBtn", () => { openLeaderboard().catch((e) => console.error(e)); }],
    ["menuHowToBtn",      () => els.howToOverlay.classList.add("show")],
    ["menuWhitepaperBtn", () => els.whitepaperOverlay?.classList.add("show")],
    ["signOutBtn",        signOut],
  ];
  navActions.forEach(([id, action]) =>
    document.getElementById(id)?.addEventListener("click", () => { closeNavMenu(); action(); })
  );
  hamburgerBtn?.addEventListener("click", (e) => {
    e.stopPropagation(); // keep the document click-away handler from re-closing it
    const open = navMenu?.classList.toggle("open");
    hamburgerBtn.setAttribute("aria-expanded", String(!!open));
  });
  document.addEventListener("click", (e) => {
    if (navMenu?.classList.contains("open") && !navMenu.contains(e.target)) closeNavMenu();
  });
  // In-game menu (Esc opens it — does NOT quit the match)
  els.resumeBtn.addEventListener("click", () => els.pauseOverlay.classList.remove("show"));
  els.pauseClose.addEventListener("click", () => els.pauseOverlay.classList.remove("show"));
  els.pauseOverlay.addEventListener("pointerdown", (e) => {
    if (e.target === els.pauseOverlay) els.pauseOverlay.classList.remove("show");
  });
  els.pauseHowToBtn.addEventListener("click", () => {
    els.pauseOverlay.classList.remove("show");
    els.howToOverlay.classList.add("show");
  });
  els.leaveMatchBtn.addEventListener("click", async () => {
    els.pauseOverlay.classList.remove("show");
    const isActivePvp = state.match?.mode === "pvp" && state.match?.status !== "waiting";
    const confirmMsg = isActivePvp
      ? "Leave this match now? You'll forfeit the fight and your entry fee stays in the pot."
      : "Leave this match now?";
    const ok = await confirmDialog(confirmMsg);
    if (!ok) return;
    // A confirmed leave fully reloads the page for a clean slate (matches the
    // game-over "Main Menu" behavior). A cancelled forfeit prompt does not.
    const left = await leaveMatch({ skipConfirm: true });
    if (left) window.location.reload();
  });
  // Leaderboard tab strip (points / wins / $FIGHT10 holdings).
  document.querySelectorAll("[data-lbtab]").forEach((btn) =>
    btn.addEventListener("click", () => { selectLeaderboardTab(btn.dataset.lbtab).catch((e) => console.error(e)); })
  );
  // Leaderboard filters: free-text name/wallet filter + "YOUR WALLET" toggle.
  document.getElementById("leaderboardFilter")?.addEventListener("input", (e) => {
    lbFilterQuery = e.target.value;
    renderLeaderboardList();
  });
  document.getElementById("leaderboardMeBtn")?.addEventListener("click", (e) => {
    lbMineOnly = !lbMineOnly;
    e.currentTarget.classList.toggle("active", lbMineOnly);
    renderLeaderboardList();
  });
  // Leaderboard + Buy-$FIGHT10 overlays: close button and backdrop click.
  [["leaderboardOverlay", "leaderboardClose"], ["buyFight10Overlay", "buyFight10Close"]].forEach(([ovId, closeId]) => {
    const ov = document.getElementById(ovId);
    document.getElementById(closeId)?.addEventListener("click", () => ov?.classList.remove("show"));
    ov?.addEventListener("pointerdown", (e) => { if (e.target === ov) ov.classList.remove("show"); });
  });
  document.getElementById("pauseSettingsBtn")?.addEventListener("click", () => {
    els.pauseOverlay.classList.remove("show");
    game.openSettings();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (navMenu?.classList.contains("open")) { closeNavMenu(); return; }
    const open = document.querySelector(".overlay.show");
    if (open) { open.classList.remove("show"); return; } // close topmost overlay
    if (game.isHomePlaying()) { game.stopHomePlay(); return; } // leave landing free-play
    if (state.match && !state.match.finished) els.pauseOverlay.classList.add("show");
  });
}

function selectProfileTab(tab) {
  els.profileTabs.forEach((t) => t.classList.toggle("active", t.dataset.ptab === tab));
  els.profileBodies.forEach((b) => b.classList.toggle("hidden", b.dataset.pbody !== tab));
  if (tab === "history") loadHistory().catch((e) => console.error(e));
  if (tab === "holdings") loadHoldings().catch((e) => console.error(e));
  if (tab === "appearance") updateAppearancePreview();
}

async function init() {
  const fillEl    = document.getElementById("loadingBarFill");
  const statusEl  = document.getElementById("loadingStatus");
  const loadingEl = document.getElementById("appLoading");

  // Ease the bar toward a ceiling of 85% while async work runs.
  let progress = 0;
  const tick = setInterval(() => {
    progress += (85 - progress) * 0.06;
    if (fillEl) fillEl.style.width = progress.toFixed(1) + "%";
  }, 50);

  if (statusEl) statusEl.textContent = "Connecting…";
  loadMatchConfig(); // fire-and-forget; ready well before any match starts
  startOnlinePresence(); // fire-and-forget; independent of auth/login state
  supabase.auth.onAuthStateChange((_event, session) => {
    handleSession(session).catch((error) => {
      console.error(error);
      setStatus(error.message || "Auth update failed.");
    });
  });
  const { data } = await supabase.auth.getSession();
  if (statusEl) statusEl.textContent = "Loading profile…";
  await handleSession(data.session);

  // Snap to 100 % then fade out.
  clearInterval(tick);
  if (fillEl) { fillEl.style.transition = "width 0.25s ease"; fillEl.style.width = "100%"; }
  if (statusEl) statusEl.textContent = "Ready";
  setTimeout(() => {
    if (loadingEl) { loadingEl.classList.add("fade-out"); setTimeout(() => loadingEl.remove(), 500); }
  }, 350);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
// Every major Ethereum wallet (MetaMask, Rabby, Brave, Robinhood Wallet)
// injects the EIP-1193 provider at window.ethereum.
function getEthereumWallet() {
  return window.ethereum || null;
}

// The wallet's currently connected address (lowercased), or null when the
// site isn't connected yet. eth_accounts never pops a prompt.
async function getWalletAddress(wallet = getEthereumWallet()) {
  if (!wallet) return null;
  try {
    const accounts = await wallet.request({ method: "eth_accounts" });
    return accounts?.[0] ? accounts[0].toLowerCase() : null;
  } catch (_) {
    return null;
  }
}

// Make sure the wallet is on the Robinhood Chain network (see the NETWORK
// definition in network.js), prompting a switch — or a one-time add from
// it — when it isn't. Throws if the user declines.
async function ensureNetwork(wallet) {
  const current = await wallet.request({ method: "eth_chainId" });
  if (parseInt(current, 16) === NETWORK.chainId) return;
  try {
    await wallet.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: NETWORK.chainIdHex }],
    });
  } catch (err) {
    // 4902: the chain isn't in the wallet yet — add it (which also switches).
    const code = err?.code ?? err?.data?.originalError?.code;
    if (code !== 4902) throw err;
    await wallet.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: NETWORK.chainIdHex,
        chainName: NETWORK.name,
        rpcUrls: [NETWORK.rpcUrl],
        blockExplorerUrls: [NETWORK.explorerBase],
        nativeCurrency: NETWORK.nativeCurrency,
      }],
    });
  }
}

async function signIn() {
  const wallet = getEthereumWallet();
  if (!wallet) {
    setStatus("No Ethereum wallet found. Install MetaMask, Rabby, or Brave Wallet.");
    return;
  }
  try {
    setStatus("Approve the signature in your wallet…");
    await wallet.request({ method: "eth_requestAccounts" });
    // Put the wallet on Robinhood Chain before signing so the SIWE message
    // carries the right chain id and deposits later need no extra switch.
    await ensureNetwork(wallet);
    const { error } = await supabase.auth.signInWithWeb3({ chain: "ethereum", statement: SIGN_IN_STATEMENT, wallet });
    if (error) throw error;
  } catch (error) {
    console.error("[signIn]", error);
    setStatus(error.message || "Wallet sign-in failed.");
  }
}

async function signOut() {
  await leaveMatch({ silent: true });
  const { error } = await supabase.auth.signOut();
  if (error) setStatus(error.message);
}

async function handleSession(session) {
  const prevUserId = state.user?.id;
  state.user = session?.user ?? null;

  // Supabase re-fires auth events for the SAME user (token refresh, tab
  // refocus re-emitting SIGNED_IN — e.g. returning from the wallet popup).
  // Rebuilding the lobby then would stomp a live queue or match: showLobby()
  // → showHomeScene() flips the arena back to the AI showcase — stray
  // "Raider", invisible rivals, frozen player. Keep the refreshed session and
  // touch nothing else.
  if (state.user && state.user.id === prevUserId &&
      (state.channel || (state.match && !state.match.finished))) return;

  if (!state.user) {
    state.profile = null;
    await teardownMatch();
    game.clearAll();
    showLobby();
    setStatus("Connect an Ethereum wallet to begin.");
    return;
  }

  try {
    await syncProfile();
    // The wallet profile is the source of truth once signed in: skins the
    // player has, and their saved default character.
    if (Array.isArray(state.profile?.skins) && state.profile.skins.length) {
      availableSkins = state.profile.skins.map(Number);
    }
    const serverSkin = state.profile?.skin_id;
    if (serverSkin === 1 || serverSkin === 2) applySkin(String(serverSkin));
    else renderSkinCards();
  } catch (error) {
    console.error("[handleSession]", error);
    setStatus(error.message || "Could not load profile.");
    return;
  }
  showLobby();
  // Restore a deposit that was confirmed on-chain but never spent on a seat
  // (e.g. the tab crashed between payment and queue entry).
  loadPendingDeposit();
  setStatus(recordSuffix(
    state.pendingDepositTx
      ? "You have a confirmed, unused entry deposit — click Play PvP to enter the queue without paying again."
      : "Wallet connected — choose Demo Match or Play PvP."
  ));
  refreshFight10Balance().catch(console.error);
}

async function syncProfile() {
  const { data, error } = await supabase.rpc("sync_my_profile", { p_display_name: null });
  if (error) throw error;
  state.profile = data;
}

// ---------------------------------------------------------------------------
// Demo match — vs the computer (no networking, no DB)
// ---------------------------------------------------------------------------
function startDemo() {
  state.match = { mode: "demo", status: "active", finished: false };
  state.remoteIds.clear();
  state.started = true;
  game.setView("game");
  game.setLocalUser({ userId: state.user?.id ?? null, displayName: state.profile?.display_name || "You", level: localLevel() });
  game.setMatchNumber(null); // demo matches have no match number
  game.useAiFoe();          // single AI raider opponent
  game.generateMap("demo-" + Date.now());
  game.resetForMatch();
  game.showMapToggle(true);
  game.showRaiderCount(true);
  game.setMatchPhase("countdown");
  game.setControllable(false);
  runMatchStart(() => {
    game.setMatchPhase("active");
    game.setControllable(true);
    setStatus("Demo match vs the computer. Click the battlefield to move.");
    showGlhf();
  });
}

// ---------------------------------------------------------------------------
// PvP — matchmaking vs other players, result written to the DB
// ---------------------------------------------------------------------------
let pvpLobbyTimer = null;

function showPvpLobby(status) {
  els.pvpLobbyStatus.textContent = status || "Searching for an opponent…";
  els.pvpLobbyMeta.textContent = "";
  // Hidden during pre-payment states; shown once the entry fee is paid (waiting).
  els.pvpLobbyWarning?.classList.add("hidden");
  els.pvpLobby.classList.remove("hidden");
  clearInterval(pvpLobbyTimer);
  pvpLobbyTimer = null;
}

function hidePvpLobby() {
  clearInterval(pvpLobbyTimer);
  pvpLobbyTimer = null;
  els.pvpLobby.classList.add("hidden");
  els.pvpLobbyWarning?.classList.add("hidden");
  const potEl = document.getElementById("pvpPrizePool");
  if (potEl) potEl.classList.add("hidden");
}

// Format a millisecond duration as m:ss for the match-time readout.
function fmtDuration(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// The results overlay (spinner + settlement countdown). Kept visible for the
// whole settlement wait — which on a walkover (a rival who never opened the
// match) is several seconds — so the screen never freezes with no feedback.
// The countdown mirrors the server's 15s disconnect-grace window: once it
// lapses the match can settle, so the timer gives the wait a concrete horizon.
const SETTLE_COOLDOWN_S = 15;
let _settleTimer = null;
function startSettleCountdown() {
  if (_settleTimer) return; // already ticking for this match — don't restart
  const countEl = document.getElementById("resultsLoadingCount");
  const barEl   = document.getElementById("resultsLoadingBar");
  const stEl    = document.getElementById("resultsLoadingStatus");
  const start = Date.now();
  const tick = () => {
    const elapsed = (Date.now() - start) / 1000;
    const remain = Math.max(0, SETTLE_COOLDOWN_S - elapsed);
    if (countEl) countEl.textContent = Math.ceil(remain) + "s";
    if (barEl) barEl.style.width = Math.min(100, (elapsed / SETTLE_COOLDOWN_S) * 100).toFixed(1) + "%";
    if (remain <= 0) {
      // Grace elapsed but the verdict is still landing — hold at a full bar.
      if (stEl) stEl.textContent = "Finalizing result…";
      if (countEl) { countEl.textContent = "0s"; countEl.classList.add("rl-count-done"); }
      clearInterval(_settleTimer); _settleTimer = null;
    }
  };
  tick();
  _settleTimer = setInterval(tick, 200);
}
function showResultsLoading(statusText = "Settling match…") {
  const el = document.getElementById("resultsLoading");
  if (!el) return;
  const st = document.getElementById("resultsLoadingStatus");
  if (st) st.textContent = statusText;
  const countEl = document.getElementById("resultsLoadingCount");
  if (countEl) countEl.classList.remove("rl-count-done");
  el.classList.remove("hidden");
  startSettleCountdown();
}
function hideResultsLoading() {
  if (_settleTimer) { clearInterval(_settleTimer); _settleTimer = null; }
  document.getElementById("resultsLoading")?.classList.add("hidden");
}
// Show the overlay for a minimum suspense beat, then resolve — but leave it up
// so the settlement wait that follows keeps the progress bar on screen.
function showResultsSuspense(ms = 2000, statusText = "Settling match…") {
  showResultsLoading(statusText);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function showGameOver(result, reason, standings = [], prizeAmount = null, kills = null, timeMs = null) {
  hideResultsLoading(); // never leave the settlement overlay covering a results card
  const win = result === "win";
  const disputed = result === "disputed";
  els.gameOverTitle.textContent = win ? "VICTORY" : disputed ? "NO CONTEST" : "DEFEAT";
  els.gameOverTitle.classList.toggle("is-win", win);
  els.gameOverTitle.classList.toggle("is-loss", !win);
  // Tag the whole overlay so the card layout/theme can adapt. Only a real win
  // is gold; defeat and no-contest stay monochrome.
  els.gameOver.classList.toggle("is-win", win);
  els.gameOver.classList.toggle("is-loss", !win);
  els.gameOverReason.textContent = reason || (win ? "Your rival fell in the trench." : "You fell in the trench.");
  // Friendly match number — matches the HUD and match history so the result
  // can be referenced later (e.g. in a support request).
  const matchNoEl = document.getElementById("gameOverMatchNo");
  if (matchNoEl) {
    const n = state.match?.matchNo;
    matchNoEl.textContent = n ? `MATCH #${n} · ${state.match?.maxPlayers || 2}-PLAYER` : "";
    matchNoEl.classList.toggle("hidden", !n);
  }
  els.gameOverName.textContent = state.profile?.display_name || "Trench Rookie";
  els.gameOverWins.textContent = state.profile?.wins ?? 0;
  els.gameOverLosses.textContent = state.profile?.losses ?? 0;
  // Match summary: kills this match (from our offense ledger) and time taken.
  const killsEl = document.getElementById("gameOverKills");
  const timeEl  = document.getElementById("gameOverTime");
  if (killsEl) killsEl.textContent = kills ?? ledger.kills.size;
  if (timeEl)  timeEl.textContent  = fmtDuration(timeMs ?? (ledger.startMs ? Date.now() - ledger.startMs : 0));
  renderStandings(standings);
  // Prize display
  const prizeEl  = document.getElementById("gameOverPrize");
  const prizeAmt = document.getElementById("gameOverPrizeAmount");
  if (prizeEl && prizeAmt) {
    if (win) {
      prizeAmt.textContent = prizeAmount === "pending" ? "Processing payout…" : prizeAmount !== null
        ? prizeAmount.toLocaleString(undefined, { maximumFractionDigits: 0 }) + " $FIGHT10"
        : "Payout failed — contact support";
      setGameOverTxLink(null); // revealed once the payout confirms
      prizeEl.classList.remove("hidden");
    } else {
      prizeEl.classList.add("hidden");
    }
  }
  // Hide menu button while payout is in-flight; show it for losses immediately
  els.gameOverMenuBtn.classList.toggle("hidden", win && prizeAmount === "pending");
  els.gameOver.classList.remove("hidden");
}

// Re-render the wins/losses on an already-visible game-over card. The winner's
// card is shown before syncProfile() picks up the freshly-applied stats, so we
// call this afterward to update the numbers in place.
function refreshGameOverStats() {
  els.gameOverWins.textContent = state.profile?.wins ?? 0;
  els.gameOverLosses.textContent = state.profile?.losses ?? 0;
}

// Explorer links come from network.js (txExplorerUrl) so they always point at
// the Blockscout instance of the selected Robinhood Chain network.

// Show/hide the "View transaction" link in the victory prize box.
function setGameOverTxLink(sig) {
  const link = document.getElementById("gameOverTxLink");
  if (!link) return;
  if (sig) {
    link.href = txExplorerUrl(sig);
    link.classList.remove("hidden");
  } else {
    link.removeAttribute("href");
    link.classList.add("hidden");
  }
}

function updateGameOverPrize(prizeAmount, payoutTx = null, failReason = null) {
  const prizeEl   = document.getElementById("gameOverPrize");
  const prizeAmt  = document.getElementById("gameOverPrizeAmount");
  const retryBtn  = document.getElementById("gameOverRetryBtn");
  if (!prizeEl || !prizeAmt) return;
  if (prizeAmount !== null) {
    prizeAmt.textContent = prizeAmount.toLocaleString(undefined, { maximumFractionDigits: 0 }) + " $FIGHT10";
    retryBtn?.classList.add("hidden");
    setGameOverTxLink(payoutTx);
  } else {
    // Name the actual reason (from the treasurer) so a stuck payout is
    // self-diagnosing instead of a blank "failed".
    prizeAmt.textContent = failReason
      ? `Payout failed: ${failReason} — tap Retry or contact support`
      : "Payout failed — tap Retry or contact support";
    retryBtn?.classList.remove("hidden");
    setGameOverTxLink(null);
  }
  els.gameOverMenuBtn.classList.remove("hidden");
}

// f10treasurer returns business failures as a non-2xx status, so supabase-js
// surfaces them as `error` (a FunctionsHttpError) with `data` == null and the
// real reason only inside the Response body. Without reading that body every
// failure looks like a generic "non-2xx status code", which is why a stuck
// payout is impossible to diagnose from the logs. This pulls out the actual
// message so both the console and the on-screen text name the true cause.
async function describePayoutFailure(payoutErr, payoutData) {
  if (payoutData && payoutData.ok === false && payoutData.error) return String(payoutData.error);
  try {
    const body = await payoutErr?.context?.json?.();
    if (body?.error) return String(body.error);
  } catch (_) { /* body not JSON / already consumed */ }
  return payoutErr?.message ? String(payoutErr.message) : "unknown error";
}

// Fix 10: allow winner to retry a failed payout without reloading the page.
async function retryPayout() {
  if (!state.match?.id) return;
  const retryBtn = document.getElementById("gameOverRetryBtn");
  const prizeAmt = document.getElementById("gameOverPrizeAmount");
  if (retryBtn) retryBtn.classList.add("hidden");
  if (prizeAmt) prizeAmt.textContent = "Processing payout…";
  els.gameOverMenuBtn.classList.add("hidden");
  let prizeAmount = null;
  let payoutTx = null;
  let failReason = null;
  try {
    const { data: payoutData, error: payoutErr } = await supabase.functions.invoke("f10treasurer", {
      body: { match_id: state.match.id },
    });
    if (!payoutErr && payoutData?.winner_amount && payoutData?.decimals != null) {
      prizeAmount = Number(payoutData.winner_amount) / 10 ** payoutData.decimals;
      payoutTx = payoutData.payout_tx ?? null;
    } else {
      failReason = await describePayoutFailure(payoutErr, payoutData);
      console.error(`Retry payout failed (match ${state.match.id}):`, failReason);
    }
  } catch (err) {
    failReason = String(err?.message || err);
    console.error("Retry payout error:", err);
  }
  updateGameOverPrize(prizeAmount, payoutTx, failReason);
}

// Polls until the match row is marked 'finished', guarding against read-after-write lag.
// Uses exponential backoff (800ms → 1.6s → 3.2s → …) capped at 5s per interval.
// Wait for the server to settle the match. Returns the settled row
// ({ status, winner_user_id }) once status is 'finished' or 'disputed', or null
// on timeout. Phase 2: the winner is decided server-side from the combat ledger,
// so the client must read the verdict here rather than trust its own detection.
async function awaitSettlement(matchId, timeoutMs = 24000) {
  const deadline = Date.now() + timeoutMs;
  let delay = 800;
  while (Date.now() < deadline) {
    const { data } = await supabase
      .from("matches")
      .select("status, winner_user_id, shadow_meta")
      .eq("id", matchId)
      .single();
    if (data?.status === "finished" || data?.status === "disputed") return data;
    // Not settled yet — nudge finalize in case an opponent disconnected (settles
    // once their heartbeat is stale past the grace window; idempotent otherwise).
    try { await supabase.rpc("try_finalize", { p_match_id: matchId }); } catch (_) {}
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 4000);
  }
  return null;
}

// The actual participants of a match (bounded by max_players ≤ 10). This is the
// authoritative roster used to build the game-over standings — NOT the local
// game state, which can accumulate ghost/duplicate opponents.
async function fetchMatchPlayers(matchId) {
  try {
    const { data } = await supabase
      .from("match_players").select("user_id, display_name, seat").eq("match_id", matchId);
    return data || [];
  } catch (_) { return []; }
}

// Build standings STRICTLY from the match's real players, attaching each one's
// server-derived HP (matches.shadow_meta.hp) when available so the winner and
// loser screens agree. Bounding to match_players prevents phantom rows.
function buildBoundedStandings(players, settled) {
  const hpByUser = {};
  const arr = settled?.shadow_meta?.hp;
  if (Array.isArray(arr)) {
    arr.forEach((e) => { hpByUser[e.user_id] = { hp: Math.max(0, e.hp), flagged: !!e.flagged, dc: !!e.dc }; });
  }
  const rows = players.map((p) => ({
    name: p.display_name,
    seat: p.seat ?? 0,
    hp: hpByUser[p.user_id]?.hp ?? null,
    flagged: hpByUser[p.user_id]?.flagged ?? false,
    dc: hpByUser[p.user_id]?.dc ?? false,
    me: p.user_id === state.user?.id,
  }));
  rows.sort((a, b) => ((b.hp ?? -1) - (a.hp ?? -1)) || (a.seat - b.seat));
  return rows.map((r, i) => ({ rank: i + 1, name: r.name, hp: r.hp ?? 0, me: r.me, flagged: r.flagged, dc: r.dc }));
}

function renderStandings(standings) {
  const el = document.getElementById("gameOverStandings");
  if (!el) return;
  if (!standings.length) { el.innerHTML = ""; return; }
  el.innerHTML = standings.map((s) =>
    `<div class="standing-row${s.me ? " standing-me" : ""}${s.flagged ? " standing-flagged" : ""}${s.dc ? " standing-dc" : ""}">` +
    `<span class="standing-rank">#${s.rank}</span>` +
    `<span class="standing-name">${escapeHtml(s.name)}${s.flagged ? " ⚠" : ""}${s.dc ? '<span class="standing-dc-tag">DISCONNECTED</span>' : ""}</span>` +
    `</div>`
  ).join("");
}

function hideGameOver() {
  els.gameOver.classList.add("hidden");
}

async function startPvp() {
  if (!state.user) { signIn(); return; }
  // Balance gate BEFORE the lobby-size picker: entering PvP costs 2,500
  // $FIGHT10, so a wallet that can't cover it gets the buy prompt right away
  // instead of a payment flow that would only fail later. A held (already
  // confirmed) deposit skips the check, and an unreadable balance falls
  // through to the authoritative re-check inside depositEntryFee — this gate
  // must never block a legitimate join on an RPC hiccup.
  if (!state.pendingDepositTx && !FIGHT10_TOKEN.startsWith("<")) {
    const addr = await getWalletAddress();
    if (addr) {
      try {
        setStatus("Checking $FIGHT10 balance…");
        const raw = await getFight10Balance(addr);
        if (raw < ENTRY_FEE_RAW) {
          const have = Number(raw) / 10 ** FIGHT10_DECIMALS;
          setStatus(`Insufficient $FIGHT10 — need ${ENTRY_FEE.toLocaleString()}, have ${have.toFixed(0)}.`);
          showBuyFight10(have);
          return;
        }
      } catch (err) {
        console.error("[startPvp balance check]", err);
      }
    }
  }
  els.pvpSizeOverlay.classList.add("show");
  fetchLobbyCounts().catch(() => {});
}

// Where to buy $FIGHT10 — override with VITE_BUY_FIGHT10_URL (e.g. a DEX swap
// link on Robinhood Chain); defaults to the token's Blockscout page once the
// token address is configured, the explorer home before launch.
const BUY_FIGHT10_URL =
  import.meta.env?.VITE_BUY_FIGHT10_URL?.trim() ||
  (FIGHT10_TOKEN.startsWith("<")
    ? NETWORK.explorerBase
    : `${NETWORK.explorerBase}/token/${FIGHT10_TOKEN}`);

// "Not enough $FIGHT10" popup with a buy link. haveTokens (optional) is the
// wallet's current balance in whole tokens, shown for context.
function showBuyFight10(haveTokens = null) {
  const balEl = document.getElementById("buyFight10Balance");
  if (balEl) {
    balEl.textContent = haveTokens != null
      ? `Your balance: ${haveTokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} $FIGHT10`
      : "";
  }
  const link = document.getElementById("buyFight10Link");
  if (link) link.href = BUY_FIGHT10_URL;
  document.getElementById("buyFight10Overlay")?.classList.add("show");
}

// ---------------------------------------------------------------------------
// Leaderboard — three boards: points, wins / win%, and $FIGHT10 held. The two
// stat tabs come from the get_leaderboard RPC (the profiles table itself is
// RLS'd to own-row reads); the holdings tab ranks the wallets returned by
// get_holdings_wallets by their on-chain $FIGHT10 balance.
// ---------------------------------------------------------------------------
const LB_TITLES = {
  points:   "TOP FIGHTERS · POINTS",
  wins:     "TOP FIGHTERS · WINS",
  holdings: "TOP HOLDERS · $FIGHT10",
};
let lbTab = "points";
let lbRows = [];        // last loaded rows for the active tab
let lbFilterQuery = ""; // free-text filter (name or wallet)
let lbMineOnly = false; // "YOUR WALLET" quick filter

async function openLeaderboard(tab = "points") {
  document.getElementById("leaderboardOverlay")?.classList.add("show");
  await selectLeaderboardTab(tab);
}

async function selectLeaderboardTab(tab) {
  lbTab = tab;
  lbRows = [];
  document.querySelectorAll("[data-lbtab]").forEach((b) => b.classList.toggle("active", b.dataset.lbtab === tab));
  const title = document.getElementById("leaderboardTitle");
  if (title) title.textContent = LB_TITLES[tab] ?? LB_TITLES.points;
  const list = document.getElementById("leaderboardList");
  if (!list) return;
  list.innerHTML = '<div class="lb-empty">Loading…</div>';
  try {
    const board = tab === "holdings" ? await loadHoldingsBoard() : await loadStatsBoard(tab);
    if (lbTab !== tab) return; // user switched tabs while this one loaded
    if (board.empty) { list.innerHTML = board.empty; return; }
    lbRows = board.rows;
    renderLeaderboardList();
  } catch (err) {
    console.error("[leaderboard]", err);
    if (lbTab === tab) list.innerHTML = '<div class="lb-empty">Could not load the leaderboard — try again.</div>';
  }
}

// Applies the wallet/name filter and the "YOUR WALLET" toggle to the loaded
// rows. Purely client-side: switching filters never refetches.
function renderLeaderboardList() {
  const list = document.getElementById("leaderboardList");
  if (!list) return;
  let rows = lbRows;
  if (lbMineOnly) rows = rows.filter((x) => x.r.is_me);
  const q = lbFilterQuery.trim().toLowerCase();
  if (q) rows = rows.filter((x) => x.search.includes(q));
  if (!rows.length && lbRows.length) {
    list.innerHTML = lbMineOnly && !lbRows.some((x) => x.r.is_me)
      ? '<div class="lb-empty">Your wallet isn\'t on this board yet.</div>'
      : '<div class="lb-empty">No fighters match that filter.</div>';
    return;
  }
  list.innerHTML = rows.map((x) => lbRowHtml(x.rank, x.r, x.mid, x.value)).join("");
}

function lbRowHtml(rank, r, mid, value) {
  return `<div class="lb-row${r.is_me ? " lb-me" : ""}">` +
    `<span class="lb-rank">#${rank}</span>` +
    `<span class="lb-name">${escapeHtml(r.display_name)}${r.is_me ? '<span class="lb-you-tag">YOU</span>' : ""}</span>` +
    `<span class="lb-level">${mid}</span>` +
    `<span class="lb-points">${value}</span>` +
    `</div>`;
}

// Points and wins tabs — ranked server-side by the get_leaderboard RPC.
async function loadStatsBoard(tab) {
  const { data, error } = await supabase.rpc("get_leaderboard", { p_limit: 20, p_sort: tab });
  if (error || !Array.isArray(data)) throw error ?? new Error("bad get_leaderboard response");
  if (!data.length) return { empty: '<div class="lb-empty">No fighters ranked yet — win matches to get on the board.</div>' };
  return { rows: data.map((r) => {
    const games = (r.wins ?? 0) + (r.losses ?? 0);
    const value = tab === "wins"
      ? `${r.wins} W · ${games ? Math.round((r.wins / games) * 100) : 0}%`
      : `${Number(r.points).toLocaleString()} PTS`;
    return { rank: r.rank, r, mid: `LVL ${r.level}`, value, search: (r.display_name ?? "").toLowerCase() };
  }) };
}

// Holdings tab — balances live on-chain, so rank client-side: one ERC-20
// balanceOf read per wallet, all in parallel against the read provider.
async function loadHoldingsBoard() {
  if (FIGHT10_TOKEN.startsWith("<")) return { empty: '<div class="lb-empty">Holder rankings go live at token launch.</div>' };
  const { data, error } = await supabase.rpc("get_holdings_wallets", { p_limit: 100 });
  if (error || !Array.isArray(data)) throw error ?? new Error("bad get_holdings_wallets response");
  // wallet_address may carry a "chain:" prefix (e.g. "ethereum:0x…") —
  // same normalization as the deposit flow: keep only the address tail.
  const holders = data
    .map((r) => ({ ...r, addr: normWallet(r.wallet_address) }))
    .filter((r) => /^0x[0-9a-f]{40}$/.test(r.addr)); // skip malformed addresses
  if (!holders.length) return { empty: '<div class="lb-empty">No holders ranked yet — connect a wallet and grab some $FIGHT10.</div>' };
  const token = await getFight10Contract();
  // A failed read ranks that wallet as zero rather than sinking the board.
  const entries = await Promise.all(holders.map(async (r) => {
    try { return { r, balance: BigInt(await token.balanceOf(r.addr)) }; }
    catch { return { r, balance: 0n }; }
  }));
  const ranked = entries.filter((e) => e.balance > 0n)
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0))
    .slice(0, 20);
  if (!ranked.length) return { empty: '<div class="lb-empty">No holders ranked yet — grab some $FIGHT10 to top this board.</div>' };
  return { rows: ranked.map((e, i) => {
    const amt = (Number(e.balance) / 10 ** FIGHT10_DECIMALS).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const w = e.r.addr;
    return {
      rank: i + 1,
      r: e.r,
      mid: `${w.slice(0, 6)}…${w.slice(-4)}`,
      value: `${amt} F10`,
      search: `${(e.r.display_name ?? "").toLowerCase()} ${w.toLowerCase()}`,
    };
  }) };
}

async function fetchLobbyCounts() {
  const { data: matches, error } = await supabase
    .from("matches")
    .select("id, max_players")
    .eq("status", "waiting");
  if (error || !matches) return;
  const matchIds = matches.map((m) => m.id);
  const sizeOf = Object.fromEntries(matches.map((m) => [m.id, m.max_players]));
  const counts = { 2: 0, 5: 0, 10: 0 };
  if (matchIds.length > 0) {
    const { data: players } = await supabase
      .from("match_players")
      .select("match_id")
      .in("match_id", matchIds);
    (players || []).forEach((p) => {
      const sz = sizeOf[p.match_id];
      if (sz) counts[sz] = (counts[sz] || 0) + 1;
    });
  }
  [2, 5, 10].forEach((sz) => {
    const el = document.getElementById("pvpWaiting" + sz);
    if (!el) return;
    el.textContent = counts[sz] > 0 ? counts[sz] + " waiting" : "";
  });
}

// Returns this wallet's open ('waiting'/'active') seat as
// { match_id, seat, status, max_players }, or null. RLS lets a member read
// their own match rows, so this works even for a not-yet-visible lobby.
async function findMyOpenSeat() {
  const { data, error } = await supabase
    .from("match_players")
    .select("match_id, seat, matches!inner(status, max_players)")
    .eq("user_id", state.user.id)
    .in("matches.status", ["waiting", "active"])
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return {
    match_id: data.match_id,
    seat: data.seat,
    status: data.matches.status,
    max_players: data.matches.max_players,
  };
}

async function joinPvp(maxPlayers) {
  if (!state.user) { signIn(); return; }
  const size = [2, 5, 10].includes(maxPlayers) ? maxPlayers : 2;
  // Block banned wallets before any on-chain deposit so they never pay to be
  // rejected. The server re-checks at admission (this is just UX).
  try {
    const { data: banned } = await supabase.rpc("is_banned", { p_user_id: state.user.id });
    if (banned === true) { setStatus("This wallet is banned from play."); return; }
  } catch (_) { /* if the check is unavailable, fall through to server enforcement */ }
  try {
    // ── Step 0: resume any seat we already hold BEFORE paying ────────────────
    // The entry fee is non-refundable, and join_pvp_match returns the existing
    // seat ("rejoining") when this wallet already holds one — so paying first
    // would burn a second deposit only to land back in the same match. If that
    // match is actually over (e.g. everyone disconnected and nobody nudged
    // settlement), try_finalize settles it and we fall through to a fresh join.
    if (!state.pendingDepositTx) {
      let open = null;
      try {
        open = await findMyOpenSeat();
        if (open && open.status === "active") {
          // Idempotent: only settles a match that is really over/abandoned.
          try { await supabase.rpc("try_finalize", { p_match_id: open.match_id }); } catch (_) {}
          const { data: m } = await supabase
            .from("matches").select("status").eq("id", open.match_id).maybeSingle();
          if (m?.status) open.status = m.status;
        }
      } catch (_) {
        open = null; // best-effort; the server-side rejoin check still applies
      }
      if (open && (open.status === "waiting" || open.status === "active")) {
        showPvpLobby("Resuming your existing match…");
        state.match = {
          id: open.match_id, mode: "pvp", finished: false,
          status: open.status, maxPlayers: open.max_players
        };
        state.seat = open.seat;
        await enterArena(open.match_id, false);
        return;
      }
      // Any old match just settled (finished/disputed) — join fresh below.
    }

    // ── Step 1: deposit on-chain (if not already done from a previous failed attempt) ──
    let txSig = state.pendingDepositTx;
    if (!txSig) {
      // Capacity check BEFORE payment — the entry fee is non-refundable, so a
      // full server must never even get to the payment prompt. Advisory only:
      // join_pvp_match enforces the real cap server-side, so a failure here
      // (or a race that lets someone slip past) just falls through to that
      // authoritative check instead of wrongly blocking a legitimate join.
      try {
        const { data: capacity } = await supabase.rpc("pvp_capacity");
        if (capacity && capacity.active >= capacity.cap) {
          setStatus(`Servers are full (${capacity.active}/${capacity.cap} players online). Try again in a few minutes.`);
          return;
        }
      } catch (_) { /* best-effort; server-side join_pvp_match is authoritative */ }
      // Warn BEFORE payment — the entry fee is non-refundable once paid.
      // Uses the non-blocking confirmDialog (window.confirm freezes the render loop).
      const ok = await confirmDialog(
        "Heads up: the 2,500 $FIGHT10 entry fee is NON-REFUNDABLE. " +
        "Once you pay, leaving the queue or the match will NOT refund your entry. " +
        "Continue and pay the entry fee?"
      );
      if (!ok) return;
      showPvpLobby("Preparing deposit…");
      txSig = await depositEntryFee(size);
      if (!txSig) {
        hidePvpLobby();
        return; // depositEntryFee already set the error/cancel status
      }
      // depositEntryFee persisted the signature (memory + localStorage) the
      // moment it confirmed, so a network failure — or a full reload — before
      // the join lands never forces a re-payment.
    } else {
      showPvpLobby("Retrying queue entry with confirmed deposit…");
    }

    // ── Step 2: enter the queue with the confirmed deposit ────────────────────
    // The deposit is verified on-chain by the f10join edge function BEFORE a seat
    // is taken — the browser never calls join_pvp_match directly, so a fake tx
    // signature can't fill a lobby.
    showPvpLobby(`Finding a ${size}-player match…`);
    const { data: resp, error } = await supabase.functions.invoke("f10join", {
      body: {
        max_players: size,
        deposit_tx: txSig,
        deposit_wallet: state.pendingDepositWallet,
        display_name: state.profile?.display_name ?? null,
      },
    });
    if (error) throw error;
    if (!resp?.ok) throw new Error(resp?.error || "Could not join a PvP match.");
    const data = resp;

    // Joined successfully — the deposit is spent; clear it everywhere.
    savePendingDeposit(null, null);

    state.match = {
      id: data.match_id, mode: "pvp", finished: false,
      status: data.status === "active" ? "active" : "waiting",
      maxPlayers: data.max_players || size
    };
    state.seat = data.seat;

    // Pass iRoomFiller into enterArena; teardownMatch inside it resets the flag
    // so it must be restored there, after the reset, before loadRoster() runs.
    // data.rejoining is set when we're resuming an existing match, not filling the room.
    await enterArena(data.match_id, data.status === "active" && !data.rejoining);
  } catch (err) {
    hidePvpLobby();
    console.error("[joinPvp]", err);
    // state.pendingDepositTx is intentionally kept: if the deposit confirmed but
    // join_pvp_match failed (network blip), the next click retries the join
    // without asking for another on-chain payment.
    state.match = null;
    state.seat = null;
    setStatus(
      state.pendingDepositTx
        ? "Queue entry failed — click Play Again to retry (no extra payment needed)."
        : (err.message || "Could not join a PvP match.")
    );
  }
}

// ---------------------------------------------------------------------------
// FIGHT10 deposit — transfer ENTRY_FEE from player wallet to escrow on-chain
// Poll eth_getTransactionReceipt over HTTP — no WebSocket subscriptions needed.
// Errors are tagged so callers can tell a DEFINITIVE on-chain failure (tx
// reverted — tokens never moved, safe to forget the hash) from a timeout /
// RPC hiccup (the tx may still land — the hash must be kept).
async function pollTxConfirmation(provider, txHash, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
    if (receipt) {
      if (receipt.status === 0) {
        const e = new Error("Transaction reverted on-chain: " + txHash);
        e.failedOnChain = true;
        throw e;
      }
      return receipt; // included with status 1 — confirmed
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  const e = new Error(`Tx not confirmed after ${timeoutMs / 1000}s — hash: ${txHash}`);
  e.confirmTimeout = true;
  throw e;
}

// Transfers 2500 FIGHT10 to the escrow on-chain and waits for confirmation.
// Returns the confirmed tx signature on success, or null if cancelled/failed.
// Does NOT record the deposit in the DB — that happens inside join_pvp_match().
async function depositEntryFee(numPlayers = 2) {
  const wallet = getEthereumWallet();
  const playerAddress = await getWalletAddress(wallet);
  if (!playerAddress) {
    setStatus("Wallet not connected — cannot deposit.");
    return null;
  }

  // One wallet per player: the deposit must come from the same wallet the player
  // signed in with. Catch a mismatch here (before any on-chain payment) so the
  // user isn't charged only to be rejected by join_pvp_match. wallet_address may
  // carry a "chain:" prefix (e.g. "ethereum:0x…") — compare the lowercased
  // address tail (Ethereum addresses are case-insensitive).
  const loginWallet = normWallet(state.profile?.wallet_address);
  if (loginWallet && playerAddress !== loginWallet) {
    setStatus("Wrong wallet — switch back to your signed-in wallet to deposit, or sign out and sign in with this one.");
    return null;
  }

  if (FIGHT10_TOKEN.startsWith("<") || ESCROW_WALLET.startsWith("<")) {
    setStatus("Game not configured for live deposits yet (missing token/escrow address).");
    return null;
  }

  setStatus("Checking $FIGHT10 balance…");
  let balance;
  try {
    balance = await getFight10Balance(playerAddress);
  } catch (err) {
    console.error("[getFight10Balance]", err);
    setStatus("Could not check $FIGHT10 balance — " + (err?.message || "try again."));
    return null;
  }
  if (balance < ENTRY_FEE_RAW) {
    const have = Number(balance) / 10 ** FIGHT10_DECIMALS;
    setStatus(`Insufficient $FIGHT10 balance — need 2,500, have ${have.toFixed(0)}.`);
    showBuyFight10(have);
    return null;
  }

  try {
    updatePrizePot(numPlayers);
    setStatus("Depositing 2,500 $FIGHT10… approve in wallet.");
    els.pvpLobbyStatus.textContent = "Approve deposit in your wallet…";

    // The deposit must land on the configured Robinhood Chain network —
    // prompt a switch (or one-time add) before asking for a signature.
    await ensureNetwork(wallet);

    const ethers = await loadEthers();
    const browserProvider = new ethers.BrowserProvider(wallet);
    const signer = await browserProvider.getSigner();
    const token = new ethers.Contract(FIGHT10_TOKEN, ERC20_ABI, signer);
    const tx = await token.transfer(ESCROW_WALLET, ENTRY_FEE_RAW);
    const txHash = tx.hash;

    // Persist the hash + signing wallet the moment the tx is broadcast
    // (memory AND localStorage), BEFORE waiting for confirmation. If the poll
    // below times out (congestion / RPC hiccup) but the transfer lands anyway,
    // an unsaved hash would mean the player pays AGAIN on the next attempt.
    // f10join re-verifies confirmation server-side either way, and a
    // definitive on-chain failure clears the saved hash in the catch.
    savePendingDeposit(txHash, playerAddress);

    setStatus("Confirming deposit on-chain…");
    els.pvpLobbyStatus.textContent = "Confirming on-chain…";
    await pollTxConfirmation(await getReadProvider(), txHash);

    setStatus("Deposit confirmed — entering queue.");
    return txHash;
  } catch (err) {
    console.error("[depositEntryFee]", err);
    const msg = err?.message || String(err);
    if (err?.failedOnChain) {
      // The tx landed on-chain as a FAILURE — no tokens moved, so the saved
      // hash is worthless; forget it to keep the next attempt clean.
      savePendingDeposit(null, null);
      setStatus("Deposit failed on-chain — you were not charged. Try again.");
    } else if (err?.code === 4001 || err?.code === "ACTION_REJECTED" || /user rejected|cancelled/i.test(msg)) {
      setStatus("Deposit cancelled.");
    } else if (state.pendingDepositTx) {
      // Broadcast but not (yet) confirmed. The signature is saved, so the next
      // Play PvP click retries the join with it instead of charging again.
      setStatus("Deposit sent but not confirmed yet — your payment is saved. Click Play PvP again in a moment to retry without paying twice.");
    } else {
      setStatus("Deposit failed: " + msg);
    }
    return null;
  }
}

async function getFight10Balance(walletAddress) {
  const token = await getFight10Contract();
  return BigInt(await token.balanceOf(walletAddress));
}

function updatePrizePot(numPlayers) {
  const potEl = document.getElementById("pvpPrizePool");
  const amtEl = document.getElementById("pvpPrizeAmount");
  if (!potEl || !amtEl) return;
  // Show what the winner actually receives (the treasurer pays WINNER_SHARE of
  // the pot), not the raw pot — the two must never be conflated in the UI.
  amtEl.textContent = Math.floor(numPlayers * ENTRY_FEE * WINNER_SHARE).toLocaleString();
  potEl.classList.remove("hidden");
}

async function refreshFight10Balance() {
  const balEl = document.getElementById("fight10Balance");
  if (!balEl || !state.user) return;
  const addr = await getWalletAddress();
  if (!addr) return;
  try {
    const raw = await getFight10Balance(addr);
    balEl.textContent = (Number(raw) / 10 ** FIGHT10_DECIMALS).toLocaleString(undefined, { maximumFractionDigits: 0 }) + " $FIGHT10";
    balEl.classList.remove("hidden");
  } catch (err) {
    console.error("[refreshFight10Balance]", err);
  }
}

// Fills the profile "$FIGHT10" tab: on-chain balance plus the wallet it came from.
async function loadHoldings() {
  const amtEl    = document.getElementById("holdingsAmount");
  const walletEl = document.getElementById("holdingsWallet");
  const noteEl   = document.getElementById("holdingsNote");
  if (!amtEl) return;
  const addr = await getWalletAddress();
  if (walletEl) walletEl.textContent = addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "";
  if (!addr) {
    amtEl.textContent = "—";
    if (noteEl) noteEl.textContent = "Connect your wallet to see your holdings.";
    return;
  }
  if (FIGHT10_TOKEN.startsWith("<")) {
    amtEl.textContent = "—";
    if (noteEl) noteEl.textContent = "Live balances go on-chain at token launch.";
    return;
  }
  amtEl.textContent = "…";
  if (noteEl) noteEl.textContent = "";
  try {
    const raw = await getFight10Balance(addr);
    amtEl.textContent = (Number(raw) / 10 ** FIGHT10_DECIMALS).toLocaleString(undefined, { maximumFractionDigits: 0 });
  } catch (err) {
    console.error("[loadHoldings]", err);
    amtEl.textContent = "—";
    if (noteEl) noteEl.textContent = "Could not load balance — reopen the tab to retry.";
  }
}

async function enterArena(matchId, iRoomFiller = false) {
  await teardownMatch(true);
  // teardownMatch resets iRoomFiller; restore it now so loadRoster() sees
  // the correct value when deciding who broadcasts the "start" event.
  state.iRoomFiller = iRoomFiller;
  state.remoteIds.clear();
  state.started = false;
  // Stay in lobby view while waiting; setView("game") fires when the room fills.
  game.setLocalUser({ userId: state.user.id, displayName: state.profile?.display_name || "You", level: localLevel() });
  game.usePvpFoes();
  game.setMatchPhase("waiting");

  state.channel = supabase.channel(`match-${matchId}`, {
    config: { broadcast: { self: false }, presence: { key: state.user.id } }
  });
  state.channel
    .on("broadcast", { event: "state" }, ({ payload }) => {
      if (payload?.userId && payload.userId !== state.user.id) game.receivePlayerState(payload.userId, payload.snapshot);
    })
    .on("broadcast", { event: "attack" }, ({ payload }) => game.receiveAttack(payload))
    .on("broadcast", { event: "start" }, ({ payload }) => beginMatch(false, payload?.startAt))
    .on("broadcast", { event: "match-over" }, () => { handleMatchOver().catch(console.error); })
    // Echo pings back so the sender can measure RTT
    .on("broadcast", { event: "ping" }, ({ payload }) => {
      if (payload?.from !== state.user?.id) {
        state.channel.send({ type: "broadcast", event: "ping-echo", payload: { nonce: payload?.nonce } });
      }
    })
    .on("presence", { event: "sync" }, () => { loadRoster(matchId).catch((e) => console.error(e)); })
    .on("presence", { event: "leave" }, ({ leftPresences }) => {
      (leftPresences || []).forEach((p) => { if (state.remoteIds.has(p.user_id)) handleOpponentLeft(p.user_id); });
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") state.channel.track({ user_id: state.user.id, display_name: state.profile?.display_name });
    });

  await loadRoster(matchId);
}

async function loadRoster(matchId) {
  const [matchRes, playersRes] = await Promise.all([
    supabase.from("matches").select("status, max_players, match_no").eq("id", matchId).maybeSingle(),
    supabase.from("match_players").select("user_id, seat, display_name").eq("match_id", matchId).order("seat", { ascending: true })
  ]);
  if (playersRes.error) { console.warn(playersRes.error); return; }
  const players = playersRes.data || [];
  const matchRow = matchRes.data;
  const max = matchRow?.max_players || state.match?.maxPlayers || 2;
  if (state.match) state.match.maxPlayers = max;
  // Friendly match number — shown in the HUD and on the result screen so the
  // match can be referenced in history/support.
  if (state.match && matchRow?.match_no) {
    state.match.matchNo = matchRow.match_no;
    game.setMatchNumber(matchRow.match_no);
  }

  // Add any opponents we haven't seen yet (removals come via presence leave).
  for (const p of players) {
    if (p.user_id === state.user.id) continue;
    state.remoteNames.set(p.user_id, p.display_name);
    if (!state.remoteIds.has(p.user_id)) {
      // Re-adding a rival we already saw this match means they reconnected.
      const returning = state.started && state.remoteSeen.has(p.user_id);
      state.remoteIds.add(p.user_id);
      state.remoteSeen.add(p.user_id);
      game.addOpponent({ userId: p.user_id, displayName: p.display_name, seat: p.seat, matchId: state.match?.id });
      if (returning) setStatus(`${p.display_name} reconnected.`);
    }
  }

  renderLobbyPlayers(players, max);

  if (matchRow?.status === "active") {
    // All seats filled = all players have paid (deposit is recorded at join time).
    clearInterval(state.depositPollTimer);
    state.depositPollTimer = null;
    if (state.iRoomFiller) {
      // Room-filler owns the start: broadcasts a shared startAt so all clients
      // count down to the same wall-clock moment.
      beginMatch(false);
    } else if (!state.started && !state.startFallbackTimer) {
      // Non-room-fillers wait for the "start" broadcast. Fall back after 4.5s
      // in case the broadcast is dropped.
      state.startFallbackTimer = setTimeout(() => {
        state.startFallbackTimer = null;
        if (!state.started) beginMatch(true);
      }, 4500);
    }
  } else {
    // Still waiting for more players to join and pay.
    els.pvpLobbyStatus.textContent = "Waiting for players…";
    els.pvpLobbyMeta.textContent = `${players.length} / ${max} paid and ready`;
    // We've paid and are in the queue — remind that leaving forfeits the entry.
    els.pvpLobbyWarning?.classList.remove("hidden");
    if (!state.depositPollTimer) {
      // Poll for up to 10 minutes; after that bail out so the lobby doesn't wait forever.
      const POLL_TIMEOUT_MS = 10 * 60 * 1000;
      const pollStart = Date.now();
      state.depositPollTimer = setInterval(() => {
        if (Date.now() - pollStart > POLL_TIMEOUT_MS) {
          clearInterval(state.depositPollTimer);
          state.depositPollTimer = null;
          hidePvpLobby();
          setStatus("Lobby timed out — not enough players joined. Please try again.");
          leaveMatch({ silent: true });
          return;
        }
        loadRoster(matchId).catch(console.error);
      }, 2500);
    }
  }
}

// One row per joined wallet (a wallet can only hold one seat at a time).
function renderLobbyPlayers(players, max) {
  els.lobbyPlayers.innerHTML = "";
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  for (const p of sorted) {
    const row = document.createElement("div");
    row.className = "lobby-player" + (p.user_id === state.user.id ? " is-you" : "");
    row.innerHTML =
      `<span class="lp-dot"></span>` +
      `<span class="lp-name">${escapeHtml(p.display_name)}${p.user_id === state.user.id ? " (you)" : ""}</span>`;
    els.lobbyPlayers.appendChild(row);
  }
  for (let i = sorted.length; i < max; i++) {
    const row = document.createElement("div");
    row.className = "lobby-player lp-empty";
    row.innerHTML = `<span class="lp-dot"></span><span class="lp-name">Waiting…</span>`;
    els.lobbyPlayers.appendChild(row);
  }
}

// Per-size match length: 2p → 5min, 5p → 10min, 10p → 15min.
// Match length for a lobby size, from match_config (single source of truth,
// shared with the server's settlement deadline). When the timer hits 0 the
// client reports in and the server settles from the ledger at once.
function matchDuration(max) {
  return state.matchDurations[max] ?? state.matchDurations[2] ?? 300;
}

// Flip from the waiting lobby into the live arena (once only), behind a short
// "MATCH STARTING" transition so every client starts together.
function startPingLoop() {
  stopPingLoop();

  // Pending echo callbacks keyed by nonce
  const pending = new Map();

  // Listen for ping-echo on the current match channel
  if (state.channel) {
    state.channel.on("broadcast", { event: "ping-echo" }, ({ payload }) => {
      const cb = pending.get(payload?.nonce);
      if (cb) { cb(); pending.delete(payload?.nonce); }
    });
  }

  const probe = async () => {
    // Use Realtime broadcast round-trip when in a match channel
    if (state.channel) {
      const nonce = Math.random().toString(36).slice(2);
      const t0 = performance.now();
      const timeout = setTimeout(() => { pending.delete(nonce); }, 4000);
      pending.set(nonce, () => {
        clearTimeout(timeout);
        game.setPing(Math.round(performance.now() - t0));
      });
      state.channel.send({ type: "broadcast", event: "ping", payload: { nonce, from: state.user?.id } });
    } else {
      // Fallback: plain Supabase HTTP round-trip
      try {
        const t0 = performance.now();
        await supabase.from("profiles").select("user_id").eq("user_id", state.user?.id).limit(1);
        game.setPing(Math.round(performance.now() - t0));
      } catch (_) {}
    }
  };

  probe();
  state.pingInterval = setInterval(probe, 3000);
}

function stopPingLoop() {
  if (state.pingInterval) { clearInterval(state.pingInterval); state.pingInterval = null; }
  game.setPing(null);
}

async function beginMatch(skipCountdown = false, startAt = null) {
  if (state.started) return;
  state.started = true;
  if (state.startFallbackTimer) { clearTimeout(state.startFallbackTimer); state.startFallbackTimer = null; }
  if (state.match) state.match.status = "active";
  // Tell every other client to start too (presence sync alone can miss one).
  // Only the room-filler triggers the start broadcast; every other client that
  // receives it and calls beginMatch() must NOT re-broadcast, otherwise each
  // peer triggers another round of start events (O(N²) messages in a 10-player game).
  // startAt is a shared wall-clock timestamp so all clients enter "active" simultaneously.
  if (state.iRoomFiller) {
    const broadcastStartAt = Date.now() + 3000;
    state.channel?.send({ type: "broadcast", event: "start", payload: { startAt: broadcastStartAt } });
    startAt = broadcastStartAt;
  }
  hidePvpLobby();
  game.setView("game");
  // Re-assert PvP arena state right before the reset: anything that flipped
  // the arena back to the AI showcase during the waiting lobby (a stray auth
  // refresh, an overlapping UI flow) would otherwise start the match with
  // foeMode "ai" — invisible rivals, a leftover Raider, and a frozen player.
  game.usePvpFoes();
  game.setMode("player");
  game.generateMap(state.match?.id || "pvp");  // seed by match id so all clients match
  game.resetForMatch(state.match?.id, state.seat);
  ledger.reset();
  // Never let anti-cheat / heartbeat setup abort the match start (which would
  // leave the player uncontrollable).
  if (state.match?.mode === "pvp") {
    try { startIntegrityWatch(); } catch (e) { console.error(e); }
    try { startHeartbeat(state.match?.id); } catch (e) { console.error(e); }
  }
  game.setMatchPhase("countdown");
  game.setControllable(false);
  startPingLoop();

  // Anchor the visible countdown to the server deadline (started_at + duration)
  // so it matches the settlement time exactly and stays correct across tab
  // switches. Falls back to a local clock if started_at can't be read.
  const dur = matchDuration(state.match?.maxPlayers || 2);
  let endsAtMs = Date.now() + dur * 1000;
  try {
    const { data } = await supabase.from("matches").select("started_at").eq("id", state.match?.id).single();
    if (data?.started_at) endsAtMs = Date.parse(data.started_at) + dur * 1000;
  } catch (_) { /* keep the local fallback */ }
  if (state.match) state.match.endsAtMs = endsAtMs;

  if (skipCountdown) {
    // Late joiner who missed the "start" broadcast — match already in progress,
    // drop straight into active rather than showing a stale countdown.
    game.setMatchPhase("active");
    game.setControllable(true);
    game.setMatchTimer(dur, endsAtMs);
    setStatus("Fight! Last one standing wins.");
  } else {
    runMatchStart(() => {
      game.setMatchPhase("active");
      game.setControllable(true);
      game.setMatchTimer(dur, endsAtMs);
      setStatus("Fight! Last one standing wins.");
      showGlhf();
    }, startAt);
  }
}

// ---------------------------------------------------------------------------
// Result handling (PvP only) — loser is whoever hits 0 HP or disconnects
// ---------------------------------------------------------------------------
// A rival dropped the connection: remove their avatar. If they were the last
// rival and we're still standing, report our result so the server settles — the
// disconnected player is excluded server-side (stale heartbeat) and we win.
// If the server has ALREADY settled, surface its authoritative verdict instead
// of assuming a win.
async function handleOpponentLeft(userId) {
  state.remoteIds.delete(userId);
  const remaining = game.removeOpponent(userId);
  if (state.match?.mode !== "pvp" || state.match.finished || !state.started) return;
  // Tell the player what just happened instead of the rival silently vanishing.
  // Server rule: a disconnected player is eliminated once their heartbeat goes
  // stale (~15s) — unless they reconnect first, which loadRoster announces.
  const name = state.remoteNames.get(userId) || "A rival";
  if (remaining > 0) {
    setStatus(`${name} disconnected — they're eliminated unless they reconnect shortly.`);
  } else if (game.playerAlive()) {
    setStatus(`${name} disconnected — you're the last one standing. Claiming the win…`);
  }
  if (remaining === 0 && game.playerAlive()) {
    const { data: matchRow } = await supabase
      .from("matches")
      .select("status, winner_user_id")
      .eq("id", state.match.id)
      .maybeSingle();
    if (matchRow?.status === "finished" || matchRow?.status === "disputed") {
      if (matchRow.winner_user_id !== state.user?.id) {
        reportResult("loss", { standings: game.standings() }).catch(console.error);
      }
      return;
    }
    // Rival genuinely disconnected mid-game — report and let the server crown us
    // (walkover / ledger-backed win once their heartbeat goes stale).
    reportResult("win", { standings: game.standings() }).catch((e) => console.error(e));
  }
}

// A peer signalled the match is over (someone won, or the timer crowned a
// winner). The broadcast itself is UNAUTHENTICATED — any client in the channel
// can send it — so it is treated as a hint, never as truth. Before reporting we
// verify against the server: either the match row is already settled, or the
// combat ledger (which only opponents can write about us) shows we took lethal
// damage. A spoofed early "match-over" fails both checks and is ignored, so a
// griefer can no longer push every honest client into reporting seconds into
// the match and voiding it. (finalize_match has a matching server-side guard.)
async function handleMatchOver() {
  if (state.match?.mode !== "pvp" || !state.match.id || state.match.finished) return;
  const matchId = state.match.id;

  // Settled already? Reconcile with the authoritative verdict.
  try {
    const { data: row } = await supabase
      .from("matches").select("status").eq("id", matchId).maybeSingle();
    if (row?.status === "finished" || row?.status === "disputed") {
      await reportResult("loss", { standings: game.standings() });
      return;
    }
  } catch (_) { /* fall through to the ledger check */ }

  // Not settled. If we're locally alive, only accept the signal when the
  // ledger AND our own state agree we're (nearly) dead — a true desync means
  // we missed a packet or two, not most of our health. A lethal ledger total
  // against a locally-healthy player is fabricated offense (rows invented to
  // stay under the settlement rate caps), not a desync: keep playing, log it,
  // and let settlement's self-report corroboration dispute the match instead
  // of conceding to it. The sender flushes their ledger BEFORE broadcasting,
  // so a genuine kill is always visible here by the time the event arrives.
  if (game.playerAlive()) {
    let received = 0;
    try {
      const { data: dmg } = await supabase
        .from("match_damage").select("total_damage")
        .eq("match_id", matchId).eq("victim", state.user.id);
      received = (dmg || []).reduce((sum, r) => sum + (r.total_damage || 0), 0);
    } catch (_) {}
    if (received < 100 || game.currentHp() > 25) {
      // Premature, spoofed, or implausible — keep playing, log it for review.
      reportIntegritySignal("spoofed_match_over", { received, local_hp: game.currentHp() });
      return;
    }
  }

  // Conceding to a ledger-verified death: report HP 0 (we accept the ledger's
  // verdict) so the self-report matches the ledger and can't trip the
  // settlement mismatch check over the few packets we missed.
  await reportResult("loss", { standings: game.standings(), finalHp: 0 });
}

// Phase 2: the winner is decided SERVER-SIDE from the combat ledger. Each
// participant reports "done" + flushes its offense ledger; the server derives
// HP from what *others* dealt and crowns the winner (or marks the match
// 'disputed' when the ledger is implausible). The client never trusts its own
// win/loss detection for the result — `resultHint` only chooses whether to show
// the winner's suspense spinner; the screen shown comes from the server verdict.
async function reportResult(resultHint, { standings = [], finalHp = null } = {}) {
  if (state.match?.mode !== "pvp" || !state.match.id || state.match.finished) return;
  state.match.finished = true;
  const matchId = state.match.id;

  // Capture the match summary at the moment it ends, before any awaits inflate it.
  const matchKills = ledger.kills.size;
  const matchTimeMs = ledger.startMs ? Date.now() - ledger.startMs : 0;

  // Flush our offense ledger, then report "done". final_hp no longer decides
  // the winner, but settlement now CORROBORATES it against the ledger-derived
  // HP: a loser whose self-report sits far above the damage others claim to
  // have dealt them marks the match disputed (fabricated-offense guard).
  // finalHp overrides the local value when the caller has already reconciled
  // with the ledger (e.g. conceding a verified death as 0).
  await flushLedger(matchId);
  if (_kicked) return; // flushLedger removed us for a server-flagged manipulation
  try {
    const { error } = await supabase.rpc("finish_match", {
      p_match_id: matchId,
      p_final_hp: finalHp ?? game.currentHp(),
    });
    if (error) {
      if (isIntegrityError(error)) return kickForManipulation("Removed: invalid actions detected.");
      console.error("finish_match error:", error);
    }
  } catch (e) {
    if (isIntegrityError(e)) return kickForManipulation("Removed: invalid actions detected.");
    console.error("finish_match error:", e);
  }

  // If we believe we won, nudge everyone else to report so the server can settle
  // without waiting on stragglers.
  if (resultHint === "win") {
    state.channel?.send({ type: "broadcast", event: "match-over" });
    await showResultsSuspense(2000); // suspense before the verdict; overlay stays up
  }

  // A player eliminated mid-match in a bigger lobby waits for the survivors to
  // finish — settlement can legitimately be minutes away, not seconds. Poll
  // until the match's own deadline (+ grace for the settle itself), and show an
  // interim "eliminated" card so the wait is explained instead of the old
  // behavior (24s timeout → a confusing "still settling" dead end). The card is
  // re-rendered with the real verdict below once the server settles.
  const remainingMs = Math.max(0, (state.match?.endsAtMs ?? 0) - Date.now());
  if (resultHint !== "win" && remainingMs > 5000) {
    hideResultsLoading();
    showGameOver("loss", "Eliminated — the match is still in progress. Final results when it ends.",
      standings, null, matchKills, matchTimeMs);
  } else {
    // Otherwise keep the settlement progress bar on screen for the whole wait.
    // This is the walkover case (a rival who never opened the match): the server
    // holds until their join heartbeat goes stale, which can take several
    // seconds — the bar makes that wait visible instead of a frozen game view.
    showResultsLoading("Settling match…");
  }

  // Read the authoritative verdict.
  const settled = await awaitSettlement(matchId, Math.max(24000, remainingMs + 30000));
  const serverKills = await fetchVerifiedKills(matchId);
  try { await syncProfile(); } catch (e) { console.error(e); }

  // Standings built strictly from the match's real players (bounded ≤ 10), with
  // server-derived HP + duration so both screens agree and no phantom rows appear.
  const matchPlayers = await fetchMatchPlayers(matchId);
  const finalStandings = matchPlayers.length ? buildBoundedStandings(matchPlayers, settled) : standings;
  const srvSecs = settled?.shadow_meta?.secs;
  const finalTimeMs = Number.isFinite(srvSecs) ? Math.round(srvSecs * 1000) : matchTimeMs;

  // Disputed: the ledger could not produce a clean, plausible winner (e.g. a
  // cheat was detected). Nobody is paid; deposits are held.
  if (settled?.status === "disputed") {
    showGameOver("disputed", "Match disputed — no winner could be verified. Deposits are held for review.",
      finalStandings, null, serverKills ?? matchKills, finalTimeMs);
    return;
  }

  // Couldn't confirm settlement in time — neutral fallback, no payout.
  if (!settled) {
    showGameOver("disputed", "Result still settling — check your match history shortly.",
      standings, null, serverKills ?? matchKills, matchTimeMs);
    return;
  }

  const won = settled.winner_user_id === state.user?.id;
  if (!won) {
    showGameOver("loss", "You were defeated.", finalStandings, null, serverKills ?? matchKills, finalTimeMs);
    return;
  }

  // Authoritative win → victory screen + payout. Name the walkover case so a
  // fight-less win is explained instead of looking like a glitch.
  const winReason = settled?.shadow_meta?.reason === "walkover"
    ? "All rivals disconnected — you win by walkover."
    : "Last one standing — you won!";
  showGameOver("win", winReason, finalStandings, "pending", serverKills ?? matchKills, finalTimeMs);
  let prizeAmount = null;
  let payoutTx = null;
  let failReason = null;
  try {
    setStatus("Claiming prize…");
    try { refreshGameOverStats(); } catch (e) { console.error(e); }
    const { data: payoutData, error: payoutErr } = await supabase.functions.invoke("f10treasurer", {
      body: { match_id: matchId },
    });
    if (!payoutErr && payoutData?.winner_amount && payoutData?.decimals != null) {
      prizeAmount = Number(payoutData.winner_amount) / 10 ** payoutData.decimals;
      payoutTx = payoutData.payout_tx ?? null;
    } else {
      failReason = await describePayoutFailure(payoutErr, payoutData);
      console.error(`Payout failed (match ${matchId}):`, failReason);
    }
    await syncProfile();
    refreshGameOverStats();
  } catch (error) {
    failReason = String(error?.message || error);
    console.error(error);
  }
  updateGameOverPrize(prizeAmount, payoutTx, failReason);
}

async function leaveMatch({ silent = false, skipConfirm = false } = {}) {
  hidePvpLobby();
  hideGameOver();
  cancelMatchStart();
  if (!state.match) { if (!silent) setStatus("You're not in a match."); return false; }
  if (state.match.mode === "pvp") {
    if (state.match.status === "waiting" && state.pendingDepositTx == null && !silent && !skipConfirm) {
      const ok = await confirmDialog(
        "You have already paid the entry fee. Leaving now forfeits your deposit. Continue?"
      );
      if (!ok) return false;
    }
    try { await supabase.rpc("leave_my_matches"); } catch (error) { console.error(error); }
    try { await syncProfile(); } catch (error) { console.error(error); } // pick up any recorded loss
  }
  await teardownMatch();
  game.clearAll();
  game.showMapToggle(false);
  game.showRaiderCount(false);
  game.setAiCount(1);
  game.setMapVariant("game");
  showLobby();
  if (!silent) setStatus(recordSuffix("Left the match."));
  return true;
}

async function teardownMatch(keepMatch = false) {
  stopPingLoop();
  stopIntegrityWatch();
  stopHeartbeat();
  if (state.depositPollTimer) { clearInterval(state.depositPollTimer); state.depositPollTimer = null; }
  if (state.startFallbackTimer) { clearTimeout(state.startFallbackTimer); state.startFallbackTimer = null; }
  // NB: the pending deposit is deliberately NOT cleared here. Its lifecycle is
  // owned by savePendingDeposit() — cleared exactly when a join succeeds. A
  // teardown (e.g. leaving a demo match) must not wipe the in-memory copy of a
  // still-unused deposit, or the next PvP join would charge the player again.
  if (state.channel) {
    await supabase.removeChannel(state.channel);
    state.channel = null;
  }
  state.remoteIds.clear();
  state.remoteNames.clear();
  state.remoteSeen.clear();
  state.started = false;
  state.iRoomFiller = false;
  game.clearRemote();
  if (!keepMatch) { state.match = null; state.seat = null; }
}

// ---------------------------------------------------------------------------
// Lobby UI
// ---------------------------------------------------------------------------
function showLobby() {
  const connected = !!state.user;
  toggle(els.signInWalletBtn, !connected);
  toggle(els.howToPlayBtn, true);
  toggle(els.profileBtn, connected);
  toggle(els.demoBtn, true);
  // One hero CTA: connects the wallet first, becomes PLAY PVP after —
  // startPvp() falls back to signIn() when no wallet is connected.
  toggle(els.pvpBtn, true);
  els.pvpBtn.textContent = connected ? "PLAY PVP" : "CONNECT WALLET";
  toggle(els.signOutBtn, connected);
  const balEl = document.getElementById("fight10Balance");
  if (balEl && !connected) balEl.classList.add("hidden");
  // Bring the player onto the landing map so it's ready to play the moment the
  // battlefield is clicked.
  game.showHomeScene();
}

// ---------------------------------------------------------------------------
// Profile — edit username (saved to the DB) and view stats
// ---------------------------------------------------------------------------
function openProfile(tab = "stats") {
  if (!state.user) { signIn(); return; }
  renderProfileStats();
  els.profileNameInput.value = state.profile?.display_name || "";
  els.profileHint.textContent = "Saved to your wallet profile. Usernames are unique.";
  els.profileHint.classList.remove("error");
  selectProfileTab(tab);
  els.profileOverlay.classList.add("show");
  if (tab === "stats") els.profileNameInput.focus();
}

function renderProfileStats() {
  const p = state.profile || {};
  const wins = p.wins ?? 0;
  const losses = p.losses ?? 0;
  const total = wins + losses;
  els.profileWins.textContent = wins;
  els.profileLosses.textContent = losses;
  els.profileWinRate.textContent = total ? `${Math.round((wins / total) * 100)}%` : "—";
  els.profileGames.textContent = p.games_played ?? 0;
  els.profileStreak.textContent = p.win_streak ?? 0;
  els.profileBest.textContent = p.best_streak ?? 0;

  // Level + progress to next level (triangular curve: L reached at 50*(L-1)*L).
  const points = p.points ?? 0;
  const level = p.level ?? levelForPoints(points);
  const floorPts = cumPointsForLevel(level);
  const nextPts = cumPointsForLevel(level + 1);
  const span = Math.max(1, nextPts - floorPts);
  const into = Math.max(0, points - floorPts);
  els.profileLevel.textContent = level;
  els.profilePoints.textContent = points;
  if (level >= 30) {
    els.profileLevelFill.style.width = "100%";
    els.profileLevelNext.textContent = "MAX LEVEL";
  } else {
    els.profileLevelFill.style.width = `${Math.min(100, (into / span) * 100)}%`;
    els.profileLevelNext.textContent = `${into} / ${span} to level ${level + 1}`;
  }
}

// Mirrors public.level_for_points(): level L is reached at 50*(L-1)*L points.
function levelForPoints(p) {
  return Math.min(30, Math.max(1, Math.floor((1 + Math.sqrt(1 + 0.08 * Math.max(0, p))) / 2)));
}
function cumPointsForLevel(level) {
  return 50 * (level - 1) * level;
}
// The local player's current level, straight from their profile (falling back
// to a points-derived value), for the name tag shown above their fighter.
function localLevel() {
  return state.profile?.level ?? levelForPoints(state.profile?.points ?? 0);
}

// Match history (portfolio): the matches this wallet played, newest first.
async function loadHistory() {
  if (!state.user) return;
  els.pfWins.textContent = `${state.profile?.wins ?? 0} W`;
  els.pfLosses.textContent = `${state.profile?.losses ?? 0} L`;
  els.historyList.innerHTML = '<div class="history-empty">Loading…</div>';
  const { data, error } = await supabase
    .from("match_players")
    .select("joined_at, matches(id, match_no, status, max_players, winner_user_id, ended_at)")
    .eq("user_id", state.user.id)
    .order("joined_at", { ascending: false })
    .limit(25);
  if (error) {
    console.error(error);
    els.historyList.innerHTML = '<div class="history-empty">Could not load history.</div>';
    return;
  }
  const rows = (data || [])
    .map((r) => r.matches)
    .filter((m) => m && (m.status === "finished" || m.status === "disputed"));
  if (!rows.length) {
    els.historyList.innerHTML = '<div class="history-empty">No matches played yet.</div>';
    return;
  }

  // Pull this player's payout records (tx + amount) so wins can link to the
  // on-chain transaction. Keyed by match_id; best-effort.
  const payoutByMatch = {};
  try {
    const { data: payouts } = await supabase
      .from("payouts")
      .select("match_id, payout_tx, amount_raw, decimals")
      .eq("winner_user_id", state.user.id);
    (payouts || []).forEach((p) => { payoutByMatch[p.match_id] = p; });
  } catch (e) { console.error("payouts fetch error:", e); }

  els.historyList.innerHTML = "";
  for (const m of rows) {
    const win = m.winner_user_id === state.user.id;
    const noContest = m.status === "disputed" || !m.winner_user_id;
    const row = document.createElement("div");
    row.className = "history-row " + (noContest ? "hr-void" : win ? "hr-win" : "hr-loss");
    const result = noContest ? "—" : win ? "WIN" : "LOSS";
    const when = m.ended_at ? new Date(m.ended_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
    const label = m.match_no ? `#${m.match_no} · ${m.max_players}-player` : `${m.max_players}-player`;

    // Winner payout: show amount + a link to the on-chain transaction.
    const po = win ? payoutByMatch[m.id] : null;
    let payoutHtml = "";
    if (po?.payout_tx) {
      const amt = Number(po.amount_raw) / 10 ** (po.decimals ?? 6);
      const amtStr = amt.toLocaleString(undefined, { maximumFractionDigits: 0 });
      payoutHtml =
        `<a class="hr-tx" href="${txExplorerUrl(po.payout_tx)}" target="_blank" rel="noopener noreferrer" title="View payout transaction">+${amtStr} ↗</a>`;
    }

    row.innerHTML =
      `<span class="hr-result">${result}</span>` +
      `<span class="hr-mode">${label}</span>` +
      payoutHtml +
      `<span class="hr-date">${when}</span>`;
    els.historyList.appendChild(row);
  }
}

async function saveProfile() {
  const name = els.profileNameInput.value.trim();
  if (name.length < 3 || name.length > 24) {
    els.profileHint.textContent = "Username must be 3–24 characters.";
    els.profileHint.classList.add("error");
    return;
  }
  els.profileSaveBtn.disabled = true;
  try {
    const { data, error } = await supabase.rpc("sync_my_profile", { p_display_name: name });
    if (error) throw error;
    state.profile = data;
    renderProfileStats();
    els.profileHint.textContent = "Saved.";
    els.profileHint.classList.remove("error");
    setStatus(recordSuffix(`Username set to ${state.profile.display_name}.`));
  } catch (error) {
    console.error(error);
    // Uniqueness is enforced server-side: sync_my_profile raises
    // 'username_taken' (or the unique index raises a duplicate-key error).
    const taken = /username_taken|duplicate key/i.test(error?.message || "");
    els.profileHint.textContent = taken
      ? "That username is already taken — try another."
      : error.message || "Could not save username.";
    els.profileHint.classList.add("error");
  } finally {
    els.profileSaveBtn.disabled = false;
  }
}

function recordSuffix(message) {
  if (!state.profile || (state.profile.wins == null && state.profile.losses == null)) return message;
  return `${message}  ·  Record ${state.profile.wins ?? 0}-${state.profile.losses ?? 0}`;
}

// "MATCH STARTING" transition: a fast spinning ring dimming the whole screen
// for 3 seconds while the arena is set up, then the match begins.
let matchStartTimer = null;
function runMatchStart(onDone, startAt = null) {
  const ov = els.matchStarting;
  cancelMatchStart();
  const count = els.matchStartCount;
  const deadline = startAt ?? (Date.now() + 3000);
  ov.classList.add("show");

  function tick() {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    if (remaining <= 0) {
      clearInterval(matchStartTimer);
      matchStartTimer = null;
      ov.classList.remove("show");
      onDone?.();
      return;
    }
    if (count) count.textContent = String(remaining);
  }

  tick();
  // Poll at 200ms so we fire promptly when the deadline passes regardless of drift.
  matchStartTimer = setInterval(tick, 200);
}

function showGlhf() {
  const el = document.getElementById("glhfBanner");
  if (!el) return;
  el.classList.remove("glhf-pop", "glhf-fade");
  requestAnimationFrame(() => {
    el.classList.add("glhf-pop");
    setTimeout(() => {
      el.classList.remove("glhf-pop");
      el.classList.add("glhf-fade");
      setTimeout(() => el.classList.remove("glhf-fade"), 420);
    }, 1500);
  });
}

function cancelMatchStart() {
  clearInterval(matchStartTimer);
  matchStartTimer = null;
  els.matchStarting?.classList.remove("show");
}

function toggle(el, show) {
  if (el) el.classList.toggle("hidden", !show);
}

// Non-blocking replacement for window.confirm() — returns a Promise<boolean>.
function confirmDialog(message) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:center;" +
      "justify-content:center;z-index:9999;font-family:var(--font-body)";
    const box = document.createElement("div");
    box.style.cssText =
      "background:#111;border:1px solid rgba(255,255,255,.18);border-radius:8px;" +
      "padding:28px 32px;max-width:380px;text-align:center;color:#f3f3f3;line-height:1.5";
    const msg = document.createElement("p");
    msg.style.cssText = "margin:0 0 20px;font-size:14px;";
    msg.textContent = message;
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:10px;justify-content:center;";
    const btnOk = document.createElement("button");
    btnOk.textContent = "Confirm";
    btnOk.style.cssText =
      "padding:8px 22px;background:#c8940a;color:#000;border:none;border-radius:5px;cursor:pointer;font-size:13px;";
    const btnCancel = document.createElement("button");
    btnCancel.textContent = "Stay";
    btnCancel.style.cssText =
      "padding:8px 22px;background:rgba(255,255,255,.12);color:#f3f3f3;border:1px solid rgba(255,255,255,.2);border-radius:5px;cursor:pointer;font-size:13px;";
    const close = (result) => { document.body.removeChild(backdrop); resolve(result); };
    btnOk.addEventListener("click", () => close(true));
    btnCancel.addEventListener("click", () => close(false));
    row.append(btnOk, btnCancel);
    box.append(msg, row);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    btnCancel.focus();
  });
}

function setStatus(message) {
  if (els.appStatus) els.appStatus.textContent = message;
  pushLog(message);
}

// Top-left log feed: shows the latest few status lines, each fading out.
function pushLog(message) {
  if (!els.logFeed || !message) return;
  const line = document.createElement("div");
  line.className = "log-line";
  line.textContent = message;
  els.logFeed.appendChild(line);
  while (els.logFeed.children.length > 4) els.logFeed.removeChild(els.logFeed.firstChild);
  setTimeout(() => {
    line.classList.add("fade");
    setTimeout(() => line.remove(), 600);
  }, 4200);
}
