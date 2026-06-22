import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createArenaGame } from "./game.js";

const CONFIG_STORAGE_KEY = "aot.supabase.config";
const DEFAULT_SUPABASE_URL = "https://sajvismyvcgaszjcafcr.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "sb_publishable_M1p6wWP5G9feHWa70BX3aw_5bIVZHTU";
const ENV_SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL?.trim() || DEFAULT_SUPABASE_URL;
const ENV_SUPABASE_ANON_KEY = import.meta.env?.VITE_SUPABASE_ANON_KEY?.trim() || DEFAULT_SUPABASE_ANON_KEY;
const SOLANA_STATEMENT = "Sign in to Age of Trenches to access your PvP account, stored inventory, and secure gold escrow matches.";

const els = {
  clearConfigBtn: document.getElementById("clearConfigBtn"),
  connectBtn: document.getElementById("connectBtn"),
  supabaseUrl: document.getElementById("supabaseUrl"),
  supabaseAnonKey: document.getElementById("supabaseAnonKey"),
  authCard: document.getElementById("authCard"),
  walletBadge: document.getElementById("walletBadge"),
  walletHint: document.getElementById("walletHint"),
  signInWalletBtn: document.getElementById("signInWalletBtn"),
  heroPlayBtn: document.getElementById("heroPlayBtn"),
  spectatorBtn: document.getElementById("spectatorBtn"),
  signOutBtn: document.getElementById("signOutBtn"),
  profileCard: document.getElementById("profileCard"),
  inventoryCard: document.getElementById("inventoryCard"),
  historyCard: document.getElementById("historyCard"),
  matchCard: document.getElementById("matchCard"),
  securityCard: document.getElementById("securityCard"),
  authBadge: document.getElementById("authBadge"),
  goldBalance: document.getElementById("goldBalance"),
  walletAddress: document.getElementById("walletAddress"),
  playerLevel: document.getElementById("playerLevel"),
  playerMmr: document.getElementById("playerMmr"),
  playerRecord: document.getElementById("playerRecord"),
  playerShortId: document.getElementById("playerShortId"),
  displayNameInput: document.getElementById("displayNameInput"),
  saveNameBtn: document.getElementById("saveNameBtn"),
  loadoutBadge: document.getElementById("loadoutBadge"),
  primaryLoadout: document.getElementById("primaryLoadout"),
  secondaryLoadout: document.getElementById("secondaryLoadout"),
  inventoryList: document.getElementById("inventoryList"),
  historyList: document.getElementById("historyList"),
  queueBtn: document.getElementById("queueBtn"),
  cancelQueueBtn: document.getElementById("cancelQueueBtn"),
  claimWinBtn: document.getElementById("claimWinBtn"),
  claimLossBtn: document.getElementById("claimLossBtn"),
  forfeitBtn: document.getElementById("forfeitBtn"),
  roster: document.getElementById("roster"),
  matchStatusBadge: document.getElementById("matchStatusBadge"),
  potValue: document.getElementById("potValue"),
  appStatus: document.getElementById("appStatus"),
  arenaTitle: document.getElementById("arenaTitle"),
  presenceState: document.getElementById("presenceState"),
  arenaMount: document.getElementById("arenaMount")
};

const state = {
  supabase: null,
  session: null,
  user: null,
  profile: null,
  inventory: [],
  loadout: null,
  history: [],
  currentMatch: null,
  matchPlayers: [],
  matchSubscription: null,
  arenaChannel: null,
  spectatorChannel: null,
  authMode: "guest",
  spectatingMatchId: null
};

const game = createArenaGame({
  mount: els.arenaMount,
  onLocalState: (snapshot) => {
    if (!state.currentMatch?.id || state.authMode !== "player") return;
    broadcastToMatchChannels("state", {
      userId: state.user?.id,
      snapshot
    });
  },
  onAttack: (attackEvent) => {
    if (!state.currentMatch?.id || state.authMode !== "player") return;
    broadcastToMatchChannels("attack", attackEvent);
  },
  onResultSuggestion: (result) => {
    if (result === "win") {
      setStatus("Your client thinks you won. Submit Claim Victory to settle the pot.");
    } else if (result === "loss") {
      setStatus("Your client thinks you lost. Submit Claim Defeat or Forfeit to settle fairly.");
    }
  }
});

loadStoredConfig();
bindUi();
bootstrapFromEnv();

function bindUi() {
  els.connectBtn.addEventListener("click", connectWithForm);
  els.clearConfigBtn.addEventListener("click", clearStoredConfig);
  els.signInWalletBtn.addEventListener("click", signInWithSolanaWallet);
  els.heroPlayBtn.addEventListener("click", handleHeroPlay);
  els.spectatorBtn.addEventListener("click", continueAsSpectator);
  els.signOutBtn.addEventListener("click", signOutCurrentUser);
  els.saveNameBtn.addEventListener("click", saveDisplayName);
  els.queueBtn.addEventListener("click", () => invokeMatchAction("queue"));
  els.cancelQueueBtn.addEventListener("click", () => invokeMatchAction("cancel_queue"));
  els.claimWinBtn.addEventListener("click", () => submitResultClaim(true));
  els.claimLossBtn.addEventListener("click", () => submitResultClaim(false));
  els.forfeitBtn.addEventListener("click", () => invokeMatchAction("forfeit"));
}

function setStatus(message) {
  els.appStatus.textContent = message;
}

function updateHeroCtas() {
  if (!state.supabase) {
    els.heroPlayBtn.textContent = "Play Now";
    els.signOutBtn.classList.add("hidden");
    return;
  }

  if (!state.user || state.authMode === "spectator") {
    els.heroPlayBtn.textContent = "Connect Wallet";
    els.signOutBtn.classList.toggle("hidden", !state.user);
    return;
  }

  els.signOutBtn.classList.remove("hidden");
  if (state.currentMatch?.status === "active") {
    els.heroPlayBtn.textContent = "Match Live";
    return;
  }
  if (state.currentMatch?.status === "waiting") {
    els.heroPlayBtn.textContent = "Queued Up";
    return;
  }
  els.heroPlayBtn.textContent = "Find Match";
}

function setBadge(element, text, kind = "") {
  element.textContent = text;
  element.className = `badge ${kind}`.trim();
}

function loadStoredConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) || "{}");
    els.supabaseUrl.value = ENV_SUPABASE_URL || stored.url || "";
    els.supabaseAnonKey.value = ENV_SUPABASE_ANON_KEY || stored.anonKey || "";
  } catch (_error) {
    localStorage.removeItem(CONFIG_STORAGE_KEY);
    els.supabaseUrl.value = ENV_SUPABASE_URL;
    els.supabaseAnonKey.value = ENV_SUPABASE_ANON_KEY;
  }
}

function saveStoredConfig(url, anonKey) {
  localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify({ url, anonKey }));
}

function clearStoredConfig() {
  localStorage.removeItem(CONFIG_STORAGE_KEY);
  els.supabaseUrl.value = ENV_SUPABASE_URL;
  els.supabaseAnonKey.value = ENV_SUPABASE_ANON_KEY;
  setStatus("Saved Supabase config cleared. Vite environment values still apply.");
}

function bootstrapFromEnv() {
  if (!ENV_SUPABASE_URL || !ENV_SUPABASE_ANON_KEY) return;
  connectWithConfig(ENV_SUPABASE_URL, ENV_SUPABASE_ANON_KEY, true);
}

async function connectWithForm() {
  return connectWithConfig(els.supabaseUrl.value.trim(), els.supabaseAnonKey.value.trim(), false);
}

async function connectWithConfig(url, anonKey, fromEnv) {
  if (!url || !anonKey) {
    setStatus("Both Supabase URL and anon key are required.");
    return;
  }

  if (!fromEnv) {
    saveStoredConfig(url, anonKey);
  }

  state.supabase = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  state.supabase.auth.onAuthStateChange(async (_event, session) => {
    try {
      await handleSession(session);
    } catch (error) {
      console.error(error);
      setStatus(error.message || "Auth state update failed.");
    }
  });

  els.authCard.classList.remove("hidden");
  els.securityCard.classList.remove("hidden");
  updateHeroCtas();
  setStatus(fromEnv ? "Supabase connected from Vite environment variables." : "Supabase connected.");

  const { data, error } = await state.supabase.auth.getSession();
  if (error) {
    setStatus(error.message);
    return;
  }
  await handleSession(data.session);
}

async function handleSession(session) {
  state.session = session;
  state.user = session?.user ?? null;

  if (!state.user) {
    state.authMode = "guest";
    state.profile = null;
    state.inventory = [];
    state.loadout = null;
    state.history = [];
    await clearCurrentRoom();
    renderSignedOutState();
    return;
  }

  if (isAnonymousUser(state.user)) {
    state.authMode = "spectator";
    await refreshProfile();
    renderProfile();
    renderInventory();
    renderHistory();
    els.profileCard.classList.remove("hidden");
    els.historyCard.classList.remove("hidden");
    els.matchCard.classList.remove("hidden");
    setBadge(els.walletBadge, "spectator", "badge-warm");
    setBadge(els.authBadge, "spectator", "badge-warm");
    els.walletHint.textContent = "Anonymous spectator session active. You can watch live matches, but you cannot join paid PvP queues.";
    if (!state.currentMatch?.id) {
      await spectateRandomMatch();
    }
    updateHeroCtas();
    return;
  }

  state.authMode = "player";
  await syncWeb3Profile();
  await Promise.all([
    refreshProfile(),
    refreshInventory(),
    refreshHistory()
  ]);
  await restoreOpenMatch();
  renderProfile();
  renderInventory();
  renderHistory();
  els.profileCard.classList.remove("hidden");
  els.inventoryCard.classList.remove("hidden");
  els.historyCard.classList.remove("hidden");
  els.matchCard.classList.remove("hidden");
  setBadge(els.walletBadge, "solana", "badge-good");
  setBadge(els.authBadge, "player", "badge-good");
  els.walletHint.textContent = "Solana wallet authenticated. You can queue for 10-gold winner-takes-all matches.";
  updateHeroCtas();
}

function renderSignedOutState() {
  setBadge(els.walletBadge, "disconnected");
  setBadge(els.authBadge, "offline");
  els.authCard.classList.remove("hidden");
  els.walletHint.textContent = "Connect Supabase first, then use Solana wallet sign-in to play or anonymous sign-in to spectate.";
  els.profileCard.classList.add("hidden");
  els.inventoryCard.classList.add("hidden");
  els.historyCard.classList.add("hidden");
  els.matchCard.classList.add("hidden");
  els.securityCard.classList.toggle("hidden", !state.supabase);
  els.potValue.textContent = "0 gold";
  els.roster.className = "roster empty";
  els.roster.textContent = "No active match yet.";
  els.presenceState.textContent = state.supabase ? "Connected to Supabase. Choose player or spectator mode." : "Waiting for Supabase connection";
  els.arenaTitle.textContent = "Offline Practice";
  game.clearAll();
  game.setMode("offline");
  updateHeroCtas();
}

function isAnonymousUser(user) {
  return user?.is_anonymous === true || user?.app_metadata?.provider === "anonymous";
}

function getSolanaWallet() {
  return window.phantom?.solana || window.backpack?.solana || window.solana || window.braveSolana || null;
}

async function continueAsSpectator() {
  if (!state.supabase) {
    setStatus("Connect to Supabase first.");
    return;
  }
  if (state.user && !isAnonymousUser(state.user)) {
    setStatus("You are already signed in as a player. Sign out first if you want spectator mode.");
    return;
  }
  if (!state.user) {
    const { error } = await state.supabase.auth.signInAnonymously();
    if (error) {
      setStatus(error.message);
      return;
    }
  } else {
    await spectateRandomMatch();
  }
}

async function handleHeroPlay() {
  if (!state.supabase) {
    await connectWithForm();
    if (!state.supabase) return;
  }

  if (!state.user || state.authMode === "spectator") {
    await signInWithSolanaWallet();
    return;
  }

  if (state.currentMatch?.status === "active") {
    setStatus("Your match is already live below. Finish the duel or forfeit to exit.");
    return;
  }

  if (state.currentMatch?.status === "waiting") {
    setStatus("You are already in queue. Matchmaking will start as soon as an opponent joins.");
    return;
  }

  await invokeMatchAction("queue");
}

async function signInWithSolanaWallet() {
  if (!state.supabase) {
    setStatus("Connect to Supabase first.");
    return;
  }

  const wallet = getSolanaWallet();
  if (!wallet) {
    setStatus("No Solana wallet found. Install Phantom, Backpack, Brave Wallet, or another Solana wallet extension.");
    return;
  }

  if (state.user && isAnonymousUser(state.user)) {
    await state.supabase.auth.signOut({ scope: "local" });
  }

  try {
    await wallet.connect();
    const { error } = await state.supabase.auth.signInWithWeb3({
      chain: "solana",
      statement: SOLANA_STATEMENT,
      wallet
    });
    if (error) throw error;
    setStatus("Solana wallet connected. Finalizing player session...");
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Wallet sign-in failed.");
  }
}

async function signOutCurrentUser() {
  if (!state.supabase) return;
  const { error } = await state.supabase.auth.signOut();
  if (error) {
    setStatus(error.message);
    return;
  }
  setStatus("Signed out.");
}

async function syncWeb3Profile() {
  const displayName = els.displayNameInput.value.trim() || null;
  const { data, error } = await state.supabase.rpc("sync_my_player_identity", {
    p_display_name: displayName
  });
  if (error) throw error;
  state.profile = data;
}

async function refreshProfile() {
  if (!state.supabase || !state.user) return;
  const { data, error } = await state.supabase
    .from("profiles")
    .select("user_id, display_name, gold_balance, wallet_public_key, can_compete, mmr, xp, level, total_matches, total_wins, total_losses")
    .eq("user_id", state.user.id)
    .single();
  if (error) throw error;
  state.profile = data;
}

async function refreshInventory() {
  if (!state.supabase || !state.user || state.authMode !== "player") {
    state.inventory = [];
    state.loadout = null;
    return;
  }

  const [{ data: inventoryRows, error: inventoryError }, { data: loadout, error: loadoutError }] = await Promise.all([
    state.supabase
      .from("player_inventory")
      .select("item_id, quantity")
      .eq("user_id", state.user.id)
      .gt("quantity", 0)
      .order("item_id", { ascending: true }),
    state.supabase
      .from("player_loadouts")
      .select("primary_item_id, secondary_item_id")
      .eq("user_id", state.user.id)
      .single()
  ]);

  if (inventoryError) throw inventoryError;
  if (loadoutError) throw loadoutError;

  const itemIds = (inventoryRows || []).map((row) => row.item_id);
  let catalogById = {};

  if (itemIds.length) {
    const { data: catalog, error: catalogError } = await state.supabase
      .from("item_catalog")
      .select("item_id, name, item_kind, slot_key, emoji, description")
      .in("item_id", itemIds);
    if (catalogError) throw catalogError;
    catalogById = Object.fromEntries((catalog || []).map((item) => [item.item_id, item]));
  }

  state.inventory = (inventoryRows || []).map((row) => ({
    ...row,
    item: catalogById[row.item_id] || null
  }));
  state.loadout = loadout;
  game.setLoadout(loadout.primary_item_id || "sword", loadout.secondary_item_id || "pistol");
}

async function refreshHistory() {
  if (!state.supabase || !state.user) return;
  const { data, error } = await state.supabase
    .from("match_players")
    .select("match_id, result, joined_at, matches(id, status, pot, created_at, ended_at, winner_user_id)")
    .eq("user_id", state.user.id)
    .order("joined_at", { ascending: false })
    .limit(6);
  if (error) throw error;
  state.history = data || [];
}

function renderProfile() {
  if (!state.profile) return;
  els.displayNameInput.value = state.profile.display_name || "";
  els.goldBalance.textContent = `${state.profile.gold_balance} gold`;
  els.walletAddress.textContent = state.profile.wallet_public_key ? shorten(state.profile.wallet_public_key, 8, 8) : "spectator";
  els.playerLevel.textContent = `${state.profile.level} · ${state.profile.xp} xp`;
  els.playerMmr.textContent = `${state.profile.mmr}`;
  els.playerRecord.textContent = `${state.profile.total_wins}-${state.profile.total_losses}`;
  els.playerShortId.textContent = state.user.id.slice(0, 8);
}

function renderInventory() {
  if (state.authMode !== "player") {
    els.inventoryCard.classList.add("hidden");
    return;
  }

  els.inventoryCard.classList.remove("hidden");
  const primary = state.loadout?.primary_item_id || "--";
  const secondary = state.loadout?.secondary_item_id || "--";
  els.primaryLoadout.textContent = primary;
  els.secondaryLoadout.textContent = secondary;
  setBadge(els.loadoutBadge, "wallet-bound", "badge-good");

  if (!state.inventory.length) {
    els.inventoryList.className = "inventory-list empty";
    els.inventoryList.textContent = "No inventory yet.";
    return;
  }

  els.inventoryList.className = "inventory-list";
  els.inventoryList.innerHTML = "";
  state.inventory.forEach((entry) => {
    const item = normalizeItem(entry);
    const row = document.createElement("div");
    row.className = "inventory-row";
    row.innerHTML = `
      <div class="inventory-copy">
        <strong>${item.emoji} ${escapeHtml(item.name)}</strong>
        <span>${escapeHtml(item.description)}</span>
      </div>
      <div class="inventory-actions">
        <span class="badge">x${entry.quantity}</span>
        <button class="secondary-button" type="button" data-slot="primary" data-item="${item.item_id}">Primary</button>
        <button class="secondary-button" type="button" data-slot="secondary" data-item="${item.item_id}">Secondary</button>
      </div>
    `;
    row.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", async () => {
        const nextPrimary = button.dataset.slot === "primary" ? button.dataset.item : primary;
        const nextSecondary = button.dataset.slot === "secondary" ? button.dataset.item : secondary;
        await saveLoadout(nextPrimary, nextSecondary);
      });
    });
    els.inventoryList.appendChild(row);
  });
}

function renderHistory() {
  if (!state.user) return;
  els.historyCard.classList.remove("hidden");

  if (!state.history.length) {
    els.historyList.className = "history-list empty";
    els.historyList.textContent = "No match history yet.";
    return;
  }

  els.historyList.className = "history-list";
  els.historyList.innerHTML = "";
  state.history.forEach((entry) => {
    const match = Array.isArray(entry.matches) ? entry.matches[0] : entry.matches;
    const row = document.createElement("div");
    row.className = "history-row";
    row.innerHTML = `
      <strong>${escapeHtml(entry.result || "alive")}</strong>
      <span>Pot ${match?.pot ?? 0} gold</span>
      <span>${formatDate(match?.created_at)}</span>
    `;
    els.historyList.appendChild(row);
  });
}

async function saveLoadout(primaryItemId, secondaryItemId) {
  if (!primaryItemId || !secondaryItemId) {
    setStatus("Choose both a primary and secondary inventory item.");
    return;
  }

  const { error } = await state.supabase.rpc("save_my_loadout", {
    p_primary_item_id: primaryItemId,
    p_secondary_item_id: secondaryItemId
  });
  if (error) {
    setStatus(error.message);
    return;
  }

  await refreshInventory();
  renderInventory();
  setStatus("Loadout saved.");
}

async function saveDisplayName() {
  if (!state.supabase || !state.user) return;
  const displayName = els.displayNameInput.value.trim();
  if (displayName.length < 3) {
    setStatus("Display names must be at least 3 characters.");
    return;
  }

  if (state.authMode === "player") {
    await syncWeb3Profile();
  } else {
    const { error } = await state.supabase
      .from("profiles")
      .update({ display_name: displayName })
      .eq("user_id", state.user.id);
    if (error) {
      setStatus(error.message);
      return;
    }
  }

  await refreshProfile();
  renderProfile();
  setStatus("Display name saved.");
}

async function invokeMatchAction(action, extra = {}) {
  if (!state.supabase) {
    setStatus("Connect to Supabase first.");
    return;
  }
  if (state.authMode !== "player") {
    setStatus("Spectators cannot join paid matches. Sign in with a Solana wallet to play.");
    return;
  }

  try {
    setStatus("Working...");
    const { data, error } = await state.supabase.functions.invoke("matchmaking", {
      body: {
        action,
        matchId: state.currentMatch?.id ?? null,
        ...extra
      }
    });
    if (error) throw error;

    await Promise.all([refreshProfile(), refreshHistory()]);
    if (data?.match?.id) {
      await applyPlayerMatchState(data.match.id);
    } else if (action === "cancel_queue" || action === "forfeit") {
      await clearCurrentRoom();
      renderMatch();
    }

    renderProfile();
    renderHistory();
    setStatus(data?.message || "Action complete.");
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Match action failed.");
  }
}

async function restoreOpenMatch() {
  if (state.authMode !== "player") return;
  const { data, error } = await state.supabase
    .from("match_players")
    .select("match_id, joined_at, matches(id, status)")
    .eq("user_id", state.user.id)
    .order("joined_at", { ascending: false })
    .limit(5);
  if (error) {
    console.warn(error);
    return;
  }
  const openMatch = (data || []).find((row) => {
    const match = Array.isArray(row.matches) ? row.matches[0] : row.matches;
    return match && (match.status === "waiting" || match.status === "active");
  });
  if (openMatch?.match_id) {
    await applyPlayerMatchState(openMatch.match_id);
  } else {
    await clearCurrentRoom();
    renderMatch();
  }
}

async function spectateRandomMatch() {
  if (!state.supabase) return;

  const { data, error } = await state.supabase
    .from("matches")
    .select("id, pot, status")
    .eq("status", "active")
    .limit(20);

  if (error) {
    setStatus(error.message);
    return;
  }

  if (!data?.length) {
    await clearCurrentRoom();
    game.setMode("spectator");
    setStatus("No live PvP rooms right now. Stay signed in as a spectator and try again soon.");
    els.presenceState.textContent = "No live rooms";
    return;
  }

  const randomMatch = data[Math.floor(Math.random() * data.length)];
  await applySpectatorMatchState(randomMatch.id);
  setStatus("Spectating a random live PvP room.");
}

async function applyPlayerMatchState(matchId) {
  await subscribeToMatch(matchId, "player");
  await refreshMatchSnapshot();
}

async function applySpectatorMatchState(matchId) {
  await subscribeToMatch(matchId, "spectator");
  await refreshMatchSnapshot();
}

async function refreshMatchSnapshot() {
  if (!state.currentMatch?.id) return;
  const matchId = state.currentMatch.id;
  const [{ data: match, error: matchError }, { data: players, error: playersError }] = await Promise.all([
    state.supabase
      .from("matches")
      .select("id, status, pot, winner_user_id, entry_fee")
      .eq("id", matchId)
      .single(),
    state.supabase
      .from("match_players")
      .select("match_id, user_id, seat, display_name, result")
      .eq("match_id", matchId)
      .order("seat", { ascending: true })
  ]);
  if (matchError) throw matchError;
  if (playersError) throw playersError;

  state.currentMatch = match;
  state.matchPlayers = players || [];
  renderMatch();
  syncArenaIdentity();
}

function renderMatch() {
  if (!state.currentMatch) {
    els.potValue.textContent = "0 gold";
    els.roster.className = "roster empty";
    els.roster.textContent = "No active match yet.";
    els.arenaTitle.textContent = "Offline Practice";
    els.presenceState.textContent = state.authMode === "spectator" ? "Waiting for a live room" : "Waiting for match";
    setBadge(els.matchStatusBadge, "idle");
    game.setMatchPhase("offline");
    updateActionButtons();
    updateHeroCtas();
    return;
  }

  els.potValue.textContent = `${state.currentMatch.pot} gold`;
  els.arenaTitle.textContent = state.authMode === "spectator"
    ? `Spectating ${state.currentMatch.id.slice(0, 8)}`
    : `Match ${state.currentMatch.id.slice(0, 8)}`;

  const statusKind = state.currentMatch.status === "active"
    ? "badge-good"
    : state.currentMatch.status === "waiting"
      ? "badge-warm"
      : "badge";
  setBadge(els.matchStatusBadge, state.currentMatch.status, statusKind);
  game.setMatchPhase(state.currentMatch.status);

  els.roster.className = "roster";
  els.roster.innerHTML = "";
  state.matchPlayers.forEach((player) => {
    const row = document.createElement("div");
    row.className = "roster-row";
    row.innerHTML = `
      <strong>${escapeHtml(player.display_name || player.user_id.slice(0, 8))}</strong>
      <span class="badge">${state.user && player.user_id === state.user.id ? "you" : `seat ${player.seat}`}</span>
      <span class="badge ${player.result === "won" ? "badge-good" : player.result === "lost" || player.result === "forfeited" ? "badge-danger" : ""}">${escapeHtml(player.result || "alive")}</span>
    `;
    els.roster.appendChild(row);
  });

  updateActionButtons();
  updateHeroCtas();
}

function updateActionButtons() {
  const canPlay = state.authMode === "player" && state.profile?.can_compete;
  const hasMatch = !!state.currentMatch;
  const isWaiting = state.currentMatch?.status === "waiting";
  const isActive = state.currentMatch?.status === "active";

  els.queueBtn.disabled = !canPlay || hasMatch;
  els.cancelQueueBtn.disabled = !canPlay || !isWaiting;
  els.claimWinBtn.disabled = !canPlay || !isActive;
  els.claimLossBtn.disabled = !canPlay || !isActive;
  els.forfeitBtn.disabled = !canPlay || !isActive;
}

function syncArenaIdentity() {
  if (!state.currentMatch) {
    game.clearAll();
    game.setMode(state.authMode === "spectator" ? "spectator" : "offline");
    return;
  }

  if (state.authMode === "player") {
    const remotePlayer = state.matchPlayers.find((player) => player.user_id !== state.user.id);
    game.setMode("player");
    game.setPlayerPerspective({
      userId: state.user.id,
      displayName: state.profile?.display_name || "You"
    });
    if (remotePlayer) {
      game.setRemoteIdentity({
        userId: remotePlayer.user_id,
        displayName: remotePlayer.display_name
      });
    } else {
      game.clearRemote();
    }
    game.resetForMatch();
    return;
  }

  const combatants = state.matchPlayers.slice(0, 2).map((player) => ({
    userId: player.user_id,
    displayName: player.display_name
  }));
  game.clearAll();
  game.setMode("spectator");
  game.setSpectatorCombatants(combatants);
  game.resetForMatch();
}

async function subscribeToMatch(matchId, mode) {
  await clearCurrentRoom();
  state.currentMatch = { id: matchId };

  state.matchSubscription = state.supabase
    .channel(`db-match-${matchId}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "matches",
      filter: `id=eq.${matchId}`
    }, async () => {
      await refreshMatchSnapshot();
      if (state.authMode === "player") {
        await Promise.all([refreshProfile(), refreshHistory()]);
        renderProfile();
        renderHistory();
      }
    })
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "match_players",
      filter: `match_id=eq.${matchId}`
    }, async () => {
      await refreshMatchSnapshot();
    })
    .subscribe();

  if (mode === "player") {
    state.arenaChannel = state.supabase.channel(`match-room-${matchId}`, {
      config: { private: true }
    });
    bindArenaChannel(state.arenaChannel, "player");
    await state.arenaChannel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        state.arenaChannel.track({
          user_id: state.user.id,
          display_name: state.profile?.display_name
        });
        els.presenceState.textContent = "Private player room connected";
      }
    });
  }

  state.spectatorChannel = state.supabase.channel(`spectate-room-${matchId}`, {
    config: { private: true }
  });
  bindArenaChannel(state.spectatorChannel, mode === "player" ? "spectate-publisher" : "spectator");
  await state.spectatorChannel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      els.presenceState.textContent = mode === "player" ? "Match room live + spectator mirror live" : "Spectator room connected";
    }
  });
}

function bindArenaChannel(channel, mode) {
  channel
    .on("broadcast", { event: "state" }, ({ payload }) => {
      if (!payload || !payload.userId) return;
      if (mode === "player") {
        if (payload.userId !== state.user.id) {
          game.receivePlayerState(payload.snapshot);
        }
        return;
      }
      if (mode === "spectator") {
        game.receiveSpectatorState(payload.userId, payload.snapshot);
      }
    })
    .on("broadcast", { event: "attack" }, ({ payload }) => {
      if (mode === "spectator") {
        game.receiveAttack(payload);
      } else if (mode === "player") {
        game.receiveAttack(payload);
      }
    })
    .on("presence", { event: "sync" }, () => {
      const members = Object.keys(channel.presenceState()).length;
      if (mode === "player") {
        els.presenceState.textContent = `${members} player${members === 1 ? "" : "s"} in the private room`;
      }
    });
}

function broadcastToMatchChannels(event, payload) {
  if (state.arenaChannel) {
    state.arenaChannel.send({
      type: "broadcast",
      event,
      payload
    });
  }
  if (state.spectatorChannel) {
    state.spectatorChannel.send({
      type: "broadcast",
      event,
      payload
    });
  }
}

async function clearCurrentRoom() {
  if (!state.supabase) return;
  if (state.matchSubscription) {
    await state.supabase.removeChannel(state.matchSubscription);
    state.matchSubscription = null;
  }
  if (state.arenaChannel) {
    await state.supabase.removeChannel(state.arenaChannel);
    state.arenaChannel = null;
  }
  if (state.spectatorChannel) {
    await state.supabase.removeChannel(state.spectatorChannel);
    state.spectatorChannel = null;
  }
  state.currentMatch = null;
  state.matchPlayers = [];
}

async function submitResultClaim(isWin) {
  if (!state.currentMatch || state.authMode !== "player") {
    setStatus("Only players in an active match can settle results.");
    return;
  }
  const remotePlayer = state.matchPlayers.find((player) => player.user_id !== state.user.id);
  if (!remotePlayer) {
    setStatus("Your opponent has not joined yet.");
    return;
  }
  const winnerUserId = isWin ? state.user.id : remotePlayer.user_id;
  await invokeMatchAction("claim_result", { winnerUserId });
}

function normalizeItem(entry) {
  const item = Array.isArray(entry.item) ? entry.item[0] : entry.item;
  return item || { item_id: entry.item_id, name: entry.item_id, emoji: "🎒", description: "" };
}

function shorten(value, start, end) {
  if (!value) return "--";
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

function formatDate(value) {
  if (!value) return "now";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
