// Payout Edge Function
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

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ORIGIN") || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function errorResponse(message: string, status: number): Response {
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
  let slotClaimed = false; // tracks whether we set payout_tx = 'pending'

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
      .from("match_players").select("user_id, deposit_tx").eq("match_id", matchId);
    if (playersErr || !players) return errorResponse("Could not fetch match players", 500);
    const missing = players.filter((p: any) => !p.deposit_tx);
    if (missing.length > 0) return errorResponse(`${missing.length} player(s) have not deposited`, 400);

    // ── Fetch winner wallet ──────────────────────────────────────────────────
    const { data: profile } = await adminClient
      .from("profiles").select("wallet_address").eq("user_id", user.id).maybeSingle();
    if (!profile?.wallet_address) return errorResponse("Winner wallet address not found", 400);

    // ── Escrow / mint config ─────────────────────────────────────────────────
    const escrowB58 = Deno.env.get("ESCROW_PRIVATE_KEY");
    const mintStr   = Deno.env.get("FIGHT10_MINT");
    const rpcUrl    = Deno.env.get("RPC_URL") ?? "https://api.mainnet-beta.solana.com";
    if (!escrowB58 || !mintStr) return errorResponse("Escrow configuration missing", 500);

    const B58_CHARS  = /[^123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]/g;
    const escrowKeypair = Keypair.fromSecretKey(base58Decode(escrowB58.replace(B58_CHARS, "")));
    const mintPubkey    = pubkeyFromBase58(mintStr.replace(B58_CHARS, ""));
    const rawWallet     = (profile.wallet_address ?? "").split(":").pop() ?? "";
    if (!rawWallet) return errorResponse("Winner wallet address invalid", 400);
    const winnerPubkey  = pubkeyFromBase58(rawWallet);
    const connection    = new Connection(rpcUrl, "confirmed");

    // ── Resolve mint → token program, decimals, escrow ATA ──────────────────
    // Done early so the same values are reused for both deposit verification
    // and the payout transfer, avoiding a redundant getAccountInfo call later.
    const mintAcct = await connection.getAccountInfo(mintPubkey);
    if (!mintAcct) return errorResponse("Mint account not found on-chain", 500);
    const tokenProgramId = mintAcct.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const decimals       = mintAcct.data[44];
    const entryFeeRaw    = BigInt(2500) * BigInt(10 ** decimals);
    const entryFeeAmtStr = entryFeeRaw.toString();
    const escrowAta      = await getATA(mintPubkey, escrowKeypair.publicKey, tokenProgramId);
    const escrowAtaStr   = escrowAta.toString();
    const tokenProgStr   = tokenProgramId.toString();
    const tok2022Str     = TOKEN_2022_PROGRAM_ID.toString();

    // ── Verify each deposit tx is confirmed on-chain ─────────────────────────
    const depositSigs = players.map((p: any) => p.deposit_tx as string);
    const { value: sigStatuses } = await connection.getSignatureStatuses(depositSigs);
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
        connection.getParsedTransaction(sig, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        })
      )
    );

    for (let i = 0; i < depositSigs.length; i++) {
      const parsed = parsedTxs[i];
      if (!parsed) return errorResponse(`Deposit ${i + 1} could not be parsed`, 400);

      // Include inner instructions to handle CPI-wrapped transfers
      const topLevel = parsed.transaction.message.instructions as any[];
      const inner    = (parsed.meta?.innerInstructions ?? []).flatMap((ii: any) => ii.instructions);

      const valid = [...topLevel, ...inner].some((ix: any) => {
        if (ix.programId !== tokenProgStr && ix.programId !== tok2022Str) return false;
        if (!ix.parsed) return false;
        const { type, info } = ix.parsed;
        if (type === "transfer") {
          return info.destination === escrowAtaStr && info.amount === entryFeeAmtStr;
        }
        if (type === "transferChecked") {
          return info.destination === escrowAtaStr &&
                 info.tokenAmount?.amount === entryFeeAmtStr;
        }
        return false;
      });

      if (!valid) {
        return errorResponse(
          `Deposit ${i + 1} does not contain a valid FIGHT10 transfer to escrow`,
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
    // mintAcct / tokenProgramId / decimals / entryFeeRaw already resolved above.
    const totalRaw        = BigInt(players.length) * entryFeeRaw;
    const winnerAmountRaw = (totalRaw * BigInt(900)) / BigInt(1000);

    const escrowAccounts = await connection.getParsedTokenAccountsByOwner(escrowKeypair.publicKey, { mint: mintPubkey });
    if (escrowAccounts.value.length === 0) return errorResponse("Escrow has no token account for this mint", 500);
    const escrowTokenAccount = new PublicKey(escrowAccounts.value[0].pubkey);

    const winnerAccounts = await connection.getParsedTokenAccountsByOwner(winnerPubkey, { mint: mintPubkey });

    const tx = new Transaction();
    let winnerTokenAccount: PublicKey;

    if (winnerAccounts.value.length > 0) {
      winnerTokenAccount = new PublicKey(winnerAccounts.value[0].pubkey);
    } else {
      winnerTokenAccount = await getATA(mintPubkey, winnerPubkey, tokenProgramId);
      tx.add(createATAInstruction(escrowKeypair.publicKey, winnerTokenAccount, winnerPubkey, mintPubkey, tokenProgramId));
    }

    tx.add(transferInstruction(escrowTokenAccount, winnerTokenAccount, escrowKeypair.publicKey, winnerAmountRaw, tokenProgramId));

    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = escrowKeypair.publicKey;
    tx.sign(escrowKeypair);

    const payoutSig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });

    // Poll for confirmation
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const { value } = await connection.getSignatureStatuses([payoutSig]);
      const s = value[0];
      if (s?.err) throw new Error("Payout tx failed: " + JSON.stringify(s.err));
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Replace 'pending' reservation with the real signature
    await adminClient.from("matches").update({ payout_tx: payoutSig }).eq("id", matchId);
    slotClaimed = false; // no longer needs rollback

    return new Response(
      JSON.stringify({ ok: true, payout_tx: payoutSig, winner_amount: winnerAmountRaw.toString(), num_players: players.length, decimals }),
      { headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  } catch (err) {
    console.error("Payout error:", err);

    // If we claimed the slot but the tx failed, release the reservation so the
    // winner can retry — only clear if still 'pending' (not already set to a real sig).
    if (slotClaimed && matchId) {
      try {
        const adminClient = createClient(supabaseUrl, supabaseServiceKey);
        await adminClient.from("matches")
          .update({ payout_tx: null })
          .eq("id", matchId)
          .eq("payout_tx", "pending");
      } catch (_) { /* best-effort */ }
    }

    return errorResponse(String(err), 500);
  }
});
