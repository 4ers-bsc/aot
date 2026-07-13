
/// Payout Edge Function — winner self-claim.
// Required Supabase secrets: ESCROW_PRIVATE_KEY (0x-prefixed hex), FIGHT10_TOKEN
// (ERC-20 contract 0x address), and optionally RPC_URL(_2, _3).
//
// Chain: Robinhood Chain (an Ethereum L2), mainnet only.
//
// All escrow signing + deposit verification lives in ../_shared/payout.ts — the
// single source of truth shared with f10admin. This function only orchestrates
// the winner-JWT slot reservation (claim_payout_slot) around it.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  createRpcPool, escrowPublicAddress, getRpcUrls, loadEscrowConfig, normAddr,
  resolveEconomics, sendEscrowConfirmedTransfer, verifyDeposits,
} from "../_shared/payout.ts";

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

  // Unauthenticated health probe (…/f10treasurer?health=1). Reports only
  // booleans / the escrow's PUBLIC address — the private key is never exposed.
  if (new URL(req.url).searchParams.has("health")) {
    return new Response(JSON.stringify({
      ok: true,
      service: "f10treasurer",
      time: new Date().toISOString(),
      config: {
        escrow_key_set: !!(Deno.env.get("ESCROW_PRIVATE_KEY") ?? "").trim(),
        escrow_wallet:  escrowPublicAddress(),
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
  const payoutConfirmed = { value: false }; // set true once the on-chain tx confirms

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

    // ── Fetch winner wallet ──────────────────────────────────────────────────
    const { data: profile } = await adminClient
      .from("profiles").select("wallet_address").eq("user_id", user.id).maybeSingle();
    if (!profile?.wallet_address) return errorResponse("Winner wallet address not found", 400);

    // ── Escrow / token config + economics (shared) ──────────────────────────
    let escrowWallet, escrowAddr, tokenAddr;
    try {
      ({ escrowWallet, escrowAddr, tokenAddr } = loadEscrowConfig());
    } catch (_) {
      return errorResponse("Escrow configuration missing", 500);
    }
    const winnerAddr = normAddr(profile.wallet_address);
    if (!/^0x[0-9a-f]{40}$/.test(winnerAddr)) return errorResponse("Winner wallet address invalid", 400);

    const rpc = createRpcPool();
    const { decimals, winnerShareBps, entryFeeRaw } = await resolveEconomics(adminClient, rpc, tokenAddr);

    // ── Verify each deposit tx is mined, succeeded, and paid escrow (shared) ──
    try {
      await verifyDeposits(rpc, tokenAddr, escrowAddr, players, entryFeeRaw);
    } catch (err) {
      return errorResponse(String(err?.message ?? err), 400, matchId);
    }

    // ── Atomically reserve the payout slot ───────────────────────────────────
    // Uses claim_payout_slot() (UPDATE … WHERE payout_tx IS NULL / stale), so
    // only one concurrent request can proceed to send a transaction. We use the
    // user's JWT here (userClient) so the RPC's auth.uid() check passes.
    const { data: slotOk, error: slotErr } = await userClient.rpc("claim_payout_slot", { p_match_id: matchId });
    if (slotErr) return errorResponse("Could not reserve payout slot", 500);
    if (!slotOk) return errorResponse("Prize already claimed", 409);
    slotClaimed = true;

    // ── On-chain token transfer (shared, single signing path) ────────────────
    const totalRaw        = BigInt(players.length) * entryFeeRaw;
    const winnerAmountRaw = (totalRaw * BigInt(winnerShareBps)) / BigInt(10000);
    const payoutSig = await sendEscrowConfirmedTransfer(
      rpc, escrowWallet, tokenAddr, winnerAddr, winnerAmountRaw, 90000, payoutConfirmed,
    );

    // Fix 4: tx is confirmed (payoutConfirmed.value === true). Retry the DB
    // write up to 5 times so a transient DB failure does not clear the payout
    // slot and risk a second transfer on winner retry.
    let dbWritten = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
      const { error: writeErr } = await adminClient
        .from("matches").update({ payout_tx: payoutSig }).eq("id", matchId);
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

    // Record a durable payout row (audit trail + explorer link). Best-effort and
    // idempotent — matches.payout_tx remains the source of truth.
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
    // If payoutConfirmed.value=true, the transfer already landed — releasing the
    // slot would allow a retry that sends a second transfer (double-pay). In that
    // case the slot stays 'pending' and requires manual admin resolution.
    if (slotClaimed && !payoutConfirmed.value && matchId) {
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
