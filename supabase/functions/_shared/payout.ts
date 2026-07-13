// ============================================================================
// _shared/payout.ts — the SINGLE place escrow payout logic lives.
//
// Both f10treasurer (winner self-claim) and f10admin (operator pays an
// unclaimed winner) import from here, so the private-key signing + on-chain
// deposit verification exist in exactly one module instead of two drifting
// copies. Files/dirs under supabase/functions prefixed with "_" are importable
// shared code but are NOT deployed as standalone functions.
//
// Chain: Robinhood Chain (an Ethereum L2), mainnet only. Kept in sync with the
// client's src/network.js.
// ============================================================================

import { Contract, JsonRpcProvider, Wallet } from "npm:ethers@6.13.0";

export const NETWORK: { name: string; chainId: number; rpcUrl: string } = {
  name: "Robinhood Chain",
  chainId: 4663,
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
};

// keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer event.
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

// Ethereum addresses are case-insensitive; stored wallet_address values may
// carry a "chain:" prefix (e.g. "ethereum:0x…") — normalise to the lowercased
// trailing segment.
export const normAddr = (w?: string | null) =>
  ((w ?? "").trim().split(":").pop() ?? "").trim().toLowerCase();
export const isAddress = (a: string) => /^0x[0-9a-f]{40}$/.test(a);
// An indexed address event topic is the address left-padded to 32 bytes.
export const topicToAddr = (t?: string) => (t ? "0x" + t.slice(-40).toLowerCase() : "");

// Does this receipt contain the exact entry-fee Transfer from the player's
// wallet to escrow, emitted by OUR token contract?
export function receiptHasDeposit(
  receipt: any, tokenAddr: string, sender: string, escrow: string, amount: bigint,
): boolean {
  return (receipt?.logs ?? []).some((log: any) =>
    (log.address ?? "").toLowerCase() === tokenAddr &&
    (log.topics?.[0] ?? "") === TRANSFER_TOPIC &&
    topicToAddr(log.topics?.[1]) === sender &&
    topicToAddr(log.topics?.[2]) === escrow &&
    BigInt(log.data ?? "0x0") === amount
  );
}

// ---------------------------------------------------------------------------
// RPC endpoint pool — spread load across up to 3 keys, rotate on error, and
// lease() one sticky provider for a send + confirm sequence.
// ---------------------------------------------------------------------------
export function getRpcUrls(): string[] {
  const urls = [Deno.env.get("RPC_URL"), Deno.env.get("RPC_URL_2"), Deno.env.get("RPC_URL_3")]
    .map((u) => u?.trim()).filter((u): u is string => !!u);
  const unique = [...new Set(urls)];
  return unique.length ? unique : [NETWORK.rpcUrl];
}

export function createRpcPool() {
  const providers = getRpcUrls().map((u) =>
    new JsonRpcProvider(u, NETWORK.chainId, { staticNetwork: true }));
  let idx = Math.floor(Math.random() * providers.length);
  const next = () => { const p = providers[idx]; idx = (idx + 1) % providers.length; return p; };
  return {
    lease: () => next(),
    async run<T>(fn: (p: JsonRpcProvider) => Promise<T>): Promise<T> {
      let lastErr: unknown;
      for (let i = 0; i < providers.length; i++) {
        try { return await fn(next()); } catch (err) { lastErr = err; }
      }
      throw lastErr;
    },
  };
}

// Derive the escrow signer + address from ESCROW_PRIVATE_KEY, and the token
// address from FIGHT10_TOKEN. Throws Error(<reason>) when either is missing or
// malformed. The private key never leaves this module.
export function loadEscrowConfig(): { escrowWallet: Wallet; escrowAddr: string; tokenAddr: string } {
  const escrowKey = (Deno.env.get("ESCROW_PRIVATE_KEY") ?? "").trim();
  const tokenAddr = normAddr(Deno.env.get("FIGHT10_TOKEN"));
  if (!escrowKey || !isAddress(tokenAddr)) {
    throw new Error("Escrow configuration missing (ESCROW_PRIVATE_KEY / FIGHT10_TOKEN)");
  }
  const escrowWallet = new Wallet(escrowKey.startsWith("0x") ? escrowKey : "0x" + escrowKey);
  return { escrowWallet, escrowAddr: escrowWallet.address.toLowerCase(), tokenAddr };
}

// Read the escrow's PUBLIC address for health probes — never the key itself.
export function escrowPublicAddress(): string | null {
  const escrowKey = (Deno.env.get("ESCROW_PRIVATE_KEY") ?? "").trim();
  if (!escrowKey) return null;
  try {
    return new Wallet(escrowKey.startsWith("0x") ? escrowKey : "0x" + escrowKey).address.toLowerCase();
  } catch (_) { return null; }
}

// Resolve token decimals and the fee/share tunables into raw amounts. Falls
// back to the historical literals if pvp_config is unreadable so a DB blip
// never strands a payout (the pvp_config_guard trigger blocks fee changes while
// matches are live, so the live fee always matches what players deposited).
export async function resolveEconomics(admin: any, rpc: ReturnType<typeof createRpcPool>, tokenAddr: string) {
  const decimals = Number(await rpc.run((p) => new Contract(tokenAddr, ERC20_ABI, p).decimals()));
  const { data: cfg } = await admin
    .from("pvp_config").select("entry_fee_tokens, winner_share_bps").maybeSingle();
  const entryFeeTokens = Number(cfg?.entry_fee_tokens) > 0 ? Number(cfg.entry_fee_tokens) : 2500;
  const winnerShareBps = Number(cfg?.winner_share_bps) > 0 ? Number(cfg.winner_share_bps) : 9000;
  const entryFeeRaw = BigInt(entryFeeTokens) * BigInt(10) ** BigInt(decimals);
  return { decimals, entryFeeTokens, winnerShareBps, entryFeeRaw };
}

// Verify every player's recorded deposit tx is mined, succeeded, and paid the
// exact entry fee from THEIR recorded deposit wallet to escrow. Throws on the
// first failure. `players` rows carry { user_id, deposit_tx, deposit_wallet }.
export async function verifyDeposits(
  rpc: ReturnType<typeof createRpcPool>, tokenAddr: string, escrowAddr: string,
  players: any[], entryFeeRaw: bigint,
): Promise<void> {
  const walletByUser = new Map<string, string>(players.map((p) => [p.user_id, normAddr(p.deposit_wallet)]));
  const depositTxs = players.map((p) => p.deposit_tx as string);
  const receipts = await Promise.all(depositTxs.map((tx) => rpc.run((p) => p.getTransactionReceipt(tx))));
  for (let i = 0; i < depositTxs.length; i++) {
    const receipt = receipts[i];
    if (!receipt) throw new Error(`Deposit ${i + 1} not found on-chain`);
    if (receipt.status !== 1) throw new Error(`Deposit ${i + 1} failed on-chain`);
    const expectedSender = walletByUser.get(players[i].user_id) ?? "";
    if (!isAddress(expectedSender)) throw new Error(`Deposit ${i + 1}: depositing wallet was not recorded at join time`);
    if (!receiptHasDeposit(receipt, tokenAddr, expectedSender, escrowAddr, entryFeeRaw)) {
      throw new Error(`Deposit ${i + 1} does not contain a valid FIGHT10 transfer from the player to escrow`);
    }
  }
}

// THE single escrow-signing path. Broadcasts one ERC-20 transfer from escrow,
// polls one leased provider for confirmation up to timeoutMs, and throws on
// revert/timeout. Returns the tx hash. `payoutConfirmedRef` (if provided) is set
// to true the moment the tx is confirmed, so callers can decide whether a later
// failure is safe to roll back (unconfirmed) or must be resolved manually
// (confirmed but the DB write failed).
export async function sendEscrowConfirmedTransfer(
  rpc: ReturnType<typeof createRpcPool>, escrowWallet: Wallet, tokenAddr: string,
  to: string, amountRaw: bigint, timeoutMs = 90000, payoutConfirmedRef?: { value: boolean },
): Promise<string> {
  const payProvider = rpc.lease();
  const signer = escrowWallet.connect(payProvider);
  const token = new Contract(tokenAddr, ERC20_ABI, signer);
  const sentTx = await token.transfer(to, amountRaw);
  const payoutSig: string = sentTx.hash;

  const deadline = Date.now() + timeoutMs;
  let confirmed = false;
  while (Date.now() < deadline) {
    const receipt = await payProvider.getTransactionReceipt(payoutSig).catch(() => null);
    if (receipt) {
      if (receipt.status !== 1) throw new Error("Payout tx reverted on-chain: " + payoutSig);
      confirmed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!confirmed) throw new Error(`Payout tx not confirmed after ${Math.round(timeoutMs / 1000)}s — hash: ${payoutSig}`);
  if (payoutConfirmedRef) payoutConfirmedRef.value = true;
  return payoutSig;
}

// Confirm that an out-of-band tx hash really is an escrow→winner transfer of at
// least `minAmountRaw` of our token. Used by the admin "mark payout resolved"
// path so an operator can't record an arbitrary string as a payout. Throws on
// any mismatch.
export async function verifyEscrowPayout(
  rpc: ReturnType<typeof createRpcPool>, tokenAddr: string, txHash: string,
  escrowAddr: string, winnerAddr: string, minAmountRaw: bigint,
): Promise<{ amountRaw: bigint }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("payout_tx is not a valid transaction hash");
  const receipt = await rpc.run((p) => p.getTransactionReceipt(txHash));
  if (!receipt) throw new Error("Transaction not found on-chain");
  if (receipt.status !== 1) throw new Error("Transaction failed on-chain");
  const transfer = (receipt.logs ?? []).find((log: any) =>
    (log.address ?? "").toLowerCase() === tokenAddr &&
    (log.topics?.[0] ?? "") === TRANSFER_TOPIC &&
    topicToAddr(log.topics?.[1]) === escrowAddr &&
    topicToAddr(log.topics?.[2]) === winnerAddr
  );
  if (!transfer) throw new Error("Transaction is not a FIGHT10 transfer from escrow to the winner");
  const amountRaw = BigInt(transfer.data ?? "0x0");
  if (amountRaw < minAmountRaw) {
    throw new Error(`Transfer amount ${amountRaw} is below the expected payout ${minAmountRaw}`);
  }
  return { amountRaw };
}

// Full admin payout: pay the recorded winner of a finished match from escrow.
// `admin` MUST be a service-role client. Reserves the slot, re-verifies every
// deposit, signs+confirms the transfer, and records the tx ONLY after on-chain
// confirmation — mirrors f10treasurer's guarantees so a failed send never
// strands the slot as 'pending'. Throws Error(<reason>) on any failure.
export async function payoutWinner(admin: any, matchId: string) {
  const { data: matchRow, error: matchErr } = await admin
    .from("matches").select("id, status, winner_user_id, payout_tx").eq("id", matchId).maybeSingle();
  if (matchErr || !matchRow) throw new Error("Match not found");
  if (matchRow.status !== "finished") throw new Error(`Match is '${matchRow.status}', not finished`);
  if (!matchRow.winner_user_id) throw new Error("Match has no winner");
  if (matchRow.payout_tx && matchRow.payout_tx !== "pending") throw new Error(`Already paid (${matchRow.payout_tx})`);
  const winnerId = matchRow.winner_user_id as string;

  const { data: players, error: playersErr } = await admin
    .from("match_players").select("user_id, deposit_tx, deposit_wallet").eq("match_id", matchId);
  if (playersErr || !players || players.length === 0) throw new Error("Could not fetch match players");
  const missing = players.filter((p: any) => !p.deposit_tx);
  if (missing.length > 0) throw new Error(`${missing.length} player(s) have no recorded deposit`);

  const { data: profile } = await admin
    .from("profiles").select("wallet_address").eq("user_id", winnerId).maybeSingle();
  if (!profile?.wallet_address) throw new Error("Winner wallet address not found");

  const { escrowWallet, escrowAddr, tokenAddr } = loadEscrowConfig();
  const winnerAddr = normAddr(profile.wallet_address);
  if (!isAddress(winnerAddr)) throw new Error("Winner wallet address invalid");
  const rpc = createRpcPool();

  const { decimals, winnerShareBps, entryFeeRaw } = await resolveEconomics(admin, rpc, tokenAddr);
  await verifyDeposits(rpc, tokenAddr, escrowAddr, players, entryFeeRaw);

  // Reserve the slot atomically (service role). Claim only when unpaid or a
  // prior 'pending' reservation is >10 min stale. 0 rows ⇒ someone else holds
  // it / already paid.
  const staleCutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: reserved, error: reserveErr } = await admin
    .from("matches")
    .update({ payout_tx: "pending", payout_claimed_at: new Date().toISOString() })
    .eq("id", matchId).eq("status", "finished").eq("winner_user_id", winnerId)
    .or(`payout_tx.is.null,and(payout_tx.eq.pending,payout_claimed_at.lt.${staleCutoff})`)
    .select("id");
  if (reserveErr) throw new Error("Could not reserve payout slot");
  if (!reserved || reserved.length === 0) throw new Error("Payout already in progress or completed");

  const payoutConfirmed = { value: false };
  try {
    const totalRaw = BigInt(players.length) * entryFeeRaw;
    const winnerAmountRaw = (totalRaw * BigInt(winnerShareBps)) / BigInt(10000);

    const payoutSig = await sendEscrowConfirmedTransfer(
      rpc, escrowWallet, tokenAddr, winnerAddr, winnerAmountRaw, 90000, payoutConfirmed,
    );

    let dbWritten = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
      const { error: writeErr } = await admin.from("matches").update({ payout_tx: payoutSig }).eq("id", matchId);
      if (!writeErr) { dbWritten = true; break; }
      console.error(`[payout] DB write attempt ${attempt + 1} failed:`, writeErr);
    }
    if (!dbWritten) {
      console.error(`[payout] CRITICAL: tx ${payoutSig} confirmed but DB update failed for match ${matchId}. Manual resolution required.`);
      throw new Error(`Payout sent on-chain (${payoutSig}) but internal record failed. Set payout_tx manually.`);
    }

    const { error: ledgerErr } = await admin.from("payouts").upsert({
      match_id: matchId, winner_user_id: winnerId, payout_tx: payoutSig,
      amount_raw: winnerAmountRaw.toString(), decimals, num_players: players.length,
    }, { onConflict: "match_id" });
    if (ledgerErr) console.error("[payout] payouts insert failed (non-fatal):", ledgerErr);

    console.log(`[payout] paid match=${matchId} tx=${payoutSig} amount=${winnerAmountRaw.toString()} players=${players.length}`);
    return { payout_tx: payoutSig, winner_amount: winnerAmountRaw.toString(), num_players: players.length, decimals };
  } catch (err) {
    // Only release the slot if the tx never confirmed — releasing after a
    // confirmed transfer would allow a second payout.
    if (!payoutConfirmed.value) {
      try {
        await admin.from("matches").update({ payout_tx: null, payout_claimed_at: null })
          .eq("id", matchId).eq("payout_tx", "pending");
      } catch (_) { /* best-effort */ }
    }
    throw err;
  }
}
