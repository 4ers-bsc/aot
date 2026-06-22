import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createArenaGame } from "./game.js";

const SUPABASE_URL =
  import.meta.env?.VITE_SUPABASE_URL?.trim() || "https://sajvismyvcgaszjcafcr.supabase.co";
const SUPABASE_ANON_KEY =
  import.meta.env?.VITE_SUPABASE_ANON_KEY?.trim() || "sb_publishable_M1p6wWP5G9feHWa70BX3aw_5bIVZHTU";
const SIGN_IN_STATEMENT = "Sign in to Age of Trenches to play realtime trench duels.";

const els = {
  signInWalletBtn: document.getElementById("signInWalletBtn"),
  connectWalletBtn: document.getElementById("connectWalletBtn"),
  howToPlayBtn: document.getElementById("howToPlayBtn"),
  demoBtn: document.getElementById("demoBtn"),
  pvpBtn: document.getElementById("pvpBtn"),
  signOutBtn: document.getElementById("signOutBtn"),
  appStatus: document.getElementById("appStatus"),
  arenaMount: document.getElementById("arenaMount"),
  howToOverlay: document.getElementById("howToOverlay"),
  howToClose: document.getElementById("howToClose"),
  pvpLobby: document.getElementById("pvpLobby"),
  pvpLobbyStatus: document.getElementById("pvpLobbyStatus"),
  pvpLobbyMeta: document.getElementById("pvpLobbyMeta"),
  pvpCancelBtn: document.getElementById("pvpCancelBtn"),
  gameOver: document.getElementById("gameOver"),
  gameOverTitle: document.getElementById("gameOverTitle"),
  gameOverReason: document.getElementById("gameOverReason"),
  gameOverWins: document.getElementById("gameOverWins"),
  gameOverLosses: document.getElementById("gameOverLosses"),
  gameOverName: document.getElementById("gameOverName"),
  gameOverMenuBtn: document.getElementById("gameOverMenuBtn")
};

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});

const state = {
  user: null,
  profile: null,
  match: null, // { id, mode: 'demo'|'pvp', status, finished }
  seat: null,
  remoteId: null,
  channel: null
};

const game = createArenaGame({
  mount: els.arenaMount,
  onLocalState: (snapshot) => {
    state.channel?.send({ type: "broadcast", event: "state", payload: { userId: state.user?.id, snapshot } });
  },
  onAttack: (attackEvent) => {
    state.channel?.send({ type: "broadcast", event: "attack", payload: attackEvent });
  },
  onResultSuggestion: (result) => {
    reportResult(result).catch((err) => console.error(err));
  }
});

bindUi();
init();

function bindUi() {
  els.signInWalletBtn.addEventListener("click", signIn);
  els.connectWalletBtn.addEventListener("click", signIn);
  els.demoBtn.addEventListener("click", startDemo);
  els.pvpBtn.addEventListener("click", startPvp);
  els.signOutBtn.addEventListener("click", signOut);
  els.howToPlayBtn.addEventListener("click", () => els.howToOverlay.classList.add("show"));
  els.howToClose.addEventListener("click", () => els.howToOverlay.classList.remove("show"));
  els.pvpCancelBtn.addEventListener("click", () => leaveMatch());
  els.gameOverMenuBtn.addEventListener("click", () => { hideGameOver(); leaveMatch({ silent: true }); });
  els.howToOverlay.addEventListener("pointerdown", (e) => {
    if (e.target === els.howToOverlay) els.howToOverlay.classList.remove("show");
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.match) leaveMatch();
  });
}

async function init() {
  supabase.auth.onAuthStateChange((_event, session) => {
    handleSession(session).catch((error) => {
      console.error(error);
      setStatus(error.message || "Auth update failed.");
    });
  });
  const { data } = await supabase.auth.getSession();
  await handleSession(data.session);
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
    console.error(error);
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
    console.error(error);
    setStatus(error.message || "Could not load profile.");
    return;
  }
  showLobby();
  setStatus(recordSuffix("Wallet connected — choose Demo Match or Play PvP."));
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
  if (!state.user) { signIn(); return; }
  state.match = { mode: "demo", status: "active", finished: false };
  state.remoteId = null;
  game.setView("game");
  game.setMode("player");
  game.setPlayerPerspective({ userId: state.user.id, displayName: state.profile?.display_name || "You" });
  game.setMatchPhase("active");
  game.clearRemote();       // AI raider opponent
  game.resetForMatch();
  setStatus("Demo match vs the computer. Click the battlefield to move.");
}

// ---------------------------------------------------------------------------
// PvP — matchmaking vs other players, result written to the DB
// ---------------------------------------------------------------------------
let pvpLobbyTimer = null;
let pvpLobbySeconds = 0;

function showPvpLobby(status) {
  els.pvpLobbyStatus.textContent = status || "Searching for an opponent…";
  els.pvpLobbyMeta.textContent = "";
  els.pvpLobby.classList.remove("hidden");
  pvpLobbySeconds = 0;
  clearInterval(pvpLobbyTimer);
  pvpLobbyTimer = setInterval(() => {
    pvpLobbySeconds++;
    els.pvpLobbyMeta.textContent = `${pvpLobbySeconds}s elapsed`;
  }, 1000);
}

function hidePvpLobby() {
  clearInterval(pvpLobbyTimer);
  pvpLobbyTimer = null;
  els.pvpLobby.classList.add("hidden");
}

function showGameOver(result, reason) {
  const win = result === "win";
  els.gameOverTitle.textContent = win ? "VICTORY" : "DEFEAT";
  els.gameOverTitle.classList.toggle("is-win", win);
  els.gameOverTitle.classList.toggle("is-loss", !win);
  els.gameOverReason.textContent = reason || (win ? "Your rival fell in the trench." : "You fell in the trench.");
  els.gameOverName.textContent = state.profile?.display_name || "Trench Rookie";
  els.gameOverWins.textContent = state.profile?.wins ?? 0;
  els.gameOverLosses.textContent = state.profile?.losses ?? 0;
  els.gameOver.classList.remove("hidden");
}

function hideGameOver() {
  els.gameOver.classList.add("hidden");
}

async function startPvp() {
  if (!state.user) { signIn(); return; }
  try {
    showPvpLobby("Searching for an opponent…");
    const { data, error } = await supabase.rpc("join_pvp_match", { p_display_name: null });
    if (error) throw error;
    state.match = { id: data.match_id, mode: "pvp", status: data.status === "active" ? "active" : "waiting", finished: false };
    state.seat = data.seat;
    await enterArena(data.match_id);
    if (state.match.status === "active") {
      hidePvpLobby();
    } else {
      els.pvpLobbyStatus.textContent = "Waiting for an opponent…";
    }
  } catch (error) {
    hidePvpLobby();
    console.error(error);
    setStatus(error.message || "Could not join a PvP match.");
  }
}

async function enterArena(matchId) {
  await teardownMatch(true);
  // Stay in lobby view while waiting; setView("game") fires when opponent connects
  game.setMode("player");
  game.setPlayerPerspective({ userId: state.user.id, displayName: state.profile?.display_name || "You" });
  game.setMatchPhase("waiting");
  game.clearRemote();       // AI stand-in until the real opponent connects
  game.resetForMatch();

  await loadRoster(matchId);

  state.channel = supabase.channel(`match-${matchId}`, {
    config: { broadcast: { self: false }, presence: { key: state.user.id } }
  });
  state.channel
    .on("broadcast", { event: "state" }, ({ payload }) => {
      if (payload?.userId && payload.userId !== state.user.id) game.receivePlayerState(payload.snapshot);
    })
    .on("broadcast", { event: "attack" }, ({ payload }) => game.receiveAttack(payload))
    .on("presence", { event: "sync" }, () => { loadRoster(matchId).catch((e) => console.error(e)); })
    .on("presence", { event: "leave" }, ({ leftPresences }) => {
      const oppLeft = (leftPresences || []).some((p) => p.user_id === state.remoteId);
      if (oppLeft) handleOpponentLeft();
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") state.channel.track({ user_id: state.user.id, display_name: state.profile?.display_name });
    });
}

async function loadRoster(matchId) {
  const { data, error } = await supabase
    .from("match_players")
    .select("user_id, seat, display_name")
    .eq("match_id", matchId)
    .order("seat", { ascending: true });
  if (error) { console.warn(error); return; }

  const opponent = (data || []).find((p) => p.user_id !== state.user.id);
  if (opponent && opponent.user_id !== state.remoteId) {
    state.remoteId = opponent.user_id;
    if (state.match) state.match.status = "active";
    hidePvpLobby();
    game.setView("game");
    game.setMatchPhase("active");
    game.setRemoteIdentity({ userId: opponent.user_id, displayName: opponent.display_name });
    game.resetForMatch();
    setStatus("Opponent found — fight!");
  }
}

// ---------------------------------------------------------------------------
// Result handling (PvP only) — loser is whoever hits 0 HP or disconnects
// ---------------------------------------------------------------------------
// Opponent dropped the connection: award the win to the player still standing.
function handleOpponentLeft() {
  if (state.match?.mode !== "pvp" || state.match.finished) return;
  reportResult("win", { reason: "Your opponent disconnected." }).catch((e) => console.error(e));
}

async function reportResult(result, { reason = "" } = {}) {
  if (state.match?.mode !== "pvp" || !state.match.id || state.match.finished) return;
  state.match.finished = true;
  const winner = result === "win" ? state.user.id : state.remoteId;
  try {
    if (winner) await supabase.rpc("finish_match", { p_match_id: state.match.id, p_winner_user_id: winner });
    await syncProfile();
  } catch (error) {
    console.error(error);
  }
  showGameOver(result, reason);
}

async function leaveMatch({ silent = false } = {}) {
  hidePvpLobby();
  hideGameOver();
  if (!state.match) { if (!silent) setStatus("You're not in a match."); return; }
  if (state.match.mode === "pvp") {
    try { await supabase.rpc("leave_my_matches"); } catch (error) { console.error(error); }
  }
  await teardownMatch();
  game.clearAll();
  showLobby();
  if (!silent) setStatus(recordSuffix("Left the match."));
}

async function teardownMatch(keepMatch = false) {
  if (state.channel) {
    await supabase.removeChannel(state.channel);
    state.channel = null;
  }
  state.remoteId = null;
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
  toggle(els.demoBtn, connected);
  toggle(els.pvpBtn, connected);
  toggle(els.signOutBtn, connected);
}

function recordSuffix(message) {
  if (!state.profile || (state.profile.wins == null && state.profile.losses == null)) return message;
  return `${message}  ·  Record ${state.profile.wins ?? 0}-${state.profile.losses ?? 0}`;
}

function toggle(el, show) {
  if (el) el.classList.toggle("hidden", !show);
}

function setStatus(message) {
  els.appStatus.textContent = message;
}
