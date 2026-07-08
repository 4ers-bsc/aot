
/// Payout Edge Function
// Required Supabase secrets: ESCROW_PRIVATE_KEY (base58), FIGHT10_MINT, RPC_URL

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "npm:@solana/web3.js@1.87.6";
import { canonicalPubkey, hasValidDepositTransfer } from "../_shared/deposit_verify.ts";

// ---------------------------------------------------------------------------
// Base58 decode (no external dependency)
// ---------------------------------------------------------------------------
function base58Decode(str: string): Uint8Array {
  const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const map = new Uint8Array(256).fill(255);
  for (let i = 0; i < ALPHA.length; i++) map[ALPHA.charCodeAt(i)] = i;
  const bytes: number[] = [];
  for (const ch of str) {
    const v = map[ch.charCodeAt(0)];
    if (v === 255) throw new Error("Invalid base58 char: " + ch);
    let carry = v;
    for (let j = bytes.length - 1; j >= 0; j--) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.unshift(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  while (str[zeros] === "1") zeros++;
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes]);
}

// web3.js's internal base-x decoder does NOT pad to 32 bytes; do it manually.
function pubkeyFromBase58(str: string): PublicKey {
  const raw = base58Decode(str.replace(/[^123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]/g, ""));
  if (raw.length > 32) throw new Error(`base58 too long: ${raw.length} bytes`);
  const padded = new Uint8Array(32);
  padded.set(raw, 32 - raw.length);
  return new PublicKey(padded);
}

// ---------------------------------------------------------------------------
// SPL token helpers — no @solana/spl-token dependency
// ---------------------------------------------------------------------------
const TOKEN_PROGRAM_ID      = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bj");

async function getATA(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey): Promise<PublicKey> {
  const [address] = await PublicKey.findProgramAddress(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

function transferInstruction(
  source: PublicKey,
  dest: PublicKey,
  owner: PublicKey,
  amount: bigint,
  tokenProgram: PublicKey,
): TransactionInstruction {
  const data = new Uint8Array(9);
  data[0] = 3; // Transfer instruction index
  const lo = Number(amount & BigInt(0xffffffff));
  const hi = Number(amount >> BigInt(32));
  new DataView(data.buffer).setUint32(1, lo, true);
  new DataView(data.buffer).setUint32(5, hi, true);
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: dest,   isSigner: false, isWritable: true },
      { pubkey: owner,  isSigner: true,  isWritable: false },
    ],
    data,
  });
}

function createATAInstruction(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer,                      isSigner: true,  isWritable: true },
      { pubkey: ata,                         isSigner: false, isWritable: true },
      { pubkey: owner,                       isSigner: false, isWritable: false },
      { pubkey: mint,                        isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,     isSigner: false, isWritable: false },
      { pubkey: tokenProgram,                isSigner: false, isWritable: false },
    ],
    data: new Uint8Array(0),
  });
}

// ---------------------------------------------------------------------------
// RPC endpoint pool — spread load across up to 3 keys (RPC_URL, RPC_URL_2,
// RPC_URL_3). Each call grabs the next endpoint round-robin (so parallel deposit
// lookups hit different keys); on error (e.g. a 429 rate limit) the call rotates
// to the next key instead of failing. Random start keeps load balanced across
// function instances. `lease()` returns one sticky connection for the payout
// send + confirm poll, so the tx is broadcast and polled on a single endpoint.
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
  return unique.length ? unique : ["https://api.mainnet-beta.solana.com"];
}

function createRpcPool(commitment: "confirmed" | "finalized" = "confirmed") {
  const conns = getRpcUrls().map((u) => new Connection(u, commitment));
  let idx = Math.floor(Math.random() * conns.length);
  const next = () => {
    const c = conns[idx];
    idx = (idx + 1) % conns.length;
    return c;
  };
  return {
    lease: () => next(),
    async run<T>(fn: (c: Connection) => Promise<T>): Promise<T> {
      let lastErr: unknown;
      for (let i = 0; i < conns.length; i++) {
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
    // The on-chain transfer's `authority` must match this so a confirmed transfer
    // that someone else funded cannot pass verification.
    const walletByUser = new Map<string, string>(
      players.map((p: any) => [p.user_id, ((p.deposit_wallet ?? "").split(":").pop() ?? "").trim()]),
    );

    // ── Fetch winner wallet ──────────────────────────────────────────────────
    const { data: profile } = await adminClient
      .from("profiles").select("wallet_address").eq("user_id", user.id).maybeSingle();
    if (!profile?.wallet_address) return errorResponse("Winner wallet address not found", 400);

    // ── Escrow / mint config ─────────────────────────────────────────────────
    const escrowB58 = Deno.env.get("ESCROW_PRIVATE_KEY");
    const mintStr   = Deno.env.get("FIGHT10_MINT");
    if (!escrowB58 || !mintStr) return errorResponse("Escrow configuration missing", 500);

    const B58_CHARS  = /[^123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]/g;
    const escrowKeypair = Keypair.fromSecretKey(base58Decode(escrowB58.replace(B58_CHARS, "")));
    const mintPubkey    = pubkeyFromBase58(mintStr.replace(B58_CHARS, ""));
    const rawWallet     = (profile.wallet_address ?? "").split(":").pop() ?? "";
    if (!rawWallet) return errorResponse("Winner wallet address invalid", 400);
    const winnerPubkey  = pubkeyFromBase58(rawWallet);
    const rpc           = createRpcPool("confirmed");

    // ── Resolve mint → token program, decimals, escrow token account ────────
    // Done early so the same values are reused for both deposit verification
    // and the payout transfer, avoiding a redundant getAccountInfo call later.
    const mintAcct = await rpc.run((c) => c.getAccountInfo(mintPubkey));
    if (!mintAcct) return errorResponse("Mint account not found on-chain", 500);
    const tokenProgramId = mintAcct.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const decimals       = mintAcct.data[44];
    const entryFeeRaw    = BigInt(2500) * BigInt(10 ** decimals);
    const entryFeeAmtStr = entryFeeRaw.toString();
    const tokenProgStr   = tokenProgramId.toString();
    const tok2022Str     = TOKEN_2022_PROGRAM_ID.toString();

    // Fetch the real escrow token account once, reuse for both verification and payout.
    const escrowAccounts = await rpc.run((c) => c.getParsedTokenAccountsByOwner(escrowKeypair.publicKey, { mint: mintPubkey }));
    if (escrowAccounts.value.length === 0) return errorResponse("Escrow has no token account for this mint", 500);
    const escrowTokenAccount = new PublicKey(escrowAccounts.value[0].pubkey);
    const escrowAtaStr       = escrowTokenAccount.toString();

    // ── Verify each deposit tx is confirmed on-chain ─────────────────────────
    const depositSigs = players.map((p: any) => p.deposit_tx as string);
    const { value: sigStatuses } = await rpc.run((c) => c.getSignatureStatuses(depositSigs));
    for (let i = 0; i < depositSigs.length; i++) {
      const s = sigStatuses[i];
      if (!s) return errorResponse(`Deposit ${i + 1} not found on-chain`, 400);
      if (s.err) return errorResponse(`Deposit ${i + 1} failed on-chain`, 400);
      if (s.confirmationStatus !== "confirmed" && s.confirmationStatus !== "finalized") {
        return errorResponse(`Deposit ${i + 1} not yet confirmed`, 400);
      }
    }

    // ── Verify each deposit tx transferred the correct amount to escrow ──────
    // Parses the on-chain instruction data to confirm mint, destination, and
    // exact amount — a confirmed-but-unrelated tx signature cannot pass this.
    // All fetches run in parallel to minimise latency (Fix 3/12).
    const parsedTxs = await Promise.all(
      depositSigs.map((sig) =>
        rpc.run((c) => c.getParsedTransaction(sig, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        }))
      )
    );

    for (let i = 0; i < depositSigs.length; i++) {
      const parsed = parsedTxs[i];
      if (!parsed) return errorResponse(`Deposit ${i + 1} could not be parsed`, 400);

      // The wallet that must have authorised this deposit. Normalise to a
      // canonical base58 pubkey so the comparison below is not defeated by raw
      // string formatting differences in the stored wallet_address.
      const expectedSenderRaw = walletByUser.get(players[i].user_id);
      if (!expectedSenderRaw) return errorResponse(`Deposit ${i + 1}: depositing wallet was not recorded at join time`, 400);
      let expectedSender: string;
      try {
        expectedSender = canonicalPubkey(expectedSenderRaw);
      } catch {
        return errorResponse(`Deposit ${i + 1}: depositor wallet invalid`, 400);
      }

      // Include inner instructions to handle CPI-wrapped transfers
      const topLevel = parsed.transaction.message.instructions as any[];
      const inner    = (parsed.meta?.innerInstructions ?? []).flatMap((ii: any) => ii.instructions);

      const valid = hasValidDepositTransfer([...topLevel, ...inner], {
        expectedSender,
        escrowAta: escrowAtaStr,
        amountRaw: entryFeeAmtStr,
        tokenProgramId: tokenProgStr,
        token2022ProgramId: tok2022Str,
      });

      if (!valid) {
        // Log expected vs observed transfers so failures can be diagnosed from
        // the function logs without leaking detail into the client response.
        const seen = [...topLevel, ...inner]
          .filter((ix: any) => {
            const p = ix.programId?.toString();
            return (p === tokenProgStr || p === tok2022Str) && ix.parsed;
          })
          .map((ix: any) => ({
            type: ix.parsed.type,
            sender: ix.parsed.info?.authority ?? ix.parsed.info?.multisigAuthority,
            destination: ix.parsed.info?.destination,
            amount: ix.parsed.info?.amount ?? ix.parsed.info?.tokenAmount?.amount,
          }));
        console.error(`Deposit ${i + 1} verification failed`, JSON.stringify({
          expectedSender, escrowAtaStr, entryFeeAmtStr, tokenProgStr, tok2022Str, seen,
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
    // mintAcct / tokenProgramId / decimals / entryFeeRaw / escrowTokenAccount already resolved above.
    const totalRaw        = BigInt(players.length) * entryFeeRaw;
    const winnerAmountRaw = (totalRaw * BigInt(900)) / BigInt(1000);

    const winnerAccounts = await rpc.run((c) => c.getParsedTokenAccountsByOwner(winnerPubkey, { mint: mintPubkey }));

    const tx = new Transaction();
    let winnerTokenAccount: PublicKey;

    if (winnerAccounts.value.length > 0) {
      winnerTokenAccount = new PublicKey(winnerAccounts.value[0].pubkey);
    } else {
      winnerTokenAccount = await getATA(mintPubkey, winnerPubkey, tokenProgramId);
      tx.add(createATAInstruction(escrowKeypair.publicKey, winnerTokenAccount, winnerPubkey, mintPubkey, tokenProgramId));
    }

    tx.add(transferInstruction(escrowTokenAccount, winnerTokenAccount, escrowKeypair.publicKey, winnerAmountRaw, tokenProgramId));

    // Lease one connection for the whole send + confirm sequence so the tx is
    // broadcast and polled on a single endpoint (round-robin across the 3 keys).
    const payConn = rpc.lease();
    const { blockhash } = await payConn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = escrowKeypair.publicKey;
    tx.sign(escrowKeypair);

    const payoutSig = await payConn.sendRawTransaction(tx.serialize(), { skipPreflight: false });

    // Fix 2 (partial): Poll for on-chain confirmation; throw explicitly on timeout
    // so the catch block correctly releases the slot (tx never landed).
    const deadline = Date.now() + 90000;
    let confirmed = false;
    while (Date.now() < deadline) {
      const { value } = await payConn.getSignatureStatuses([payoutSig]);
      const s = value[0];
      if (s?.err) throw new Error("Payout tx failed: " + JSON.stringify(s.err));
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
        confirmed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!confirmed) throw new Error(`Payout tx not confirmed after 90s — sig: ${payoutSig}`);

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

    slotClaimed = false; // slot replaced with real sig — no rollback needed

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
