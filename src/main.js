import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createArenaGame } from "./game.js";

const SUPABASE_URL =
  import.meta.env?.VITE_SUPABASE_URL?.trim() || "https://sajvismyvcgaszjcafcr.supabase.co";
const SUPABASE_ANON_KEY =
  import.meta.env?.VITE_SUPABASE_ANON_KEY?.trim() || "sb_publishable_M1p6wWP5G9feHWa70BX3aw_5bIVZHTU";
const SIGN_IN_STATEMENT = "Sign in to Age of Trenches to play realtime trench duels.";

const els = {
  signInWalletBtn: document.getElementById("signInWalletBtn"),
  heroPlayBtn: document.getElementById("heroPlayBtn"),
  signOutBtn: document.getElementById("signOutBtn"),
  authCard: document.getElementById("authCard"),
  walletBadge: document.getElementById("walletBadge"),
  walletHint: document.getElementById("walletHint"),
  profileCard: document.getElementById("profileCard"),
  authBadge: document.getElementById("authBadge"),
  walletAddress: document.getElementById("walletAddress"),
  playerShortId: document.getElementById("playerShortId"),
  displayNameInput: document.getElementById("displayNameInput"),
  saveNameBtn: document.getElementById("saveNameBtn"),
  matchCard: document.getElementById("matchCard"),
  matchStatusBadge: document.getElementById("matchStatusBadge"),
  roster: document.getElementById("roster"),
  queueBtn: document.getElementById("queueBtn"),
  forfeitBtn: document.getElementById("forfeitBtn"),
  appStatus: document.getElementById("appStatus"),
  arenaTitle: document.getElementById("arenaTitle"),
  presenceState: document.getElementById("presenceState"),
  arenaMount: document.getElementById("arenaMount")
};

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});

const state = {
  user: null,
  profile: null,
  match: null, // { id, status }
  seat: null,
  players: [],
  remoteId: null,
  channel: null
};

const game = createArenaGame({
  mount: els.arenaMount,
  onLocalState: (snapshot) => {
    state.channel?.send({
      type: "broadcast",
      event: "state",
      payload: { userId: state.user?.id, snapshot }
    });
  },
  onAttack: (attackEvent) => {
    state.channel?.send({ type: "broadcast", event: "attack", payload: attackEvent });
  },
  onResultSuggestion: (result) => {
    setStatus(result === "win" ? "You knocked out your opponent! 🎖" : "You were knocked out.");
  }
});

bindUi();
init();

function bindUi() {
  els.signInWalletBtn.addEventListener("click", signIn);
  els.heroPlayBtn.addEventListener("click", handleHeroPlay);
  els.signOutBtn.addEventListener("click", signOut);
  els.saveNameBtn.addEventListener("click", saveDisplayName);
  els.queueBtn.addEventListener("click", findMatch);
  els.forfeitBtn.addEventListener("click", leaveMatch);
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
    const { error } = await supabase.auth.signInWithWeb3({
      chain: "solana",
      statement: SIGN_IN_STATEMENT,
      wallet
    });
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
    renderSignedOut();
    return;
  }

  try {
    await syncProfile();
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Could not load profile.");
    return;
  }

  els.profileCard.classList.remove("hidden");
  els.matchCard.classList.remove("hidden");
  setBadge(els.walletBadge, "solana", "badge-good");
  setBadge(els.authBadge, "player", "badge-good");
  els.walletHint.textContent = "Wallet authenticated. Hit Find Demo Match to drop into the arena.";
  renderProfile();
  renderMatch();
  updateHero();
}

async function syncProfile() {
  const name = els.displayNameInput.value.trim() || null;
  const { data, error } = await supabase.rpc("sync_my_profile", { p_display_name: name });
  if (error) throw error;
  state.profile = data;
}

// ---------------------------------------------------------------------------
// Matchmaking
// ---------------------------------------------------------------------------
async function handleHeroPlay() {
  if (!state.user) {
    await signIn();
    return;
  }
  if (state.match) {
    setStatus("You're already in a match below.");
    return;
  }
  await findMatch();
}

async function findMatch() {
  if (!state.user) {
    await signIn();
    return;
  }
  try {
    setStatus("Finding a demo match…");
    const name = els.displayNameInput.value.trim() || null;
    const { data, error } = await supabase.rpc("join_demo_match", { p_display_name: name });
    if (error) throw error;

    state.match = { id: data.match_id, status: data.status === "active" ? "active" : "waiting" };
    state.seat = data.seat;
    await enterArena(data.match_id);
    setStatus(state.match.status === "active" ? "Opponent found — fight!" : "Waiting for an opponent to join…");
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Could not join a match.");
  }
}

async function leaveMatch({ silent = false } = {}) {
  if (!state.match) {
    if (!silent) setStatus("You're not in a match.");
    return;
  }
  try {
    await supabase.rpc("leave_my_matches");
  } catch (error) {
    console.error(error);
  }
  await teardownMatch();
  game.clearAll();
  game.setMode("offline");
  renderMatch();
  updateHero();
  if (!silent) setStatus("Left the match.");
}

async function enterArena(matchId) {
  await teardownMatch(true);

  game.setMode("player");
  game.setPlayerPerspective({
    userId: state.user.id,
    displayName: state.profile?.display_name || "You"
  });
  game.clearRemote();
  game.resetForMatch();

  await loadRoster(matchId);

  state.channel = supabase.channel(`match-${matchId}`, {
    config: { broadcast: { self: false }, presence: { key: state.user.id } }
  });

  state.channel
    .on("broadcast", { event: "state" }, ({ payload }) => {
      if (payload?.userId && payload.userId !== state.user.id) {
        game.receivePlayerState(payload.snapshot);
      }
    })
    .on("broadcast", { event: "attack" }, ({ payload }) => {
      game.receiveAttack(payload);
    })
    .on("presence", { event: "sync" }, () => {
      const members = Object.keys(state.channel.presenceState()).length;
      els.presenceState.textContent = `${members} player${members === 1 ? "" : "s"} in the room`;
      loadRoster(matchId).catch((error) => console.error(error));
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        state.channel.track({ user_id: state.user.id, display_name: state.profile?.display_name });
      }
    });

  renderMatch();
  updateHero();
}

async function loadRoster(matchId) {
  const { data, error } = await supabase
    .from("match_players")
    .select("user_id, seat, display_name")
    .eq("match_id", matchId)
    .order("seat", { ascending: true });
  if (error) {
    console.warn(error);
    return;
  }

  state.players = data || [];
  const opponent = state.players.find((p) => p.user_id !== state.user.id);

  if (opponent && opponent.user_id !== state.remoteId) {
    state.remoteId = opponent.user_id;
    state.match = { ...state.match, status: "active" };
    game.setRemoteIdentity({ userId: opponent.user_id, displayName: opponent.display_name });
    game.resetForMatch();
  } else if (!opponent) {
    state.remoteId = null;
    game.clearRemote();
  }

  game.setMatchPhase(state.match?.status || "offline");
  renderMatch();
  updateHero();
}

async function teardownMatch(keepMatch = false) {
  if (state.channel) {
    await supabase.removeChannel(state.channel);
    state.channel = null;
  }
  state.players = [];
  state.remoteId = null;
  if (!keepMatch) {
    state.match = null;
    state.seat = null;
  }
}

// ---------------------------------------------------------------------------
// Profile editing
// ---------------------------------------------------------------------------
async function saveDisplayName() {
  if (!state.user) return;
  const name = els.displayNameInput.value.trim();
  if (name.length < 3) {
    setStatus("Display names must be at least 3 characters.");
    return;
  }
  try {
    await syncProfile();
    renderProfile();
    setStatus("Display name saved.");
  } catch (error) {
    setStatus(error.message || "Could not save name.");
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderSignedOut() {
  setBadge(els.walletBadge, "disconnected");
  setBadge(els.authBadge, "offline");
  els.profileCard.classList.add("hidden");
  els.matchCard.classList.add("hidden");
  els.walletHint.textContent = "Sign in with a Solana wallet like Phantom, Backpack, or Brave to play.";
  els.presenceState.textContent = "Waiting for wallet sign-in";
  els.arenaTitle.textContent = "Trench Duel";
  els.roster.className = "roster empty";
  els.roster.textContent = "No active match yet.";
  game.clearAll();
  game.setMode("offline");
  updateHero();
}

function renderProfile() {
  if (!state.profile) return;
  els.displayNameInput.value = state.profile.display_name || "";
  els.walletAddress.textContent = state.profile.wallet_address
    ? shorten(state.profile.wallet_address, 4, 4)
    : "—";
  els.playerShortId.textContent = state.user.id.slice(0, 8);
}

function renderMatch() {
  if (!state.match) {
    setBadge(els.matchStatusBadge, "idle");
    els.roster.className = "roster empty";
    els.roster.textContent = "No active match yet.";
    els.arenaTitle.textContent = "Trench Duel";
    return;
  }

  els.arenaTitle.textContent = `Match ${state.match.id.slice(0, 8)}`;
  const kind = state.match.status === "active" ? "badge-good" : "badge-warm";
  setBadge(els.matchStatusBadge, state.match.status, kind);

  if (!state.players.length) {
    els.roster.className = "roster empty";
    els.roster.textContent = "Waiting for players…";
    return;
  }

  els.roster.className = "roster";
  els.roster.innerHTML = "";
  state.players.forEach((player) => {
    const isYou = player.user_id === state.user.id;
    const row = document.createElement("div");
    row.className = "roster-row";
    row.innerHTML = `
      <strong>${escapeHtml(player.display_name || player.user_id.slice(0, 8))}</strong>
      <span class="badge">${isYou ? "you" : "rival"}</span>
      <span class="badge">seat ${player.seat}</span>
    `;
    els.roster.appendChild(row);
  });
}

function updateHero() {
  if (!state.user) {
    els.heroPlayBtn.textContent = "Connect Wallet";
    els.signOutBtn.classList.add("hidden");
    els.queueBtn.disabled = true;
    els.forfeitBtn.disabled = true;
    return;
  }

  els.signOutBtn.classList.remove("hidden");
  els.queueBtn.disabled = !!state.match;
  els.forfeitBtn.disabled = !state.match;

  if (state.match?.status === "active") {
    els.heroPlayBtn.textContent = "Match Live";
  } else if (state.match?.status === "waiting") {
    els.heroPlayBtn.textContent = "Waiting…";
  } else {
    els.heroPlayBtn.textContent = "Find Demo Match";
  }
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
function setStatus(message) {
  els.appStatus.textContent = message;
}

function setBadge(element, text, kind = "") {
  element.textContent = text;
  element.className = `badge ${kind}`.trim();
}

function shorten(value, start, end) {
  if (!value) return "—";
  if (value.length <= start + end + 1) return value;
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
