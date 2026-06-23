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
  pingInterval: null
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
  console.log("[signIn] getSolanaWallet →", wallet
    ? `found (isPhantom=${wallet.isPhantom}, isBackpack=${wallet.isBackpack}, publicKey=${wallet.publicKey?.toString() ?? "not connected yet"})`
    : "null — no wallet extension detected");
  if (!wallet) {
    setStatus("No Solana wallet found. Install Phantom, Backpack, or Brave Wallet.");
    return;
  }
  try {
    setStatus("Approve the signature in your wallet…");
    console.log("[signIn] calling wallet.connect()…");
    await wallet.connect();
    console.log("[signIn] wallet.connect() resolved — publicKey:", wallet.publicKey?.toString());
    console.log("[signIn] calling supabase.auth.signInWithWeb3…");
    const { error } = await supabase.auth.signInWithWeb3({ chain: "solana", statement: SIGN_IN_STATEMENT, wallet });
    if (error) throw error;
    console.log("[signIn] signInWithWeb3 succeeded");
  } catch (error) {
    console.error("[signIn] error:", error);
    setStatus(error.message || "Wallet sign-in failed.");
  }
}

async function signOut() {
  await leaveMatch({ silent: true });
  const { error } = await supabase.auth.signOut();
  if (error) setStatus(error.message);
}

async function handleSession(session) {
  console.log("[handleSession] session user:", session?.user?.id ?? "none");
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
    console.log("[handleSession] syncing profile for user", state.user.id);
    await syncProfile();
    console.log("[handleSession] profile synced:", state.profile);
  } catch (error) {
    console.error("[handleSession] syncProfile error:", error);
    setStatus(error.message || "Could not load profile.");
    return;
  }
  showLobby();
  setStatus(recordSuffix("Wallet connected — choose Demo Match or Play PvP."));
  refreshFight10Balance().catch((e) => console.error("[handleSession] refreshFight10Balance error:", e));
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
  state.remoteIds.clear();
  state.started = true;
  game.setView("game");
  game.setLocalUser({ userId: state.user.id, displayName: state.profile?.display_name || "You" });
  game.useAiFoe();          // single AI raider opponent
  game.generateMap("demo-" + Date.now());
  game.resetForMatch();
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
    if (win && prizeAmount !== null) {
      prizeAmt.textContent = prizeAmount.toLocaleString(undefined, { maximumFractionDigits: 0 });
      prizeEl.classList.remove("hidden");
    } else {
      prizeEl.classList.add("hidden");
    }
  }
  els.gameOver.classList.remove("hidden");
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
  console.log("[joinPvp] size selected:", size, "| user:", state.user.id);
  try {
    showPvpLobby(`Finding a ${size}-player match…`);
    console.log("[joinPvp] calling join_pvp_match RPC…");
    const { data, error } = await supabase.rpc("join_pvp_match", { p_max_players: size, p_display_name: null });
    if (error) throw error;
    console.log("[joinPvp] join_pvp_match response:", data);
    state.match = {
      id: data.match_id, mode: "pvp", finished: false,
      status: data.status === "active" ? "active" : "waiting",
      maxPlayers: data.max_players || size
    };
    state.iRoomFiller = data.status === "active";
    state.seat = data.seat;
    console.log("[joinPvp] match state set — id:", data.match_id, "seat:", data.seat, "status:", data.status);

    console.log("[joinPvp] starting deposit gate for match", data.match_id);
    const deposited = await depositEntryFee(data.match_id, size);
    console.log("[joinPvp] depositEntryFee returned:", deposited);
    if (!deposited) {
      hidePvpLobby();
      try { await supabase.rpc("leave_my_matches"); } catch (_) {}
      state.match = null;
      state.seat = null;
      setStatus("Deposit cancelled — you were not charged.");
      return;
    }

    console.log("[joinPvp] deposit confirmed — entering arena");
    await enterArena(data.match_id);
  } catch (error) {
    hidePvpLobby();
    console.error("[joinPvp] error:", error);
    setStatus(error.message || "Could not join a PvP match.");
  }
}

// ---------------------------------------------------------------------------
// FIGHT10 deposit — transfer ENTRY_FEE from player wallet to escrow on-chain
// Returns true if the deposit was confirmed and recorded, false if cancelled.
// ---------------------------------------------------------------------------
async function depositEntryFee(matchId, numPlayers = 2) {
  console.log("[depositEntryFee] ── START ──");
  console.log("[depositEntryFee] matchId:", matchId, "| numPlayers:", numPlayers);
  console.log("[depositEntryFee] FIGHT10_MINT (mint CA):", FIGHT10_MINT);
  console.log("[depositEntryFee] ESCROW_WALLET (treasury):", ESCROW_WALLET);
  console.log("[depositEntryFee] ENTRY_FEE_RAW (raw units):", ENTRY_FEE_RAW.toString(), `(${ENTRY_FEE} × 10^${FIGHT10_DECIMALS})`);

  const wallet = getSolanaWallet();
  console.log("[depositEntryFee] wallet publicKey:", wallet?.publicKey?.toString() ?? "not connected");
  if (!wallet?.publicKey) {
    setStatus("Wallet not connected — cannot deposit.");
    return false;
  }

  // Guard: catch unset env vars before hitting PublicKey constructor
  if (FIGHT10_MINT.startsWith("<") || ESCROW_WALLET.startsWith("<")) {
    console.error("[depositEntryFee] ✗ Missing env var —",
      `VITE_FIGHT10_MINT=${FIGHT10_MINT}`, `VITE_ESCROW_WALLET=${ESCROW_WALLET}`);
    setStatus("Game not configured for live deposits yet (missing mint/escrow address).");
    return false;
  }

  // Check balance before prompting
  console.log("[depositEntryFee] checking player balance…");
  setStatus("Checking $FIGHT10 balance…");
  const balance = await getFight10Balance(wallet.publicKey.toString());
  console.log("[depositEntryFee] player balance (raw):", balance.toString(),
    "| display:", (Number(balance) / 10 ** FIGHT10_DECIMALS).toFixed(0), "FIGHT10",
    "| need:", ENTRY_FEE, "| sufficient:", balance >= ENTRY_FEE_RAW);
  if (balance < ENTRY_FEE_RAW) {
    const have = Number(balance) / 10 ** FIGHT10_DECIMALS;
    setStatus(`Insufficient $FIGHT10 balance — need 2,500, have ${have.toFixed(0)}.`);
    return false;
  }

  try {
    updatePrizePot(numPlayers);
    setStatus("Depositing 2,500 $FIGHT10… approve in wallet.");
    els.pvpLobbyStatus.textContent = "Approve deposit in your wallet…";

    const connection  = new Connection(SOLANA_RPC_URL, "confirmed");
    const mintPubkey  = new PublicKey(FIGHT10_MINT);
    const escrowPubkey = new PublicKey(ESCROW_WALLET);
    const playerPubkey = wallet.publicKey;
    console.log("[depositEntryFee] RPC:", SOLANA_RPC_URL);
    console.log("[depositEntryFee] player pubkey:", playerPubkey.toString());
    console.log("[depositEntryFee] escrow pubkey:", escrowPubkey.toString());

    // Find the player's actual token account for FIGHT10 (may not be the canonical ATA)
    console.log("[depositEntryFee] fetching player token accounts for mint…");
    const tokenAccounts = await connection.getTokenAccountsByOwner(playerPubkey, { mint: mintPubkey });
    console.log("[depositEntryFee] player token accounts found:", tokenAccounts.value.length,
      tokenAccounts.value.map((a) => a.pubkey.toString()));
    if (!tokenAccounts.value.length) throw new Error("No FIGHT10 token account found in wallet.");

    // Pick the account with the highest balance as source
    let sourceAta = tokenAccounts.value[0].pubkey;
    if (tokenAccounts.value.length > 1) {
      const infos = await Promise.all(
        tokenAccounts.value.map((a) => connection.getParsedAccountInfo(a.pubkey))
      );
      let max = BigInt(0);
      tokenAccounts.value.forEach((a, i) => {
        const amt = BigInt(infos[i].value.data.parsed.info.tokenAmount.amount);
        if (amt > max) { max = amt; sourceAta = a.pubkey; }
      });
    }
    const sourceInfo = await connection.getParsedAccountInfo(sourceAta);
    const sourceAmount = sourceInfo.value.data.parsed.info.tokenAmount;
    console.log("[depositEntryFee] source token account (FROM):", sourceAta.toString());
    console.log("[depositEntryFee] source balance:", sourceAmount.uiAmount, "FIGHT10 (raw:", sourceAmount.amount, ")");

    // Canonical escrow ATA — create it in the same tx if it doesn't exist yet (one-time)
    const escrowAta = await getAssociatedTokenAddress(mintPubkey, escrowPubkey, false,
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    console.log("[depositEntryFee] escrow ATA (TO):", escrowAta.toString());
    const escrowAtaInfo = await connection.getAccountInfo(escrowAta);
    console.log("[depositEntryFee] escrow ATA exists on-chain:", !!escrowAtaInfo);

    const instructions = [];
    if (!escrowAtaInfo) {
      console.log("[depositEntryFee] ⚠ escrow ATA missing — prepending createAssociatedTokenAccount instruction (player pays ~0.002 SOL rent, one-time)");
      instructions.push(createAssociatedTokenAccountInstruction(
        playerPubkey, escrowAta, escrowPubkey, mintPubkey,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      ));
    }
    instructions.push(createTransferInstruction(
      sourceAta, escrowAta, playerPubkey, ENTRY_FEE_RAW, [], TOKEN_PROGRAM_ID
    ));
    console.log("[depositEntryFee] instructions count:", instructions.length,
      instructions.length > 1 ? "(createATA + transfer)" : "(transfer only)");

    console.log("[depositEntryFee] fetching latest blockhash…");
    const { blockhash } = await connection.getLatestBlockhash();
    console.log("[depositEntryFee] blockhash:", blockhash);

    const tx = new Transaction().add(...instructions);
    tx.feePayer = playerPubkey;
    tx.recentBlockhash = blockhash;

    console.log("[depositEntryFee] requesting wallet signature — wallet will prompt user…");
    const signedTx = await wallet.signTransaction(tx);
    console.log("[depositEntryFee] wallet signed — sending raw transaction…");
    const txSig = await connection.sendRawTransaction(signedTx.serialize());
    console.log("[depositEntryFee] ✓ tx sent — signature:", txSig);
    console.log("[depositEntryFee] Solscan:", `https://solscan.io/tx/${txSig}`);

    setStatus("Confirming deposit on-chain…");
    els.pvpLobbyStatus.textContent = "Confirming on-chain…";
    console.log("[depositEntryFee] waiting for confirmation…");
    const confirmation = await connection.confirmTransaction(txSig, "confirmed");
    console.log("[depositEntryFee] confirmation result:", confirmation.value);
    if (confirmation.value.err) throw new Error("Transaction failed to confirm: " + JSON.stringify(confirmation.value.err));
    console.log("[depositEntryFee] ✓ confirmed on-chain");

    console.log("[depositEntryFee] recording deposit in DB — match:", matchId, "tx:", txSig);
    const { error: recErr } = await supabase.rpc("record_deposit", {
      p_match_id: matchId,
      p_deposit_tx: txSig,
    });
    if (recErr) throw recErr;
    console.log("[depositEntryFee] ✓ record_deposit RPC succeeded");

    setStatus("Deposit confirmed — entering arena.");
    console.log("[depositEntryFee] ── DONE ──");
    return true;
  } catch (err) {
    console.error("[depositEntryFee] ✗ error:", err);
    const msg = err?.message || String(err);
    if (msg.includes("User rejected") || msg.includes("cancelled")) {
      setStatus("Deposit cancelled.");
    } else {
      setStatus("Deposit failed: " + msg);
    }
    return false;
  }
}

async function getFight10Balance(walletAddress) {
  console.log("[getFight10Balance] wallet:", walletAddress);
  console.log("[getFight10Balance] mint:", FIGHT10_MINT);
  console.log("[getFight10Balance] RPC:", SOLANA_RPC_URL);
  try {
    const connection  = new Connection(SOLANA_RPC_URL, "confirmed");
    const mintPubkey  = new PublicKey(FIGHT10_MINT);
    const walletPubkey = new PublicKey(walletAddress);

    console.log("[getFight10Balance] calling getParsedTokenAccountsByOwner…");
    const { value: accounts } = await connection.getParsedTokenAccountsByOwner(
      walletPubkey,
      { mint: mintPubkey }
    );
    console.log("[getFight10Balance] token accounts found:", accounts.length,
      accounts.map((a) => ({
        pubkey: a.pubkey.toString(),
        amount: a.account.data.parsed.info.tokenAmount.amount,
        uiAmount: a.account.data.parsed.info.tokenAmount.uiAmount,
      }))
    );

    if (accounts.length === 0) {
      console.log("[getFight10Balance] no token accounts found — wallet holds 0 FIGHT10");
      return BigInt(0);
    }

    // Sum all accounts (wallet may hold tokens across multiple accounts)
    const total = accounts.reduce(
      (sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount),
      BigInt(0)
    );
    console.log("[getFight10Balance] total raw balance:", total.toString());
    return total;
  } catch (err) {
    console.warn("[getFight10Balance] error:", err?.name, err?.message ?? err);
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
  console.log("[refreshFight10Balance] starting…");
  const balEl = document.getElementById("fight10Balance");
  if (!balEl) { console.warn("[refreshFight10Balance] #fight10Balance element not found in DOM"); return; }
  if (!state.user) { console.log("[refreshFight10Balance] no authenticated user, skipping"); return; }
  const wallet = getSolanaWallet();
  console.log("[refreshFight10Balance] wallet publicKey:", wallet?.publicKey?.toString() ?? "none");
  if (!wallet?.publicKey) { console.warn("[refreshFight10Balance] wallet not connected, cannot fetch balance"); return; }
  try {
    const raw = await getFight10Balance(wallet.publicKey.toString());
    const display = (Number(raw) / 10 ** FIGHT10_DECIMALS).toLocaleString(undefined, { maximumFractionDigits: 0 });
    console.log("[refreshFight10Balance] display balance:", display, "$FIGHT10 — updating nav chip");
    balEl.textContent = display + " $FIGHT10";
    balEl.classList.remove("hidden");
  } catch (err) {
    console.error("[refreshFight10Balance] unexpected error:", err);
  }
}

async function enterArena(matchId) {
  await teardownMatch(true);
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
    .on("broadcast", { event: "start" }, () => beginMatch())
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
      game.addOpponent({ userId: p.user_id, displayName: p.display_name });
    }
  }

  renderLobbyPlayers(players, max);

  const isActive = matchRow?.status === "active";
  if (isActive) {
    const isLateSync = !state.iRoomFiller && state.match?.status !== "active";
    beginMatch(isLateSync);
  } else {
    els.pvpLobbyStatus.textContent = "Waiting for players…";
    els.pvpLobbyMeta.textContent = `${players.length} / ${max} players`;
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
  const probe = async () => {
    try {
      const t0 = performance.now();
      await supabase.from("profiles").select("id").limit(1);
      game.setPing(Math.round(performance.now() - t0));
    } catch (_) {}
  };
  probe();
  state.pingInterval = setInterval(probe, 3000);
}

function stopPingLoop() {
  if (state.pingInterval) { clearInterval(state.pingInterval); state.pingInterval = null; }
  game.setPing(null);
}

function beginMatch(skipCountdown = false) {
  if (state.started) return;
  state.started = true;
  if (state.match) state.match.status = "active";
  // Tell every other client to start too (presence sync alone can miss one).
  state.channel?.send({ type: "broadcast", event: "start", payload: {} });
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
    });
  }
}

// ---------------------------------------------------------------------------
// Result handling (PvP only) — loser is whoever hits 0 HP or disconnects
// ---------------------------------------------------------------------------
// A rival dropped the connection: remove them. If they were the last one and
// we're still standing, we take the win.
function handleOpponentLeft(userId) {
  state.remoteIds.delete(userId);
  const remaining = game.removeOpponent(userId);
  if (state.match?.mode !== "pvp" || state.match.finished || !state.started) return;
  if (remaining === 0 && game.playerAlive()) {
    reportResult("win", { reason: "Last one standing — rivals disconnected." }).catch((e) => console.error(e));
  }
}

// Free-for-all: only the winner writes the result (and finish_match marks the
// loss for everyone else). Losers just show defeat and refresh their record.
async function reportResult(result, { reason = "", standings = [] } = {}) {
  if (state.match?.mode !== "pvp" || !state.match.id || state.match.finished) return;
  state.match.finished = true;
  let prizeAmount = null;
  try {
    if (result === "win") {
      await supabase.rpc("finish_match", { p_match_id: state.match.id, p_winner_user_id: state.user.id });
      // Claim prize
      setStatus("Claiming prize…");
      const { data: payoutData, error: payoutErr } = await supabase.functions.invoke("f10treasurer", {
        body: { match_id: state.match.id },
      });
      if (payoutErr) {
        console.error("Payout invoke error:", payoutErr);
      } else if (payoutData?.winner_amount && payoutData?.decimals != null) {
        prizeAmount = Number(BigInt(payoutData.winner_amount)) / 10 ** payoutData.decimals;
      }
    }
    await syncProfile();
  } catch (error) {
    console.error(error);
  }
  showGameOver(result, reason, standings, prizeAmount);
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
  showLobby();
  if (!silent) setStatus(recordSuffix("Left the match."));
}

async function teardownMatch(keepMatch = false) {
  stopPingLoop();
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
  toggle(els.demoBtn, connected);
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
function runMatchStart(onDone) {
  const ov = els.matchStarting;
  cancelMatchStart();
  let n = 3;
  const count = els.matchStartCount;
  if (count) count.textContent = String(n);
  ov.classList.add("show");
  matchStartTimer = setInterval(() => {
    n--;
    if (n > 0) {
      if (count) count.textContent = String(n);
    } else {
      clearInterval(matchStartTimer);
      matchStartTimer = null;
      ov.classList.remove("show");
      onDone?.();
    }
  }, 1000);
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
