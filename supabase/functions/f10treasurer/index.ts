
/// Payout Edge Function
// Required Supabase secrets: ESCROW_PRIVATE_KEY (base58 secret key OR a JSON
// byte array), FIGHT10_TOKEN (SPL mint, base58), and optionally RPC_URL(_2, _3).
//
// Chain: Solana (mainnet-beta). The network is defined below and matches the
// client's src/network.js.
//
// The escrow must hold a small amount of SOL to pay transaction fees and the
// one-time rent when a winner's token account has to be created.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "npm:@solana/web3.js@1.95.4";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "npm:@solana/spl-token@0.4.9";
import bs58 from "npm:bs58@5.0.0";

// ---------------------------------------------------------------------------
// Solana network (mainnet-beta). Kept in sync with src/network.js on the
// client. `chainId` is a small cluster sentinel (Metaplex convention:
// mainnet-beta = 101) used only for the match economic-identity snapshot.
// ---------------------------------------------------------------------------
const NETWORK: { name: string; chainId: number; cluster: string; rpcUrl: string } = {
  name: "Solana",
  chainId: 101,
  cluster: "mainnet-beta",
  rpcUrl: "https://api.mainnet-beta.solana.com",
};

// ---------------------------------------------------------------------------
// Address helpers. Solana addresses/signatures are base58 and CASE-SENSITIVE —
// never lowercase them. Stored wallet_address values may carry a CAIP "solana:"
// prefix; strip only that leading segment.
// ---------------------------------------------------------------------------
const normAddr = (w?: string | null) =>
  ((w ?? "").trim().split(":").pop() ?? "").trim();
const BASE58 = "[1-9A-HJ-NP-Za-km-z]";
const isAddress = (a: string) => new RegExp(`^${BASE58}{32,44}$`).test(a);

// Load the escrow keypair from either a base58 secret key or a JSON byte array.
function loadEscrowKeypair(raw: string): Keypair {
  const s = raw.trim();
  if (s.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));
  }
  return Keypair.fromSecretKey(bs58.decode(s));
}

// ---------------------------------------------------------------------------
// SPL transfer verification via token-balance deltas (mirrors f10join). A valid
// deposit is: escrow's holding of FIGHT10 went UP by exactly the entry fee AND
// the sender's holding went DOWN by exactly the entry fee — proving mint, from,
// to, and amount together. Shared shape with f10join — edit both together if
// the deposit format changes.
// ---------------------------------------------------------------------------
type TokenBalance = { mint?: string; owner?: string; uiTokenAmount?: { amount?: string } };
function ownerMintDelta(meta: any, owner: string, mint: string): bigint {
  const sumFor = (list: TokenBalance[] | undefined) =>
    (list ?? []).reduce((acc, b) =>
      (b.owner === owner && b.mint === mint)
        ? acc + BigInt(b.uiTokenAmount?.amount ?? "0")
        : acc, 0n);
  return sumFor(meta?.postTokenBalances) - sumFor(meta?.preTokenBalances);
}
function txHasDeposit(meta: any, mint: string, sender: string, escrow: string, amount: bigint): boolean {
  return ownerMintDelta(meta, escrow, mint) === amount &&
         ownerMintDelta(meta, sender, mint) === -amount;
}

// ---------------------------------------------------------------------------
// RPC endpoint pool — spread load across up to 3 keys (RPC_URL, RPC_URL_2,
// RPC_URL_3; the cluster's public RPC as fallback). Each call grabs the next
// endpoint round-robin (so parallel deposit lookups hit different keys); on
// error (e.g. a 429 rate limit) the call rotates to the next key instead of
// failing. Random start keeps load balanced across function instances.
// `lease()` returns one sticky connection for the payout send + confirm poll, so
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
  const connections = getRpcUrls().map((u) => new Connection(u, "confirmed"));
  let idx = Math.floor(Math.random() * connections.length);
  const next = () => {
    const c = connections[idx];
    idx = (idx + 1) % connections.length;
    return c;
  };
  return {
    lease: () => next(),
    async run<T>(fn: (c: Connection) => Promise<T>): Promise<T> {
      let lastErr: unknown;
      for (let i = 0; i < connections.length; i++) {
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

// Fetch a parsed tx (token balances included) for verification / reconcile.
function getParsedTx(rpc: ReturnType<typeof createRpcPool>, sig: string) {
  return rpc.run((c) => c.getParsedTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  }));
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
        escrowAddr = loadEscrowKeypair(escrowKey).publicKey.toBase58();
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
  let broadcast = false;     // tracks whether the transfer was broadcast
  let escrowLocked = false;  // tracks whether we hold the global escrow lock
  let escrowLockHolder = ""; // our unique holder token for that lock

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
      .from("matches")
      .select("id, status, winner_user_id, payout_tx, payout_blockhash, entry_fee_tokens, winner_share_bps, token_address, chain_id, escrow_wallet")
      .eq("id", matchId).maybeSingle();
    if (matchErr || !matchRow) return errorResponse("Match not found", 404);
    if (matchRow.status !== "finished") return errorResponse("Match is not finished", 400);
    if (matchRow.winner_user_id !== user.id) return errorResponse("Only the winner may claim", 403);
    // A real recorded signature (anything other than null / the 'pending'
    // reservation) is reconciled against the chain further down — never blindly
    // rejected as "already claimed" and never blindly re-sent. Stale 'pending'
    // reservations fall through to claim_payout_slot, which auto-releases them if
    // >10 min old; with signature+blockhash persisted BEFORE broadcast, a
    // 'pending' row is one that never signed a transfer, so releasing it can't
    // strand an on-chain payout.

    // ── Verify all deposits exist ────────────────────────────────────────────
    const { data: players, error: playersErr } = await adminClient
      .from("match_players").select("user_id, deposit_tx, deposit_wallet, deposit_verified").eq("match_id", matchId);
    if (playersErr || !players) return errorResponse("Could not fetch match players", 500);
    const missing = players.filter((p: any) => !p.deposit_tx);
    if (missing.length > 0) return errorResponse(`${missing.length} player(s) have not deposited`, 400);

    // ── Resolve each player's *deposit* wallet so we can verify the sender ─────
    // We use deposit_wallet (the wallet that signed the on-chain deposit, recorded
    // by join_pvp_match) rather than the login wallet, because a player may deposit
    // from a different connected wallet than the one they authenticated with.
    // The transfer's sender must match this so a confirmed transfer that someone
    // else funded cannot pass verification.
    const walletByUser = new Map<string, string>(
      players.map((p: any) => [p.user_id, normAddr(p.deposit_wallet)]),
    );

    // ── Resolve the winner's PAYOUT wallet from the entry snapshot ────────────
    // Pay to the wallet the winner deposited from (recorded on their seat at join
    // time and enforced == their login wallet then), NOT the live profile
    // wallet_address. profiles.wallet_address is mutable, so reading it here would
    // let a winner (or an account takeover) repoint the prize after the match by
    // editing their profile. deposit_wallet is a per-match snapshot that never
    // changes once the seat is taken (P1: snapshot payout wallet at match entry).
    // Fall back to the login profile only for legacy rows with no snapshot.
    let winnerAddr = walletByUser.get(user.id) ?? "";
    if (!isAddress(winnerAddr)) {
      const { data: profile } = await adminClient
        .from("profiles").select("wallet_address").eq("user_id", user.id).maybeSingle();
      winnerAddr = normAddr(profile?.wallet_address);
    }
    if (!isAddress(winnerAddr)) return errorResponse("Winner payout wallet not found", 400);

    // ── Escrow / token config ────────────────────────────────────────────────
    const escrowKey = (Deno.env.get("ESCROW_PRIVATE_KEY") ?? "").trim();
    const tokenAddr = normAddr(Deno.env.get("FIGHT10_TOKEN"));
    if (!escrowKey || !isAddress(tokenAddr)) return errorResponse("Escrow configuration missing", 500);

    const rpc = createRpcPool();
    let escrowKeypair: Keypair;
    try { escrowKeypair = loadEscrowKeypair(escrowKey); }
    catch { return errorResponse("Escrow key is malformed", 500); }
    const escrowAddr = escrowKeypair.publicKey.toBase58();

    const mint         = new PublicKey(tokenAddr);
    const escrowPubkey = escrowKeypair.publicKey;
    const escrowAta    = getAssociatedTokenAddressSync(mint, escrowPubkey);

    // ── Enforce the frozen economic contract (P1) ────────────────────────────
    // The match snapshotted the token mint, cluster, and escrow wallet that
    // applied when players deposited (join_pvp_match). If the live config has
    // since drifted — a token/escrow change, a cluster change — refuse to pay:
    // the deposits were made against a DIFFERENT contract. Only enforced when a
    // snapshot exists (matches created before the columns keep the old behaviour).
    const snapToken  = normAddr(matchRow.token_address);
    const snapEscrow = normAddr(matchRow.escrow_wallet);
    if (snapToken && snapToken !== tokenAddr) {
      return errorResponse("Token mint changed since match entry — payout blocked", 409, matchId);
    }
    if (snapEscrow && snapEscrow !== escrowAddr) {
      return errorResponse("Escrow wallet changed since match entry — payout blocked", 409, matchId);
    }
    if (matchRow.chain_id != null && Number(matchRow.chain_id) !== NETWORK.chainId) {
      return errorResponse("Cluster changed since match entry — payout blocked", 409, matchId);
    }

    // ── Resolve token decimals → exact entry-fee amount ─────────────────────
    // Done early so the same values are reused for both deposit verification
    // and the payout transfer.
    const supply = await rpc.run((c) => c.getTokenSupply(mint));
    const decimals = Number(supply.value.decimals);
    // Entry fee + winner share are frozen onto the match when it is created
    // (join_pvp_match snapshots pvp_config), so a later admin config edit can
    // never change how THIS match's deposits are verified or its prize is
    // computed (#4). Prefer that snapshot; fall back to live pvp_config for
    // matches created before the snapshot columns existed, then to the
    // historical literals so a DB blip never strands a payout.
    const { data: cfg } = await adminClient
      .from("pvp_config").select("entry_fee_tokens, winner_share_bps").maybeSingle();
    const entryFeeTokens = Number(matchRow.entry_fee_tokens) > 0 ? Number(matchRow.entry_fee_tokens)
      : Number(cfg?.entry_fee_tokens) > 0 ? Number(cfg.entry_fee_tokens) : 10000;
    const winnerShareBps = Number(matchRow.winner_share_bps) > 0 ? Number(matchRow.winner_share_bps)
      : Number(cfg?.winner_share_bps) > 0 ? Number(cfg.winner_share_bps) : 9000;
    const entryFeeRaw = BigInt(entryFeeTokens) * BigInt(10) ** BigInt(decimals);

    // ── Reconcile any already-recorded payout against the chain (P0) ─────────
    // A row can already carry a real signature if a prior attempt persisted it
    // (we write signature+blockhash BEFORE broadcasting). Decide what to do by
    // looking at the chain, NEVER by blindly clearing the slot or re-sending:
    //   • confirmed  → idempotent success (adopt the existing tx)
    //   • failed     → no tokens moved; clear the slot and fall through to resend
    //   • not found  → only resend if the recorded blockhash has EXPIRED. While
    //                  it is still valid the recorded tx may yet land, so a
    //                  re-send with a new blockhash could double-pay — refuse.
    //                  An expired blockhash can never be committed, so a resend is
    //                  safe (Solana's equivalent of "the nonce is still free").
    const recordedTx = String(matchRow.payout_tx ?? "");
    if (recordedTx && recordedTx !== "pending") {
      const totalRaw        = BigInt(players.length) * entryFeeRaw;
      const winnerAmountRaw = (totalRaw * BigInt(winnerShareBps)) / BigInt(10000);
      const parsed = await getParsedTx(rpc, recordedTx).catch(() => null);
      if (parsed && !parsed.meta?.err) {
        // Already paid. Make sure the audit row exists, then report success.
        const { error: ledgerErr } = await adminClient.from("payouts").upsert({
          match_id: matchId, winner_user_id: user.id, payout_tx: recordedTx,
          amount_raw: winnerAmountRaw.toString(), decimals, num_players: players.length,
        }, { onConflict: "match_id" });
        if (ledgerErr) console.error("payouts upsert (reconcile) failed (non-fatal):", ledgerErr);
        console.log(`[f10treasurer] reconciled match=${matchId} tx=${recordedTx} already confirmed`);
        return new Response(
          JSON.stringify({ ok: true, payout_tx: recordedTx, winner_amount: winnerAmountRaw.toString(), num_players: players.length, decimals, confirmed: true }),
          { headers: { "Content-Type": "application/json", ...corsHeaders } },
        );
      }
      if (parsed && parsed.meta?.err) {
        // Failed on-chain — no tokens moved. Clear only THIS record and resend.
        await adminClient.from("matches")
          .update({ payout_tx: null, payout_blockhash: null, payout_claimed_at: null })
          .eq("id", matchId).eq("payout_tx", recordedTx);
      } else {
        // Not found yet. Decide by whether the recorded blockhash is still valid.
        // While valid, the recorded tx may still confirm, so re-sending risks a
        // second transfer — refuse. If we can't determine the blockhash, refuse
        // too (safe default). An expired blockhash → the recorded tx can never
        // land → safe to clear and resend below.
        const recordedBlockhash = matchRow.payout_blockhash as string | null;
        const stillValid = recordedBlockhash
          ? await rpc.run((c) => c.isBlockhashValid(recordedBlockhash, { commitment: "confirmed" }))
              .then((r: any) => r?.value ?? true).catch(() => true)
          : true;
        if (stillValid) {
          return errorResponse(
            `A payout for this match is already in flight (${recordedTx}). Wait for it to confirm before retrying.`,
            409, matchId,
          );
        }
        await adminClient.from("matches")
          .update({ payout_tx: null, payout_blockhash: null, payout_claimed_at: null })
          .eq("id", matchId).eq("payout_tx", recordedTx);
      }
    }

    // ── Verify deposits ──────────────────────────────────────────────────────
    // Trust the deposit_verified flag f10join set when it checked each deposit
    // on-chain at join time (while the tx was fresh). Only re-verify on-chain the
    // players whose seat was NOT flagged — legacy rows, or a join whose flag
    // write failed. This avoids re-fetching every deposit at payout, where a
    // Solana tx can have aged past an RPC's history window during a long match
    // and return null (a spurious "deposit not found"). The flag is settable
    // only by the service role (clients have no UPDATE grant on match_players),
    // so trusting it introduces no new attack surface. The token-balance deltas
    // in the fallback prove mint, sender, destination, and exact amount.
    const unverified = players.filter((p: any) => p.deposit_verified !== true);
    if (unverified.length > 0) {
      const parsedDeposits = await Promise.all(
        unverified.map((p: any) => getParsedTx(rpc, p.deposit_tx as string)),
      );
      for (let i = 0; i < unverified.length; i++) {
        const parsed = parsedDeposits[i];
        if (!parsed) return errorResponse(`Deposit for player ${i + 1} not found on-chain`, 400);
        if (parsed.meta?.err) return errorResponse(`Deposit for player ${i + 1} failed on-chain`, 400);

        const expectedSender = walletByUser.get(unverified[i].user_id) ?? "";
        if (!isAddress(expectedSender)) return errorResponse(`Deposit for player ${i + 1}: depositing wallet was not recorded at join time`, 400);

        if (!txHasDeposit(parsed.meta, tokenAddr, expectedSender, escrowAddr, entryFeeRaw)) {
          console.error(`Deposit verification failed`, JSON.stringify({
            expectedSender, escrowAddr, tokenAddr, entryFee: entryFeeRaw.toString(),
            escrowDelta: ownerMintDelta(parsed.meta, escrowAddr, tokenAddr).toString(),
            senderDelta: ownerMintDelta(parsed.meta, expectedSender, tokenAddr).toString(),
          }));
          return errorResponse(
            `A deposit does not contain a valid FIGHT10 transfer from the player to escrow`,
            400,
          );
        }
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

    // ── Serialise escrow usage across matches (#6) ───────────────────────────
    // Two concurrent payouts would both spend from the same escrow token account
    // on the same blockhash. Hold a durable single-flight lock across signing +
    // broadcast, then release it the instant the tx is in flight. The lock's TTL
    // lets a crashed holder self-heal.
    escrowLockHolder = `${matchId}:${crypto.randomUUID()}`;
    for (let attempt = 0; ; attempt++) {
      const { data: got } = await adminClient.rpc("begin_escrow_payout", { p_holder: escrowLockHolder, p_ttl_seconds: 90 });
      if (got === true) { escrowLocked = true; break; }
      if (attempt >= 20) {
        // Couldn't get the escrow lock and nothing was broadcast — release our
        // reservation so the winner can retry cleanly instead of waiting out the
        // 10-minute stale-'pending' window.
        try {
          await adminClient.from("matches")
            .update({ payout_tx: null, payout_blockhash: null, payout_claimed_at: null })
            .eq("id", matchId).eq("payout_tx", "pending");
        } catch (_) { /* best-effort; stale-'pending' auto-releases after 10 min */ }
        slotClaimed = false;
        return errorResponse("Another payout is in progress — please retry in a moment", 503, matchId);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    // ── On-chain token transfer ───────────────────────────────────────────────
    const totalRaw        = BigInt(players.length) * entryFeeRaw;
    const winnerAmountRaw = (totalRaw * BigInt(winnerShareBps)) / BigInt(10000);

    // Lease one connection for the whole sign + broadcast + confirm sequence.
    const payConn      = rpc.lease();
    const winnerPubkey = new PublicKey(winnerAddr);
    const winnerAta    = getAssociatedTokenAddressSync(mint, winnerPubkey);

    // #P0 (persist BEFORE broadcast): build + SIGN the transfer WITHOUT sending
    // it, so we know its exact signature and blockhash up front. Create the
    // winner's token account if needed (idempotent; escrow pays rent), then
    // transferChecked binds the mint + decimals. The blockhash is fetched here
    // while we still hold the escrow lock.
    const { blockhash, lastValidBlockHeight } = await payConn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: escrowPubkey, blockhash, lastValidBlockHeight });
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(escrowPubkey, winnerAta, winnerPubkey, mint),
      createTransferCheckedInstruction(escrowAta, mint, winnerAta, escrowPubkey, winnerAmountRaw, decimals),
    );
    tx.sign(escrowKeypair);
    const rawTx = tx.serialize();
    const payoutSig = bs58.encode(tx.signature!);

    // Record the signed signature + blockhash, advancing our reservation from
    // 'pending' to the real tx BEFORE it hits the network. If this write can't be
    // made durable we throw WITHOUT broadcasting — no transfer is sent — and the
    // catch block releases the escrow lock and the still-'pending' slot for a
    // clean retry. Because the signature is on record before broadcast, any later
    // crash leaves a row the reconcile step above resolves against the chain,
    // never a silent broadcast the DB knows nothing about. A Solana runtime
    // dedupes by signature, so re-broadcasting the SAME bytes can execute at most
    // once.
    let hashWritten = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
      const { data: rows, error: writeErr } = await adminClient
        .from("matches")
        .update({ payout_tx: payoutSig, payout_blockhash: blockhash })
        .eq("id", matchId).eq("payout_tx", "pending")
        .select("id");
      if (!writeErr && rows && rows.length === 1) { hashWritten = true; break; }
      if (writeErr) console.error(`DB pre-broadcast write attempt ${attempt + 1} failed:`, writeErr);
    }
    if (!hashWritten) {
      throw new Error("Could not record payout before sending — no transfer was broadcast; please retry");
    }
    slotClaimed = false; // slot now holds the real signature, not 'pending'

    // Signature + blockhash are durably recorded — NOW broadcast the signed tx.
    await payConn.sendRawTransaction(rawTx, { skipPreflight: false, preflightCommitment: "confirmed" });
    broadcast = true;

    // Tx broadcast — release the escrow lock so other matches can proceed in
    // parallel. The confirm poll below does not need it.
    if (escrowLocked) {
      escrowLocked = false;
      try { await adminClient.rpc("end_escrow_payout", { p_holder: escrowLockHolder }); }
      catch (_) { /* best-effort; the lock's TTL frees it anyway */ }
    }

    // Poll for on-chain confirmation. A runtime ERROR is definitive (no tokens
    // moved), so we clear the recorded signature and let the winner retry. A
    // TIMEOUT is NOT definitive — the tx may still confirm — so we keep the
    // signature and report it as sent-but-pending rather than risk a double
    // transfer.
    const deadline = Date.now() + 90000;
    let confirmed = false;
    let failed = false;
    while (Date.now() < deadline) {
      const { value } = await payConn.getSignatureStatuses([payoutSig], { searchTransactionHistory: true }).catch(() => ({ value: [null] }));
      const st = value?.[0];
      if (st) {
        if (st.err) { failed = true; break; }
        if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") { confirmed = true; break; }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (failed) {
      // Only clear the record we actually wrote, and only because the failure is
      // proof no tokens moved. Guarded on the exact signature so we never wipe an
      // unrelated later claim.
      try {
        await adminClient.from("matches")
          .update({ payout_tx: null, payout_blockhash: null, payout_claimed_at: null })
          .eq("id", matchId).eq("payout_tx", payoutSig);
      } catch (_) { /* best-effort */ }
      return errorResponse("Payout tx failed on-chain: " + payoutSig, 502, matchId);
    }

    // Record a durable payout row (audit trail + the explorer link the client
    // shows in the victory screen and match history). Best-effort and idempotent
    // (upsert on match_id) — matches.payout_tx remains the source of truth, so a
    // failure here must not fail an already-broadcast payout.
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

    console.log(`[f10treasurer] paid match=${matchId} tx=${payoutSig} amount=${winnerAmountRaw.toString()} players=${players.length} confirmed=${confirmed}`);
    return new Response(
      JSON.stringify({ ok: true, payout_tx: payoutSig, winner_amount: winnerAmountRaw.toString(), num_players: players.length, decimals, confirmed }),
      { headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  } catch (err) {
    console.error("Payout error:", err);

    // Release the escrow lock if we still hold it (error before/around broadcast).
    if (escrowLocked && escrowLockHolder) {
      try {
        const a = createClient(supabaseUrl, supabaseServiceKey);
        await a.rpc("end_escrow_payout", { p_holder: escrowLockHolder });
      } catch (_) { /* best-effort; the TTL will free it anyway */ }
    }

    // Only release the payout slot if the tx was NOT broadcast. Once broadcast,
    // clearing the slot would let a retry send a SECOND transfer (double-pay);
    // that case keeps the slot and requires manual admin resolution.
    if (slotClaimed && !broadcast && matchId) {
      try {
        const adminClient = createClient(supabaseUrl, supabaseServiceKey);
        await adminClient.from("matches")
          .update({ payout_tx: null, payout_blockhash: null, payout_claimed_at: null })
          .eq("id", matchId)
          .eq("payout_tx", "pending");
      } catch (_) { /* best-effort */ }
    }

    return errorResponse(String(err), 500);
  }
});
