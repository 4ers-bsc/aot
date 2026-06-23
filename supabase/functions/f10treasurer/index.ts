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
  "Access-Control-Allow-Origin": "*",
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

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return errorResponse("Missing Authorization header", 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return errorResponse("Unauthorized", 401);

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    const body = await req.json();
    const matchId: string = body?.match_id;
    if (!matchId) return errorResponse("match_id is required", 400);

    const { data: matchRow, error: matchErr } = await adminClient
      .from("matches").select("id, status, winner_user_id, payout_tx").eq("id", matchId).maybeSingle();
    if (matchErr || !matchRow) return errorResponse("Match not found", 404);
    if (matchRow.status !== "finished") return errorResponse("Match is not finished", 400);
    if (matchRow.winner_user_id !== user.id) return errorResponse("Only the winner may claim", 403);
    if (matchRow.payout_tx) return errorResponse("Prize already claimed", 409);

    const { data: players, error: playersErr } = await adminClient
      .from("match_players").select("user_id, deposit_tx").eq("match_id", matchId);
    if (playersErr || !players) return errorResponse("Could not fetch match players", 500);
    const missing = players.filter((p: any) => !p.deposit_tx);
    if (missing.length > 0) return errorResponse(`${missing.length} player(s) have not deposited`, 400);

    const { data: profile } = await adminClient
      .from("profiles").select("wallet_address").eq("user_id", user.id).maybeSingle();
    if (!profile?.wallet_address) return errorResponse("Winner wallet address not found", 400);

    const escrowB58 = Deno.env.get("ESCROW_PRIVATE_KEY");
    const mintStr  = Deno.env.get("FIGHT10_MINT");
    const rpcUrl   = Deno.env.get("RPC_URL") ?? "https://api.mainnet-beta.solana.com";
    if (!escrowB58 || !mintStr) return errorResponse("Escrow configuration missing", 500);

    const B58_CHARS = /[^123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]/g;
    const escrowKeypair = Keypair.fromSecretKey(base58Decode(escrowB58.replace(B58_CHARS, "")));
    const mintPubkey    = pubkeyFromBase58(mintStr.replace(B58_CHARS, ""));
    const rawWallet     = (profile.wallet_address ?? "").split(":").pop() ?? "";
    if (!rawWallet) return errorResponse("Winner wallet address invalid", 400);
    const winnerPubkey  = pubkeyFromBase58(rawWallet);
    const connection    = new Connection(rpcUrl, "confirmed");

    const mintAcct = await connection.getAccountInfo(mintPubkey);
    if (!mintAcct) return errorResponse("Mint account not found on-chain", 500);

    const tokenProgramId = mintAcct.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;

    const decimals = mintAcct.data[44];

    const entryFeeRaw     = BigInt(2500) * BigInt(10 ** decimals);
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

    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const { value } = await connection.getSignatureStatuses([payoutSig]);
      const s = value[0];
      if (s?.err) throw new Error("Payout tx failed: " + JSON.stringify(s.err));
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    await adminClient.from("matches").update({ payout_tx: payoutSig }).eq("id", matchId);

    return new Response(
      JSON.stringify({ ok: true, payout_tx: payoutSig, winner_amount: winnerAmountRaw.toString(), num_players: players.length, decimals }),
      { headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  } catch (err) {
    console.error("Payout error:", err);
    return errorResponse(String(err), 500);
  }
});
