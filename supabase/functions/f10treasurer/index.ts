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

// Decode base58 → PublicKey, left-padding to exactly 32 bytes.
// web3.js's internal base-x decoder does NOT pad, so passes wrong length
// to new PublicKey when the numerical value fits in < 32 bytes.
function pubkeyFromBase58(str: string): PublicKey {
  const raw = base58Decode(str.replace(/[^123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]/g, ""));
  if (raw.length > 32) throw new Error(`base58 too long: ${raw.length} bytes for "${str.slice(0, 8)}…"`);
  const padded = new Uint8Array(32);
  padded.set(raw, 32 - raw.length); // left-pad with zeros
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

// SPL Transfer instruction (works for both Token and Token-2022)
function transferInstruction(
  source: PublicKey,
  dest: PublicKey,
  owner: PublicKey,
  amount: bigint,
  tokenProgram: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0); // Transfer instruction index
  // Write u64 LE
  const lo = Number(amount & BigInt(0xffffffff));
  const hi = Number(amount >> BigInt(32));
  data.writeUInt32LE(lo, 1);
  data.writeUInt32LE(hi, 5);
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

// Create ATA instruction
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
    data: Buffer.alloc(0),
  });
}

// ---------------------------------------------------------------------------

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function errorResponse(message: string, status: number): Response {
  console.error("errorResponse:", status, message);
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

    console.log("Payout request — match:", matchId, "user:", user.id);

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

    // Strip all non-base58 characters (catches hidden newlines, zero-width spaces, etc.)
    const B58_CHARS = /[^123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]/g;
    const cleanEscrow = escrowB58.replace(B58_CHARS, "");
    const cleanMint   = mintStr.replace(B58_CHARS, "");
    console.log("Mint (sanitized):", cleanMint);
    console.log("Escrow key length:", cleanEscrow.length);

    console.log("Decoding escrow keypair…");
    const escrowKeypair = Keypair.fromSecretKey(base58Decode(cleanEscrow));
    console.log("Escrow pubkey:", escrowKeypair.publicKey.toString());

    const mintPubkey   = pubkeyFromBase58(cleanMint);
    console.log("Mint pubkey ok:", mintPubkey.toString());
    const rawWallet = (profile.wallet_address ?? "").split(":").pop() ?? "";
    console.log("Winner wallet:", rawWallet.slice(0, 8), "…length:", rawWallet.length);
    if (!rawWallet) return errorResponse("Winner wallet address invalid", 400);
    const winnerPubkey = pubkeyFromBase58(rawWallet);
    console.log("Winner pubkey ok:", winnerPubkey.toString());
    const connection  = new Connection(rpcUrl, "confirmed");

    console.log("Fetching mint account to detect token program…");
    const mintAcct = await connection.getAccountInfo(mintPubkey);
    if (!mintAcct) return errorResponse("Mint account not found on-chain", 500);

    const tokenProgramId = mintAcct.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;
    console.log("Token program:", tokenProgramId.equals(TOKEN_2022_PROGRAM_ID) ? "Token-2022" : "Token");

    // Derive decimals from mint data (offset 44 for both Token and Token-2022)
    const decimals = mintAcct.data[44];
    console.log("Decimals:", decimals);

    const entryFeeRaw    = BigInt(2500) * BigInt(10 ** decimals);
    const totalRaw       = BigInt(players.length) * entryFeeRaw;
    const winnerAmountRaw = (totalRaw * BigInt(900)) / BigInt(1000);
    console.log("Payout:", winnerAmountRaw.toString(), "raw units →", profile.wallet_address);

    console.log("Finding escrow token account…");
    const escrowAccounts = await connection.getParsedTokenAccountsByOwner(escrowKeypair.publicKey, { mint: mintPubkey });
    if (escrowAccounts.value.length === 0) return errorResponse("Escrow has no token account for this mint", 500);
    const escrowTokenAccount = new PublicKey(escrowAccounts.value[0].pubkey);
    console.log("Escrow token account:", escrowTokenAccount.toString());

    const winnerAta = await getATA(mintPubkey, winnerPubkey, tokenProgramId);
    console.log("Winner ATA:", winnerAta.toString());

    const tx = new Transaction();

    const winnerAtaInfo = await connection.getAccountInfo(winnerAta);
    if (!winnerAtaInfo) {
      console.log("Winner ATA does not exist — adding create instruction");
      tx.add(createATAInstruction(escrowKeypair.publicKey, winnerAta, winnerPubkey, mintPubkey, tokenProgramId));
    } else {
      console.log("Winner ATA exists");
    }

    tx.add(transferInstruction(escrowTokenAccount, winnerAta, escrowKeypair.publicKey, winnerAmountRaw, tokenProgramId));

    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = escrowKeypair.publicKey;
    tx.sign(escrowKeypair);

    console.log("Sending payout tx…");
    const payoutSig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    console.log("Payout tx sent:", payoutSig);

    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const { value } = await connection.getSignatureStatuses([payoutSig]);
      const s = value[0];
      if (s?.err) throw new Error("Payout tx failed: " + JSON.stringify(s.err));
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log("Payout confirmed:", payoutSig);

    await adminClient.from("matches").update({ payout_tx: payoutSig }).eq("id", matchId);

    return new Response(
      JSON.stringify({ ok: true, payout_tx: payoutSig, winner_amount: winnerAmountRaw.toString(), num_players: players.length, decimals }),
      { headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  } catch (err) {
    console.error("Unhandled payout error:", err);
    return errorResponse(String(err), 500);
  }
});
