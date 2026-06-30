import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createArenaGame } from "./game.js";
import { escapeHtml } from "./utils.js";
import {
  Connection,
  PublicKey,
  Transaction,
} from "https://esm.sh/@solana/web3.js@1.87.6?bundle";
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "https://esm.sh/@solana/spl-token@0.3.5?bundle";
import { mountViews } from "./views/index.js";

mountViews();

const SUPABASE_URL =
  import.meta.env?.VITE_SUPABASE_URL?.trim() || "https://sajvismyvcgaszjcafcr.supabase.co";
const SUPABASE_ANON_KEY =
  import.meta.env?.VITE_SUPABASE_ANON_KEY?.trim() || "";
if (!SUPABASE_ANON_KEY) console.error("VITE_SUPABASE_ANON_KEY is not set — Supabase calls will fail.");
const SIGN_IN_STATEMENT = "Sign in to FIGHT10 to play realtime PvP duels.";

// ---------------------------------------------------------------------------
// FIGHT10 Tokenomics constants
// Fill in FIGHT10_MINT and ESCROW_WALLET after Pump.fun deploy + keypair gen.
// ---------------------------------------------------------------------------
const FIGHT10_MINT    = import.meta.env?.VITE_FIGHT10_MINT?.trim()   || "<FIGHT10_MINT_ADDRESS>";
const ESCROW_WALLET   = import.meta.env?.VITE_ESCROW_WALLET?.trim()  || "<ESCROW_WALLET_PUBKEY>";
const SOLANA_RPC_URL  = import.meta.env?.VITE_SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
const ENTRY_FEE       = 2500;         // FIGHT10 tokens per player
const FIGHT10_DECIMALS = 6;           // Pump.fun mints always use 6 decimals
const ENTRY_FEE_RAW   = BigInt(ENTRY_FEE) * BigInt(10 ** FIGHT10_DECIMALS);

// Lazy singleton — avoids creating a new WebSocket-backed connection on every call.
let _solanaConn = null;
function getSolanaConn() {
  if (!_solanaConn) _solanaConn = new Connection(SOLANA_RPC_URL, "confirmed");
  return _solanaConn;
}

const els = {
  signInWalletBtn: document.getElementById("signInWalletBtn"),
  connectWalletBtn: document.getElementById("connectWalletBtn"),
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
  lobbyPlayers: document.getElementById("lobbyPlayers"),
  pvpCancelBtn: document.getElementById("pvpCancelBtn"),
  matchStarting: document.getElementById("matchStarting"),
  matchStartCount: document.getElementById("matchStartCount"),
  gameOver: document.getElementById("gameOver"),
  gameOverTitle: document.getElementById("gameOverTitle"),
  gameOverReason: document.getElementById("gameOverReason"),
  gameOverWins: document.getElementById("gameOverWins"),
  gameOverLosses: document.getElementById("gameOverLosses"),
  gameOverName: document.getElementById("gameOverName"),
  gameOverMenuBtn: document.getElementById("gameOverMenuBtn"),
  logFeed: document.getElementById("logFeed")
};

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});

const state = {
  user: null,
  profile: null,
  match: null, // { id, mode: 'demo'|'pvp', status, finished, maxPlayers }
  seat: null,
  remoteIds: new Set(),
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
};

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
  try { if (state.channel) supabase.removeChannel(state.channel); } catch (_) {}
  // Full reload returns the player to a clean menu (the match settles server-side).
  try { window.alert(reason || "You were removed from the match for invalid actions."); } catch (_) {}
  window.location.reload();
}

// Devtools watch during a live match. If the developer console is opened, the
// player is removed from the match with a warning (it does NOT pause the game).
// Detection is non-pausing: a docked DevTools panel opens a large gap between
// the window's outer and inner size. Thresholds are conservative to avoid
// false-positive kicks from normal browser chrome. (Undocked/detached DevTools
// can't be detected this way — server-side authority remains the real defence.)
let _integrityTimer = null;
function startIntegrityWatch() {
  stopIntegrityWatch();
  const check = () => {
    if (_kicked) return;
    const wGap = window.outerWidth - window.innerWidth;
    const hGap = window.outerHeight - window.innerHeight;
    if (wGap > 220 || hGap > 220) {
      reportIntegritySignal("devtools_open", { wGap, hGap });
      kickForManipulation("Do not open the developer console. You have been removed from the match.");
    }
  };
  _integrityTimer = setInterval(check, 1200);
  check();
}
function stopIntegrityWatch() {
  if (_integrityTimer) { clearInterval(_integrityTimer); _integrityTimer = null; }
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
      const { error } = await supabase.from("match_damage").upsert(damageRows, { onConflict: "match_id,attacker,victim" });
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
    if (state.match?.mode === "pvp" && attackEvent?.targetId && attackEvent.fromId === state.user?.id) {
      ledger.recordHit(attackEvent.targetId, attackEvent.dmg);
    }
  },
  onLocalKill: ({ victimId }) => {
    if (state.match?.mode === "pvp") ledger.recordKill(victimId);
  },
  onResultSuggestion: (result, standings) => {
    reportResult(result, { standings }).catch((err) => console.error(err));
  }
});

bindUi();
init();

function bindUi() {
  els.signInWalletBtn.addEventListener("click", signIn);
  els.connectWalletBtn.addEventListener("click", signIn);
  document.getElementById("joinFightBtn")?.addEventListener("click", signIn);
  els.demoBtn.addEventListener("click", startDemo);
  els.pvpBtn.addEventListener("click", startPvp);
  els.signOutBtn.addEventListener("click", signOut);
  els.howToPlayBtn.addEventListener("click", () => els.howToOverlay.classList.add("show"));
  els.howToClose.addEventListener("click", () => els.howToOverlay.classList.remove("show"));
  els.whitepaperBtn?.addEventListener("click", () => els.whitepaperOverlay.classList.add("show"));
  els.whitepaperClose?.addEventListener("click", () => els.whitepaperOverlay.classList.remove("show"));
  els.whitepaperOverlay?.addEventListener("pointerdown", (e) => {
    if (e.target === els.whitepaperOverlay) els.whitepaperOverlay.classList.remove("show");
  });
  els.profileBtn.addEventListener("click", openProfile);
  els.profileClose.addEventListener("click", () => els.profileOverlay.classList.remove("show"));
  els.profileOverlay.addEventListener("pointerdown", (e) => {
    if (e.target === els.profileOverlay) els.profileOverlay.classList.remove("show");
  });
  els.profileSaveBtn.addEventListener("click", saveProfile);
  els.profileNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveProfile(); });
  els.profileTabs.forEach((t) => t.addEventListener("click", () => selectProfileTab(t.dataset.ptab)));
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
  els.leaveMatchBtn.addEventListener("click", () => { els.pauseOverlay.classList.remove("show"); leaveMatch(); });
  document.getElementById("pauseSettingsBtn")?.addEventListener("click", () => {
    els.pauseOverlay.classList.remove("show");
    game.openSettings();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = document.querySelector(".overlay.show");
    if (open) { open.classList.remove("show"); return; } // close topmost overlay
    if (state.match && !state.match.finished) els.pauseOverlay.classList.add("show");
  });
}

function selectProfileTab(tab) {
  els.profileTabs.forEach((t) => t.classList.toggle("active", t.dataset.ptab === tab));
  els.profileBodies.forEach((b) => b.classList.toggle("hidden", b.dataset.pbody !== tab));
  if (tab === "history") loadHistory().catch((e) => console.error(e));
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
function getSolanaWallet() {
  return window.phantom?.solana || window.backpack?.solana || window.solana || window.braveSolana || null;
}

async function signIn() {
  const wallet = getSolanaWallet();
  if (!wallet) {
    setStatus("No Solana wallet found. Install Phantom, Backpack, or Brave Wallet.");
    return;
  }
  try {
    setStatus("Approve the signature in your wallet…");
    await wallet.connect();
    const { error } = await supabase.auth.signInWithWeb3({ chain: "solana", statement: SIGN_IN_STATEMENT, wallet });
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
  state.user = session?.user ?? null;

  if (!state.user) {
    state.profile = null;
    await teardownMatch();
    game.clearAll();
    showLobby();
    setStatus("Connect a Solana wallet to begin.");
    return;
  }

  try {
    await syncProfile();
  } catch (error) {
    console.error("[handleSession]", error);
    setStatus(error.message || "Could not load profile.");
    return;
  }
  showLobby();
  setStatus(recordSuffix("Wallet connected — choose Demo Match or Play PvP."));
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
  game.setLocalUser({ userId: state.user?.id ?? null, displayName: state.profile?.display_name || "You" });
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

// Briefly show a spinning circle, then resolve — a moment of suspense before
// the results screen appears.
function showResultsSpinner(ms = 2000) {
  const el = document.getElementById("resultsLoading");
  if (!el) return Promise.resolve();
  el.classList.remove("hidden");
  return new Promise((resolve) => setTimeout(() => {
    el.classList.add("hidden");
    resolve();
  }, ms));
}

function showGameOver(result, reason, standings = [], prizeAmount = null, kills = null, timeMs = null) {
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

// Explorer link for an on-chain signature (mainnet).
const TX_EXPLORER_BASE = "https://solscan.io/tx/";
function txExplorerUrl(sig) { return TX_EXPLORER_BASE + encodeURIComponent(sig); }

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

function updateGameOverPrize(prizeAmount, payoutTx = null) {
  const prizeEl   = document.getElementById("gameOverPrize");
  const prizeAmt  = document.getElementById("gameOverPrizeAmount");
  const retryBtn  = document.getElementById("gameOverRetryBtn");
  if (!prizeEl || !prizeAmt) return;
  if (prizeAmount !== null) {
    prizeAmt.textContent = prizeAmount.toLocaleString(undefined, { maximumFractionDigits: 0 }) + " $FIGHT10";
    retryBtn?.classList.add("hidden");
    setGameOverTxLink(payoutTx);
  } else {
    prizeAmt.textContent = "Payout failed — tap Retry or contact support";
    retryBtn?.classList.remove("hidden");
    setGameOverTxLink(null);
  }
  els.gameOverMenuBtn.classList.remove("hidden");
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
  try {
    const { data: payoutData, error: payoutErr } = await supabase.functions.invoke("f10treasurer", {
      body: { match_id: state.match.id },
    });
    if (!payoutErr && payoutData?.winner_amount && payoutData?.decimals != null) {
      prizeAmount = Number(payoutData.winner_amount) / 10 ** payoutData.decimals;
      payoutTx = payoutData.payout_tx ?? null;
    }
    if (payoutErr) console.error("Retry payout error:", payoutErr);
  } catch (err) {
    console.error("Retry payout error:", err);
  }
  updateGameOverPrize(prizeAmount, payoutTx);
}

// Polls until the match row is marked 'finished', guarding against read-after-write lag.
// Uses exponential backoff (800ms → 1.6s → 3.2s → …) capped at 5s per interval.
// Wait for the server to settle the match. Returns the settled row
// ({ status, winner_user_id }) once status is 'finished' or 'disputed', or null
// on timeout. Phase 2: the winner is decided server-side from the combat ledger,
// so the client must read the verdict here rather than trust its own detection.
async function awaitSettlement(matchId, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let delay = 800;
  while (Date.now() < deadline) {
    const { data } = await supabase
      .from("matches")
      .select("status, winner_user_id, shadow_meta")
      .eq("id", matchId)
      .single();
    if (data?.status === "finished" || data?.status === "disputed") return data;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 5000);
  }
  return null;
}

// Display names for every player in a match, keyed by user_id. Used to label the
// server-authoritative standings so both clients show identical rows.
async function fetchMatchPlayerNames(matchId) {
  try {
    const { data } = await supabase
      .from("match_players").select("user_id, display_name").eq("match_id", matchId);
    const map = {};
    (data || []).forEach((p) => { map[p.user_id] = p.display_name; });
    return map;
  } catch (_) { return {}; }
}

// Build standings from the SERVER's settled HP (matches.shadow_meta.hp), which
// finalize_match derives identically for everyone from the validated combat
// ledger. This replaces each client's local HP guess, so the winner and loser
// screens always agree. Returns null when the match had no per-player HP
// (e.g. a no-combat dispute) so callers can fall back to local standings.
function serverStandings(settled, nameByUser) {
  const hp = settled?.shadow_meta?.hp;
  if (!Array.isArray(hp) || !hp.length) return null;
  return [...hp]
    .sort((a, b) => (b.hp - a.hp) || ((a.seat ?? 0) - (b.seat ?? 0)))
    .map((e, i) => ({
      rank: i + 1,
      name: nameByUser?.[e.user_id] || "Fighter",
      hp: Math.max(0, e.hp),
      me: e.user_id === state.user?.id,
      flagged: !!e.flagged,
    }));
}

function renderStandings(standings) {
  const el = document.getElementById("gameOverStandings");
  if (!el) return;
  if (!standings.length) { el.innerHTML = ""; return; }
  el.innerHTML = standings.map((s) =>
    `<div class="standing-row${s.me ? " standing-me" : ""}${s.flagged ? " standing-flagged" : ""}">` +
    `<span class="standing-rank">#${s.rank}</span>` +
    `<span class="standing-name">${escapeHtml(s.name)}${s.flagged ? " ⚠" : ""}</span>` +
    `<span class="standing-hp">${s.hp} HP</span>` +
    `</div>`
  ).join("");
}

function hideGameOver() {
  els.gameOver.classList.add("hidden");
}

function startPvp() {
  if (!state.user) { signIn(); return; }
  els.pvpSizeOverlay.classList.add("show");
  fetchLobbyCounts().catch(() => {});
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
    // ── Step 1: deposit on-chain (if not already done from a previous failed attempt) ──
    let txSig = state.pendingDepositTx;
    if (!txSig) {
      // Warn BEFORE payment — the entry fee is non-refundable once paid.
      const ok = window.confirm(
        "Heads up: the 2,500 $FIGHT10 entry fee is NON-REFUNDABLE.\n\n" +
        "Once you pay, leaving the queue or the match will NOT refund your entry — the deposit stays in the pot.\n\n" +
        "Continue and pay the entry fee?"
      );
      if (!ok) return;
      showPvpLobby("Preparing deposit…");
      txSig = await depositEntryFee(size);
      if (!txSig) {
        hidePvpLobby();
        return; // depositEntryFee already set the error/cancel status
      }
      // Save before joining so a network failure doesn't force re-payment.
      state.pendingDepositTx = txSig;
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

    // Joined successfully — clear the pending deposit.
    state.pendingDepositTx = null;
    state.pendingDepositWallet = null;

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
// Poll getSignatureStatuses over HTTP — confirmTransaction uses WebSockets which break in browsers.
async function pollTxConfirmation(connection, sig, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value } = await connection.getSignatureStatuses([sig]);
    const status = value[0];
    if (status) {
      if (status.err) throw new Error("Transaction failed on-chain: " + JSON.stringify(status.err));
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") return status;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Tx not confirmed after ${timeoutMs / 1000}s — sig: ${sig}`);
}

// Transfers 2500 FIGHT10 to the escrow on-chain and waits for confirmation.
// Returns the confirmed tx signature on success, or null if cancelled/failed.
// Does NOT record the deposit in the DB — that happens inside join_pvp_match().
async function depositEntryFee(numPlayers = 2) {
  const wallet = getSolanaWallet();
  if (!wallet?.publicKey) {
    setStatus("Wallet not connected — cannot deposit.");
    return null;
  }

  // One wallet per player: the deposit must come from the same wallet the player
  // signed in with. Catch a mismatch here (before any on-chain payment) so the
  // user isn't charged only to be rejected by join_pvp_match. wallet_address may
  // carry a "chain:" prefix (e.g. "solana:<pubkey>") — compare the pubkey tail.
  const loginWallet = (state.profile?.wallet_address ?? "").split(":").pop();
  if (loginWallet && wallet.publicKey.toString() !== loginWallet) {
    setStatus("Wrong wallet — switch back to your signed-in wallet to deposit, or sign out and sign in with this one.");
    return null;
  }

  if (FIGHT10_MINT.startsWith("<") || ESCROW_WALLET.startsWith("<")) {
    setStatus("Game not configured for live deposits yet (missing mint/escrow address).");
    return null;
  }

  setStatus("Checking $FIGHT10 balance…");
  let balance;
  try {
    balance = await getFight10Balance(wallet.publicKey.toString());
  } catch (err) {
    console.error("[getFight10Balance]", err);
    setStatus("Could not check $FIGHT10 balance — " + (err?.message || "try again."));
    return null;
  }
  if (balance < ENTRY_FEE_RAW) {
    const have = Number(balance) / 10 ** FIGHT10_DECIMALS;
    setStatus(`Insufficient $FIGHT10 balance — need 2,500, have ${have.toFixed(0)}.`);
    return null;
  }

  try {
    updatePrizePot(numPlayers);
    setStatus("Depositing 2,500 $FIGHT10… approve in wallet.");
    els.pvpLobbyStatus.textContent = "Approve deposit in your wallet…";

    const connection   = getSolanaConn();
    const mintPubkey   = new PublicKey(FIGHT10_MINT);
    const escrowPubkey = new PublicKey(ESCROW_WALLET);
    const playerPubkey = wallet.publicKey;

    const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    const mintAccountInfo = await connection.getAccountInfo(mintPubkey);
    if (!mintAccountInfo) throw new Error("Mint account not found on-chain — check FIGHT10_MINT address.");
    const resolvedTokenProgramId = mintAccountInfo.owner;

    const { value: tokenAccounts } = await connection.getParsedTokenAccountsByOwner(
      playerPubkey, { mint: mintPubkey }
    );
    if (!tokenAccounts.length) throw new Error("No FIGHT10 token account found in wallet.");

    tokenAccounts.sort((a, b) =>
      Number(BigInt(b.account.data.parsed.info.tokenAmount.amount) -
             BigInt(a.account.data.parsed.info.tokenAmount.amount))
    );
    const sourceAta = tokenAccounts[0].pubkey;

    const escrowAta = await getAssociatedTokenAddress(mintPubkey, escrowPubkey, false,
      resolvedTokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
    const escrowAtaInfo = await connection.getAccountInfo(escrowAta);

    const instructions = [];
    if (!escrowAtaInfo) {
      instructions.push(createAssociatedTokenAccountInstruction(
        playerPubkey, escrowAta, escrowPubkey, mintPubkey,
        resolvedTokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID
      ));
    }
    instructions.push(createTransferInstruction(
      sourceAta, escrowAta, playerPubkey, ENTRY_FEE_RAW, [], resolvedTokenProgramId
    ));

    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new Transaction().add(...instructions);
    tx.feePayer = playerPubkey;
    tx.recentBlockhash = blockhash;

    const signedTx = await wallet.signTransaction(tx);
    const txSig = await connection.sendRawTransaction(signedTx.serialize());

    setStatus("Confirming deposit on-chain…");
    els.pvpLobbyStatus.textContent = "Confirming on-chain…";
    await pollTxConfirmation(connection, txSig);

    // Record which wallet actually signed this deposit so join_pvp_match can
    // store it; the payout function verifies the on-chain authority against it.
    state.pendingDepositWallet = playerPubkey.toString();

    setStatus("Deposit confirmed — entering queue.");
    return txSig;
  } catch (err) {
    console.error("[depositEntryFee]", err);
    const msg = err?.message || String(err);
    if (msg.includes("User rejected") || msg.includes("cancelled")) {
      setStatus("Deposit cancelled.");
    } else {
      setStatus("Deposit failed: " + msg);
    }
    return null;
  }
}

async function getFight10Balance(walletAddress) {
  const connection   = getSolanaConn();
  const mintPubkey   = new PublicKey(FIGHT10_MINT);
  const walletPubkey = new PublicKey(walletAddress);
  const { value: accounts } = await connection.getParsedTokenAccountsByOwner(
    walletPubkey, { mint: mintPubkey }
  );
  if (accounts.length === 0) return BigInt(0);
  return accounts.reduce(
    (sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount),
    BigInt(0)
  );
}

function updatePrizePot(numPlayers) {
  const potEl = document.getElementById("pvpPrizePool");
  const amtEl = document.getElementById("pvpPrizeAmount");
  if (!potEl || !amtEl) return;
  amtEl.textContent = (numPlayers * ENTRY_FEE).toLocaleString();
  potEl.classList.remove("hidden");
}

async function refreshFight10Balance() {
  const balEl = document.getElementById("fight10Balance");
  if (!balEl || !state.user) return;
  const wallet = getSolanaWallet();
  if (!wallet?.publicKey) return;
  try {
    const raw = await getFight10Balance(wallet.publicKey.toString());
    balEl.textContent = (Number(raw) / 10 ** FIGHT10_DECIMALS).toLocaleString(undefined, { maximumFractionDigits: 0 }) + " $FIGHT10";
    balEl.classList.remove("hidden");
  } catch (err) {
    console.error("[refreshFight10Balance]", err);
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
  game.setLocalUser({ userId: state.user.id, displayName: state.profile?.display_name || "You" });
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
    supabase.from("matches").select("status, max_players").eq("id", matchId).maybeSingle(),
    supabase.from("match_players").select("user_id, seat, display_name").eq("match_id", matchId).order("seat", { ascending: true })
  ]);
  if (playersRes.error) { console.warn(playersRes.error); return; }
  const players = playersRes.data || [];
  const matchRow = matchRes.data;
  const max = matchRow?.max_players || state.match?.maxPlayers || 2;
  if (state.match) state.match.maxPlayers = max;

  // Add any opponents we haven't seen yet (removals come via presence leave).
  for (const p of players) {
    if (p.user_id === state.user.id) continue;
    if (!state.remoteIds.has(p.user_id)) {
      state.remoteIds.add(p.user_id);
      game.addOpponent({ userId: p.user_id, displayName: p.display_name, seat: p.seat, matchId: state.match?.id });
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
  game.generateMap(state.match?.id || "pvp");  // seed by match id so all clients match
  game.resetForMatch(state.match?.id, state.seat);
  ledger.reset();
  if (state.match?.mode === "pvp") startIntegrityWatch();
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
// A rival dropped the connection: remove them. If they were the last one and
// we're still standing, we take the win — but only if the server hasn't already
// settled the match with a different winner (e.g. winner legitimately won, claimed
// payout, then left; without this check the loser would see a false victory).
async function handleOpponentLeft(userId) {
  state.remoteIds.delete(userId);
  const remaining = game.removeOpponent(userId);
  if (state.match?.mode !== "pvp" || state.match.finished || !state.started) return;
  if (remaining === 0 && game.playerAlive()) {
    const { data: matchRow } = await supabase
      .from("matches")
      .select("status, winner_user_id")
      .eq("id", state.match.id)
      .maybeSingle();

    if (matchRow?.status === "finished" || matchRow?.status === "disputed") {
      // Already settled server-side. If we're not the recorded winner, surface
      // the authoritative outcome (loss or no-contest) rather than a false win.
      if (matchRow.winner_user_id !== state.user?.id) {
        reportResult("loss", { standings: game.standings() }).catch(console.error);
      }
      return;
    }

    // Match still active — opponent genuinely disconnected mid-game. The server
    // still has the final say (this resolves to a win only if the ledger backs it).
    reportResult("win", { standings: game.standings() }).catch((e) => console.error(e));
  }
}

// A peer signalled the match is over (someone won, or the timer crowned a
// winner). Report our own *genuine* current HP so the server can tally without
// waiting on us, then reconcile with the authoritative match row to decide our
// screen. A spoofed signal cannot end a live game: we only finalise once the
// server itself reports status='finished', and we never trust the broadcaster's
// claim about who won — that comes from winner_user_id.
async function handleMatchOver() {
  if (state.match?.mode !== "pvp" || !state.match.id || state.match.finished) return;
  // A peer signalled the match is over. Report done and let the server's
  // ledger verdict decide our screen (win / loss / disputed) — reportResult
  // handles the flush, finish_match, settlement wait and display.
  await reportResult("loss", { standings: game.standings() });
}

// Phase 2: the winner is decided SERVER-SIDE from the combat ledger. Each
// participant reports "done" + flushes its offense ledger; the server derives
// HP from what *others* dealt and crowns the winner (or marks the match
// 'disputed' when the ledger is implausible). The client never trusts its own
// win/loss detection for the result — `resultHint` only chooses whether to show
// the winner's suspense spinner; the screen shown comes from the server verdict.
async function reportResult(resultHint, { standings = [] } = {}) {
  if (state.match?.mode !== "pvp" || !state.match.id || state.match.finished) return;
  state.match.finished = true;
  const matchId = state.match.id;

  // Capture the match summary at the moment it ends, before any awaits inflate it.
  const matchKills = ledger.kills.size;
  const matchTimeMs = ledger.startMs ? Date.now() - ledger.startMs : 0;

  // Flush our offense ledger, then report "done". final_hp is now only a
  // "this player reported" marker — it no longer decides the winner.
  await flushLedger(matchId);
  if (_kicked) return; // flushLedger removed us for a server-flagged manipulation
  try {
    const { error } = await supabase.rpc("finish_match", {
      p_match_id: matchId,
      p_final_hp: game.currentHp(),
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
    await showResultsSpinner(2000); // suspense before the verdict
  }

  // Read the authoritative verdict.
  const settled = await awaitSettlement(matchId);
  const serverKills = await fetchVerifiedKills(matchId);
  try { await syncProfile(); } catch (e) { console.error(e); }

  // Prefer the server-authoritative standings + duration so the winner's and
  // loser's screens always show identical HP (local HP desyncs between clients).
  const nameByUser = await fetchMatchPlayerNames(matchId);
  const finalStandings = serverStandings(settled, nameByUser) || standings;
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

  // Authoritative win → victory screen + payout.
  showGameOver("win", "Last one standing — you won!", finalStandings, "pending", serverKills ?? matchKills, finalTimeMs);
  let prizeAmount = null;
  let payoutTx = null;
  try {
    setStatus("Claiming prize…");
    try { refreshGameOverStats(); } catch (e) { console.error(e); }
    const { data: payoutData, error: payoutErr } = await supabase.functions.invoke("f10treasurer", {
      body: { match_id: matchId },
    });
    if (payoutErr) {
      console.error("Payout invoke error:", payoutErr);
    } else if (payoutData?.winner_amount && payoutData?.decimals != null) {
      prizeAmount = Number(payoutData.winner_amount) / 10 ** payoutData.decimals;
      payoutTx = payoutData.payout_tx ?? null;
    }
    await syncProfile();
    refreshGameOverStats();
  } catch (error) {
    console.error(error);
  }
  updateGameOverPrize(prizeAmount, payoutTx);
}

async function leaveMatch({ silent = false } = {}) {
  hidePvpLobby();
  hideGameOver();
  cancelMatchStart();
  if (!state.match) { if (!silent) setStatus("You're not in a match."); return; }
  if (state.match.mode === "pvp") {
    if (state.match.status === "waiting" && state.pendingDepositTx == null && !silent) {
      const ok = await confirmDialog(
        "You have already paid the entry fee. Leaving now forfeits your deposit — the pot stays in the contract. Continue?"
      );
      if (!ok) return;
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
}

async function teardownMatch(keepMatch = false) {
  stopPingLoop();
  stopIntegrityWatch();
  if (state.depositPollTimer) { clearInterval(state.depositPollTimer); state.depositPollTimer = null; }
  if (state.startFallbackTimer) { clearTimeout(state.startFallbackTimer); state.startFallbackTimer = null; }
  state.pendingDepositTx = null;
  if (state.channel) {
    await supabase.removeChannel(state.channel);
    state.channel = null;
  }
  state.remoteIds.clear();
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
  toggle(els.connectWalletBtn, !connected);
  toggle(els.signInWalletBtn, !connected);
  toggle(els.howToPlayBtn, true);
  toggle(els.profileBtn, connected);
  toggle(els.demoBtn, true);
  toggle(els.pvpBtn, connected);
  toggle(els.signOutBtn, connected);
  const balEl = document.getElementById("fight10Balance");
  if (balEl && !connected) balEl.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Profile — edit username (saved to the DB) and view stats
// ---------------------------------------------------------------------------
function openProfile() {
  if (!state.user) { signIn(); return; }
  renderProfileStats();
  els.profileNameInput.value = state.profile?.display_name || "";
  els.profileHint.textContent = "Saved to your wallet profile.";
  els.profileHint.classList.remove("error");
  selectProfileTab("stats");
  els.profileOverlay.classList.add("show");
  els.profileNameInput.focus();
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
    els.profileHint.textContent = error.message || "Could not save username.";
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
