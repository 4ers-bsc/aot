import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createArenaGame } from "./game.js";
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
const SIGN_IN_STATEMENT = "Sign in to Age of Trenches to play realtime trench duels.";

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
};

const game = createArenaGame({
  mount: els.arenaMount,
  onLocalState: (snapshot) => {
    state.channel?.send({ type: "broadcast", event: "state", payload: { userId: state.user?.id, snapshot } });
  },
  onAttack: (attackEvent) => {
    state.channel?.send({ type: "broadcast", event: "attack", payload: attackEvent });
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
  els.profileBtn.addEventListener("click", openProfile);
  els.profileClose.addEventListener("click", () => els.profileOverlay.classList.remove("show"));
  els.profileOverlay.addEventListener("pointerdown", (e) => {
    if (e.target === els.profileOverlay) els.profileOverlay.classList.remove("show");
  });
  els.profileSaveBtn.addEventListener("click", saveProfile);
  els.profileNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveProfile(); });
  els.profileTabs.forEach((t) => t.addEventListener("click", () => selectProfileTab(t.dataset.ptab)));
  els.pvpCancelBtn.addEventListener("click", () => leaveMatch());
  els.gameOverMenuBtn.addEventListener("click", () => { hideGameOver(); leaveMatch({ silent: true }); });
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
let pvpLobbySeconds = 0;

function showPvpLobby(status) {
  els.pvpLobbyStatus.textContent = status || "Searching for an opponent…";
  els.pvpLobbyMeta.textContent = "";
  els.pvpLobby.classList.remove("hidden");
  pvpLobbySeconds = 0;
  clearInterval(pvpLobbyTimer);
  pvpLobbyTimer = setInterval(() => { pvpLobbySeconds++; }, 1000);
}

function hidePvpLobby() {
  clearInterval(pvpLobbyTimer);
  pvpLobbyTimer = null;
  els.pvpLobby.classList.add("hidden");
  const potEl = document.getElementById("pvpPrizePool");
  if (potEl) potEl.classList.add("hidden");
}

function showGameOver(result, reason, standings = [], prizeAmount = null) {
  const win = result === "win";
  els.gameOverTitle.textContent = win ? "VICTORY" : "DEFEAT";
  els.gameOverTitle.classList.toggle("is-win", win);
  els.gameOverTitle.classList.toggle("is-loss", !win);
  els.gameOverReason.textContent = reason || (win ? "Your rival fell in the trench." : "You fell in the trench.");
  els.gameOverName.textContent = state.profile?.display_name || "Trench Rookie";
  els.gameOverWins.textContent = state.profile?.wins ?? 0;
  els.gameOverLosses.textContent = state.profile?.losses ?? 0;
  renderStandings(standings);
  // Prize display
  const prizeEl  = document.getElementById("gameOverPrize");
  const prizeAmt = document.getElementById("gameOverPrizeAmount");
  if (prizeEl && prizeAmt) {
    if (win) {
      prizeAmt.textContent = prizeAmount === "pending" ? "Processing payout…" : prizeAmount !== null
        ? prizeAmount.toLocaleString(undefined, { maximumFractionDigits: 0 }) + " $FIGHT10"
        : "Payout failed — contact support";
      prizeEl.classList.remove("hidden");
    } else {
      prizeEl.classList.add("hidden");
    }
  }
  // Hide menu button while payout is in-flight; show it for losses immediately
  els.gameOverMenuBtn.classList.toggle("hidden", win && prizeAmount === "pending");
  els.gameOver.classList.remove("hidden");
}

function updateGameOverPrize(prizeAmount) {
  const prizeEl   = document.getElementById("gameOverPrize");
  const prizeAmt  = document.getElementById("gameOverPrizeAmount");
  const retryBtn  = document.getElementById("gameOverRetryBtn");
  if (!prizeEl || !prizeAmt) return;
  if (prizeAmount !== null) {
    prizeAmt.textContent = prizeAmount.toLocaleString(undefined, { maximumFractionDigits: 0 }) + " $FIGHT10";
    retryBtn?.classList.add("hidden");
  } else {
    prizeAmt.textContent = "Payout failed — tap Retry or contact support";
    retryBtn?.classList.remove("hidden");
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
  try {
    const { data: payoutData, error: payoutErr } = await supabase.functions.invoke("f10treasurer", {
      body: { match_id: state.match.id },
    });
    if (!payoutErr && payoutData?.winner_amount && payoutData?.decimals != null) {
      prizeAmount = Number(BigInt(payoutData.winner_amount)) / 10 ** payoutData.decimals;
    }
    if (payoutErr) console.error("Retry payout error:", payoutErr);
  } catch (err) {
    console.error("Retry payout error:", err);
  }
  updateGameOverPrize(prizeAmount);
}

// Fix 2: poll until the match row is marked 'finished' before invoking the
// edge function, guarding against rare Supabase read-after-write lag.
async function awaitMatchFinished(matchId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await supabase.from("matches").select("status").eq("id", matchId).single();
    if (data?.status === "finished") return;
    await new Promise((r) => setTimeout(r, 800));
  }
}

function renderStandings(standings) {
  const el = document.getElementById("gameOverStandings");
  if (!el) return;
  if (!standings.length) { el.innerHTML = ""; return; }
  el.innerHTML = standings.map((s) =>
    `<div class="standing-row${s.me ? " standing-me" : ""}">` +
    `<span class="standing-rank">#${s.rank}</span>` +
    `<span class="standing-name">${escapeHtml(s.name)}</span>` +
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
  try {
    // ── Step 1: deposit on-chain (if not already done from a previous failed attempt) ──
    let txSig = state.pendingDepositTx;
    if (!txSig) {
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
    showPvpLobby(`Finding a ${size}-player match…`);
    const { data, error } = await supabase.rpc("join_pvp_match", {
      p_max_players: size,
      p_deposit_tx: txSig,
    });
    if (error) throw error;

    // Joined successfully — clear the pending deposit.
    state.pendingDepositTx = null;

    state.match = {
      id: data.match_id, mode: "pvp", finished: false,
      status: data.status === "active" ? "active" : "waiting",
      maxPlayers: data.max_players || size
    };
    state.seat = data.seat;

    // Pass iRoomFiller into enterArena; teardownMatch inside it resets the flag
    // so it must be restored there, after the reset, before loadRoster() runs.
    await enterArena(data.match_id, data.status === "active");
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

  if (FIGHT10_MINT.startsWith("<") || ESCROW_WALLET.startsWith("<")) {
    setStatus("Game not configured for live deposits yet (missing mint/escrow address).");
    return null;
  }

  setStatus("Checking $FIGHT10 balance…");
  const balance = await getFight10Balance(wallet.publicKey.toString());
  if (balance < ENTRY_FEE_RAW) {
    const have = Number(balance) / 10 ** FIGHT10_DECIMALS;
    setStatus(`Insufficient $FIGHT10 balance — need 2,500, have ${have.toFixed(0)}.`);
    return null;
  }

  try {
    updatePrizePot(numPlayers);
    setStatus("Depositing 2,500 $FIGHT10… approve in wallet.");
    els.pvpLobbyStatus.textContent = "Approve deposit in your wallet…";

    const connection   = new Connection(SOLANA_RPC_URL, "confirmed");
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
  try {
    const connection   = new Connection(SOLANA_RPC_URL, "confirmed");
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
  } catch (err) {
    console.warn("[getFight10Balance]", err?.message ?? err);
    return BigInt(0);
  }
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
    supabase.from("match_players").select("user_id, seat, display_name, deposit_tx").eq("match_id", matchId).order("seat", { ascending: true })
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
      game.addOpponent({ userId: p.user_id, displayName: p.display_name });
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
    if (!state.depositPollTimer) {
      state.depositPollTimer = setInterval(() => loadRoster(matchId).catch(console.error), 2500);
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
function matchDuration(max) {
  if (max >= 10) return 15 * 60;
  if (max >= 5) return 10 * 60;
  return 5 * 60;
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

function beginMatch(skipCountdown = false, startAt = null) {
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
  game.resetForMatch();
  game.setMatchPhase("countdown");
  game.setControllable(false);
  startPingLoop();
  if (skipCountdown) {
    // Late joiner who missed the "start" broadcast — match already in progress,
    // drop straight into active rather than showing a stale countdown.
    game.setMatchPhase("active");
    game.setControllable(true);
    game.setMatchTimer(matchDuration(state.match?.maxPlayers || 2));
    setStatus("Fight! Last one standing wins.");
  } else {
    runMatchStart(() => {
      game.setMatchPhase("active");
      game.setControllable(true);
      game.setMatchTimer(matchDuration(state.match?.maxPlayers || 2));
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

    if (matchRow?.status === "finished") {
      // Match already settled server-side. If we're not the winner, show the loss.
      if (matchRow.winner_user_id !== state.user?.id) {
        reportResult("loss", { reason: "You were defeated." }).catch(console.error);
      }
      return;
    }

    // Match still active — opponent genuinely disconnected mid-game.
    reportResult("win", { reason: "Last one standing — rivals disconnected." }).catch((e) => console.error(e));
  }
}

// All players submit their final HP as a witness report. The server-side
// finish_match function tallies all witness reports and crowns the winner
// itself — no client can pass its own user_id as winner.
async function reportResult(result, { reason = "", standings = [] } = {}) {
  if (state.match?.mode !== "pvp" || !state.match.id || state.match.finished) return;
  state.match.finished = true;

  // Every participant (winner and losers alike) submits their final HP so the
  // server can independently determine who survived. p_final_hp = 0 means dead.
  const finalHp = result === "win" ? (standings.find((s) => s.me)?.hp ?? 1) : 0;
  try {
    await supabase.rpc("finish_match", {
      p_match_id: state.match.id,
      p_final_hp: Math.max(0, Math.round(finalHp)),
    });
  } catch (e) {
    console.error("finish_match witness error:", e);
  }

  if (result !== "win") {
    try { await syncProfile(); } catch (e) { console.error(e); }
    showGameOver(result, reason, standings, null);
    return;
  }

  // Winner: show game-over with "processing" state, then fill in prize once treasurer confirms
  showGameOver(result, reason, standings, "pending");
  let prizeAmount = null;
  try {
    setStatus("Claiming prize…");
    // Fix 2: confirm the match is marked finished in the DB before invoking the
    // edge function — guards against the edge function seeing status='active'.
    await awaitMatchFinished(state.match.id);
    const { data: payoutData, error: payoutErr } = await supabase.functions.invoke("f10treasurer", {
      body: { match_id: state.match.id },
    });
    if (payoutErr) {
      console.error("Payout invoke error:", payoutErr);
    } else if (payoutData?.winner_amount && payoutData?.decimals != null) {
      prizeAmount = Number(BigInt(payoutData.winner_amount)) / 10 ** payoutData.decimals;
    }
    await syncProfile();
  } catch (error) {
    console.error(error);
  }
  updateGameOverPrize(prizeAmount);
}

async function leaveMatch({ silent = false } = {}) {
  hidePvpLobby();
  hideGameOver();
  cancelMatchStart();
  if (!state.match) { if (!silent) setStatus("You're not in a match."); return; }
  if (state.match.mode === "pvp") {
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
    .select("joined_at, matches(id, status, max_players, winner_user_id, ended_at)")
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
    .filter((m) => m && m.status === "finished");
  if (!rows.length) {
    els.historyList.innerHTML = '<div class="history-empty">No matches played yet.</div>';
    return;
  }
  els.historyList.innerHTML = "";
  for (const m of rows) {
    const win = m.winner_user_id === state.user.id;
    const noContest = !m.winner_user_id;
    const row = document.createElement("div");
    row.className = "history-row " + (noContest ? "hr-void" : win ? "hr-win" : "hr-loss");
    const result = noContest ? "—" : win ? "WIN" : "LOSS";
    const when = m.ended_at ? new Date(m.ended_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
    row.innerHTML =
      `<span class="hr-result">${result}</span>` +
      `<span class="hr-mode">${m.max_players}-player</span>` +
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

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toggle(el, show) {
  if (el) el.classList.toggle("hidden", !show);
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
