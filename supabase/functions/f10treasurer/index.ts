
/// Payout Edge Function
// Required Supabase secrets: ESCROW_PRIVATE_KEY (0x-prefixed hex), FIGHT10_TOKEN
// (ERC-20 contract 0x address), and optionally RPC_URL(_2, _3).
//
// Chain: Robinhood Chain (an Ethereum L2). The app runs on mainnet only — the
// network is defined below and matches the client's src/network.js.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Contract, JsonRpcProvider, Wallet } from "npm:ethers@6.13.0";

// ---------------------------------------------------------------------------
// Robinhood Chain network (mainnet). Kept in sync with src/network.js on the
// client.
// ---------------------------------------------------------------------------
const NETWORK: { name: string; chainId: number; rpcUrl: string } = {
  name: "Robinhood Chain",
  chainId: 4663,
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
};

// keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer event.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

// ---------------------------------------------------------------------------
// Address / hex helpers
// ---------------------------------------------------------------------------
// Ethereum addresses are case-insensitive (EIP-55 checksums just vary the
// case), and stored wallet_address values may carry a "chain:" prefix
// (e.g. "ethereum:0x…") — normalise to the lowercased trailing segment.
const normAddr = (w?: string | null) =>
  ((w ?? "").trim().split(":").pop() ?? "").trim().toLowerCase();
const isAddress = (a: string) => /^0x[0-9a-f]{40}$/.test(a);
// An indexed address event topic is the address left-padded to 32 bytes.
const topicToAddr = (t?: string) => (t ? "0x" + t.slice(-40).toLowerCase() : "");

// Does this receipt contain the exact entry-fee Transfer from the player's
// wallet to escrow, emitted by OUR token contract? Shared shape with f10join —
// edit both together if the deposit format changes.
function receiptHasDeposit(receipt: any, tokenAddr: string, sender: string, escrow: string, amount: bigint): boolean {
  return (receipt?.logs ?? []).some((log: any) =>
    (log.address ?? "").toLowerCase() === tokenAddr &&
    (log.topics?.[0] ?? "") === TRANSFER_TOPIC &&
    topicToAddr(log.topics?.[1]) === sender &&
    topicToAddr(log.topics?.[2]) === escrow &&
    BigInt(log.data ?? "0x0") === amount
  );
}

// ---------------------------------------------------------------------------
// RPC endpoint pool — spread load across up to 3 keys (RPC_URL, RPC_URL_2,
// RPC_URL_3; the network's public RPC as fallback). Each call grabs the next
// endpoint round-robin (so parallel deposit lookups hit different keys); on
// error (e.g. a 429 rate limit) the call rotates to the next key instead of
// failing. Random start keeps load balanced across function instances.
// `lease()` returns one sticky provider for the payout send + confirm poll, so
// the tx is broadcast and polled on a single endpoint.
// ---------------------------------------------------------------------------
function getRpcUrls(): string[] {
  const urls = [
    Deno.env.get("RPC_URL"),
    Deno.env.get("RPC_URL_2"),
    Deno.env.get("RPC_URL_3"),
  ]
    .map((u) => u?.trim())
    .filter((u): u is string => !!u);
  const unique = [...new Set(urls)];
  return unique.length ? unique : [NETWORK.rpcUrl];
}

function createRpcPool() {
  const providers = getRpcUrls().map((u) =>
    new JsonRpcProvider(u, NETWORK.chainId, { staticNetwork: true }));
  let idx = Math.floor(Math.random() * providers.length);
  const next = () => {
    const p = providers[idx];
    idx = (idx + 1) % providers.length;
    return p;
  };
  return {
    lease: () => next(),
    async run<T>(fn: (p: JsonRpcProvider) => Promise<T>): Promise<T> {
      let lastErr: unknown;
      for (let i = 0; i < providers.length; i++) {
        try {
          return await fn(next());
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr;
    },
  };
}

// ---------------------------------------------------------------------------

// Fix 8: warn loudly if APP_ORIGIN is unset — open CORS in production is a misconfiguration.
const appOrigin = Deno.env.get("APP_ORIGIN");
if (!appOrigin) console.error("WARNING: APP_ORIGIN secret not set — CORS is open to all origins. Set it in Supabase secrets for production.");
const corsHeaders = {
  "Access-Control-Allow-Origin": appOrigin || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function errorResponse(message: string, status: number, matchId = ""): Response {
  // Log every rejection with its reason (and match, when known) so a stuck /
  // failing payout is diagnosable straight from the function logs instead of
  // showing up client-side as a generic non-2xx.
  console.error(`[f10treasurer] reject status=${status} match=${matchId || "?"} reason=${message}`);
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Unauthenticated health probe (…/f10treasurer?health=1). Used by the ops
  // dashboard's "Edge functions" tab to check reachability + report whether the
  // payout config is wired up. Reports only booleans / the escrow's PUBLIC
  // address (derived from the key) — the private key itself is never exposed.
  if (new URL(req.url).searchParams.has("health")) {
    let escrowAddr: string | null = null;
    const escrowKey = (Deno.env.get("ESCROW_PRIVATE_KEY") ?? "").trim();
    if (escrowKey) {
      try {
        escrowAddr = new Wallet(escrowKey.startsWith("0x") ? escrowKey : "0x" + escrowKey)
          .address.toLowerCase();
      } catch (_) { /* malformed key — report as configured-but-invalid below */ }
    }
    return new Response(JSON.stringify({
      ok: true,
      service: "f10treasurer",
      time: new Date().toISOString(),
      config: {
        escrow_key_set: !!escrowKey,
        escrow_wallet:  escrowAddr,
        token:          normAddr(Deno.env.get("FIGHT10_TOKEN")) || null,
        rpc_endpoints:  getRpcUrls().length,
        app_origin_set: !!appOrigin,
      },
    }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
  }

  const supabaseUrl      = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey  = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  let matchId = "";
  let slotClaimed = false;   // tracks whether we set payout_tx = 'pending'
  let payoutConfirmed = false; // tracks whether the on-chain tx was confirmed

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return errorResponse("Missing Authorization header", 401);

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return errorResponse("Unauthorized", 401);

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    const body = await req.json();
    matchId = body?.match_id;
    if (!matchId) return errorResponse("match_id is required", 400);
    console.log(`[f10treasurer] claim start match=${matchId} user=${user.id}`);

    // ── Validate match state ─────────────────────────────────────────────────
    const { data: matchRow, error: matchErr } = await adminClient
      .from("matches").select("id, status, winner_user_id, payout_tx").eq("id", matchId).maybeSingle();
    if (matchErr || !matchRow) return errorResponse("Match not found", 404);
    if (matchRow.status !== "finished") return errorResponse("Match is not finished", 400);
    if (matchRow.winner_user_id !== user.id) return errorResponse("Only the winner may claim", 403);
    // Allow stale 'pending' reservations to fall through; claim_payout_slot
    // will auto-release them if >10 minutes old (Fix 4).
    if (matchRow.payout_tx && matchRow.payout_tx !== "pending") return errorResponse("Prize already claimed", 409);

    // ── Verify all deposits exist ────────────────────────────────────────────
    const { data: players, error: playersErr } = await adminClient
      .from("match_players").select("user_id, deposit_tx, deposit_wallet").eq("match_id", matchId);
    if (playersErr || !players) return errorResponse("Could not fetch match players", 500);
    const missing = players.filter((p: any) => !p.deposit_tx);
    if (missing.length > 0) return errorResponse(`${missing.length} player(s) have not deposited`, 400);

    // ── Resolve each player's *deposit* wallet so we can verify the sender ─────
    // We use deposit_wallet (the wallet that signed the on-chain deposit, recorded
    // by join_pvp_match) rather than the login wallet, because a player may deposit
    // from a different connected wallet than the one they authenticated with.
    // The Transfer event's `from` must match this so a confirmed transfer that
    // someone else funded cannot pass verification.
    const walletByUser = new Map<string, string>(
      players.map((p: any) => [p.user_id, normAddr(p.deposit_wallet)]),
    );

    // ── Fetch winner wallet ──────────────────────────────────────────────────
    const { data: profile } = await adminClient
      .from("profiles").select("wallet_address").eq("user_id", user.id).maybeSingle();
    if (!profile?.wallet_address) return errorResponse("Winner wallet address not found", 400);

    // ── Escrow / token config ────────────────────────────────────────────────
    const escrowKey = (Deno.env.get("ESCROW_PRIVATE_KEY") ?? "").trim();
    const tokenAddr = normAddr(Deno.env.get("FIGHT10_TOKEN"));
    if (!escrowKey || !isAddress(tokenAddr)) return errorResponse("Escrow configuration missing", 500);

    const rpc = createRpcPool();
    const escrowWallet = new Wallet(escrowKey.startsWith("0x") ? escrowKey : "0x" + escrowKey);
    const escrowAddr = escrowWallet.address.toLowerCase();
    const winnerAddr = normAddr(profile.wallet_address);
    if (!isAddress(winnerAddr)) return errorResponse("Winner wallet address invalid", 400);

    // ── Resolve token decimals → exact entry-fee amount ─────────────────────
    // Done early so the same values are reused for both deposit verification
    // and the payout transfer.
    const decimals = Number(await rpc.run((p) =>
      new Contract(tokenAddr, ERC20_ABI, p).decimals()));
    // Entry fee + winner share are tunables in pvp_config (single source of
    // truth shared with the client + f10join/f10admin). Fall back to the
    // historical literals if the row is unreadable so a DB blip never strands a
    // payout. The pvp_config_guard trigger blocks fee changes while matches are
    // live, so the fee here always matches what the player deposited.
    const { data: cfg } = await adminClient
      .from("pvp_config").select("entry_fee_tokens, winner_share_bps").maybeSingle();
    const entryFeeTokens = Number(cfg?.entry_fee_tokens) > 0 ? Number(cfg.entry_fee_tokens) : 2500;
    const winnerShareBps = Number(cfg?.winner_share_bps) > 0 ? Number(cfg.winner_share_bps) : 9000;
    const entryFeeRaw = BigInt(entryFeeTokens) * BigInt(10) ** BigInt(decimals);

    // ── Verify each deposit tx is mined, succeeded, and paid escrow ──────────
    // Receipts are queryable for the chain's full history (no status-cache
    // window like Solana's), and the Transfer log proves token contract,
    // sender, destination, and exact amount — a confirmed-but-unrelated tx
    // hash cannot pass. All fetches run in parallel to minimise latency.
    const depositTxs = players.map((p: any) => p.deposit_tx as string);
    const receipts = await Promise.all(
      depositTxs.map((tx) => rpc.run((p) => p.getTransactionReceipt(tx)))
    );

    for (let i = 0; i < depositTxs.length; i++) {
      const receipt = receipts[i];
      if (!receipt) return errorResponse(`Deposit ${i + 1} not found on-chain`, 400);
      if (receipt.status !== 1) return errorResponse(`Deposit ${i + 1} failed on-chain`, 400);

      const expectedSender = walletByUser.get(players[i].user_id) ?? "";
      if (!isAddress(expectedSender)) return errorResponse(`Deposit ${i + 1}: depositing wallet was not recorded at join time`, 400);

      if (!receiptHasDeposit(receipt, tokenAddr, expectedSender, escrowAddr, entryFeeRaw)) {
        // Log expected vs observed transfers so failures can be diagnosed from
        // the function logs without leaking detail into the client response.
        const seen = (receipt.logs ?? [])
          .filter((l: any) => (l.address ?? "").toLowerCase() === tokenAddr && l.topics?.[0] === TRANSFER_TOPIC)
          .map((l: any) => ({
            from: topicToAddr(l.topics?.[1]),
            to: topicToAddr(l.topics?.[2]),
            amount: BigInt(l.data ?? "0x0").toString(),
          }));
        console.error(`Deposit ${i + 1} verification failed`, JSON.stringify({
          expectedSender, escrowAddr, tokenAddr, entryFee: entryFeeRaw.toString(), seen,
        }));
        return errorResponse(
          `Deposit ${i + 1} does not contain a valid FIGHT10 transfer from the player to escrow`,
          400,
        );
      }
    }

    // ── Atomically reserve the payout slot ───────────────────────────────────
    // Uses claim_payout_slot() which does UPDATE … WHERE payout_tx IS NULL,
    // so only one concurrent request can proceed to send a transaction.
    // We use the user's JWT here (userClient) so the RPC's auth.uid() check passes.
    const { data: slotOk, error: slotErr } = await userClient.rpc("claim_payout_slot", { p_match_id: matchId });
    if (slotErr) return errorResponse("Could not reserve payout slot", 500);
    if (!slotOk) return errorResponse("Prize already claimed", 409);
    slotClaimed = true;

    // ── On-chain token transfer ───────────────────────────────────────────────
    const totalRaw        = BigInt(players.length) * entryFeeRaw;
    const winnerAmountRaw = (totalRaw * BigInt(winnerShareBps)) / BigInt(10000);

    // Lease one provider for the whole send + confirm sequence so the tx is
    // broadcast and polled on a single endpoint (round-robin across the keys).
    const payProvider = rpc.lease();
    const signer = escrowWallet.connect(payProvider);
    const token = new Contract(tokenAddr, ERC20_ABI, signer);
    const sentTx = await token.transfer(winnerAddr, winnerAmountRaw);
    const payoutSig: string = sentTx.hash;

    // Fix 2 (partial): Poll for on-chain confirmation; throw explicitly on timeout
    // so the catch block correctly releases the slot (tx never landed).
    const deadline = Date.now() + 90000;
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
    if (!confirmed) throw new Error(`Payout tx not confirmed after 90s — hash: ${payoutSig}`);

    // Fix 4: Mark tx as confirmed before writing to DB. Retry the DB write up to 5 times
    // so a transient DB failure after a confirmed on-chain tx does not clear the payout
    // slot and risk a second transfer on winner retry.
    payoutConfirmed = true;
    let dbWritten = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
      const { error: writeErr } = await adminClient
        .from("matches")
        .update({ payout_tx: payoutSig })
        .eq("id", matchId);
      if (!writeErr) { dbWritten = true; break; }
      console.error(`DB write attempt ${attempt + 1} failed:`, writeErr);
    }

    if (!dbWritten) {
      // Tx confirmed on-chain but DB record could not be updated after 5 attempts.
      // Leave payout_tx = 'pending' so the slot is NOT released — prevents a retry
      // from sending a second transfer. Admin must manually set payout_tx = payoutSig.
      console.error(`CRITICAL: payout tx ${payoutSig} confirmed on-chain but DB update failed for match ${matchId}. Manual resolution required.`);
      slotClaimed = false; // prevent catch from clearing the slot
      return errorResponse(
        `Payout sent on-chain (${payoutSig}) but internal record failed. Contact support with this transaction ID.`,
        500,
      );
    }

    slotClaimed = false; // slot replaced with real hash — no rollback needed

    // Record a durable payout row (audit trail + the explorer link the client
    // shows in the victory screen and match history). Best-effort and idempotent
    // (upsert on match_id) — matches.payout_tx remains the source of truth, so a
    // failure here must not fail an already-confirmed payout.
    // supabase-js reports failures via the returned error, not by throwing —
    // check it explicitly or a failed ledger write vanishes without a trace.
    const { error: ledgerErr } = await adminClient.from("payouts").upsert({
      match_id: matchId,
      winner_user_id: user.id,
      payout_tx: payoutSig,
      amount_raw: winnerAmountRaw.toString(),
      decimals,
      num_players: players.length,
    }, { onConflict: "match_id" });
    if (ledgerErr) console.error("payouts insert failed (non-fatal):", ledgerErr);

    console.log(`[f10treasurer] paid match=${matchId} tx=${payoutSig} amount=${winnerAmountRaw.toString()} players=${players.length}`);
    return new Response(
      JSON.stringify({ ok: true, payout_tx: payoutSig, winner_amount: winnerAmountRaw.toString(), num_players: players.length, decimals }),
      { headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  } catch (err) {
    console.error("Payout error:", err);

    // Fix 4: Only release the payout slot if the on-chain tx was NOT confirmed.
    // If payoutConfirmed=true, the transfer already landed — releasing the slot
    // would allow a retry that sends a second transfer (double-pay).
    // In that case the slot stays 'pending' and requires manual admin resolution.
    if (slotClaimed && !payoutConfirmed && matchId) {
      try {
        const adminClient = createClient(supabaseUrl, supabaseServiceKey);
        await adminClient.from("matches")
          .update({ payout_tx: null, payout_claimed_at: null })
          .eq("id", matchId)
          .eq("payout_tx", "pending");
      } catch (_) { /* best-effort */ }
    }

    return errorResponse(String(err), 500);
  }
});
