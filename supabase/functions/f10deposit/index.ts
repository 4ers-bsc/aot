/// Deposit Verify + Join Edge Function
// Verifies a player's FIGHT10 entry-fee deposit on-chain ONCE, at join time,
// then records the join and marks match_players.deposit_verified = true (via the
// service role). f10treasurer trusts that flag at payout time instead of
// re-verifying every deposit on-chain — which is slow and, for any match longer
// than the RPC's ~2 min status cache, was producing spurious payout failures.
//
// Required Supabase secrets: ESCROW_PRIVATE_KEY (base58), FIGHT10_MINT, RPC_URL

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  Connection,
  Keypair,
  PublicKey,
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

const TOKEN_PROGRAM_ID      = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

// ---------------------------------------------------------------------------

const appOrigin = Deno.env.get("APP_ORIGIN");
if (!appOrigin) console.error("WARNING: APP_ORIGIN secret not set — CORS is open to all origins. Set it in Supabase secrets for production.");
const corsHeaders = {
  "Access-Control-Allow-Origin": appOrigin || "*",
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

  const supabaseUrl        = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey    = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
    const maxPlayers = Number(body?.max_players);
    const depositTx  = (body?.deposit_tx ?? "").toString().trim();
    if (![2, 5, 10].includes(maxPlayers)) return errorResponse("max_players must be 2, 5, or 10", 400);
    if (!depositTx) return errorResponse("deposit_tx is required", 400);

    // ── Caller wallet (the depositing authority) ─────────────────────────────
    const { data: profile } = await adminClient
      .from("profiles").select("wallet_address").eq("user_id", user.id).maybeSingle();
    if (!profile?.wallet_address) return errorResponse("Wallet address not found — sync your profile first", 400);
    const depositorWallet = (profile.wallet_address ?? "").split(":").pop() ?? "";
    if (!depositorWallet) return errorResponse("Wallet address invalid", 400);

    // ── Escrow / mint config ─────────────────────────────────────────────────
    const escrowB58 = Deno.env.get("ESCROW_PRIVATE_KEY");
    const mintStr   = Deno.env.get("FIGHT10_MINT");
    const rpcUrl    = Deno.env.get("RPC_URL") ?? "https://api.mainnet-beta.solana.com";
    if (!escrowB58 || !mintStr) return errorResponse("Escrow configuration missing", 500);

    const B58_CHARS = /[^123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]/g;
    // Only the escrow public key is needed here (to locate its token account);
    // the deposit function never signs anything.
    const escrowPubkey = Keypair.fromSecretKey(base58Decode(escrowB58.replace(B58_CHARS, ""))).publicKey;
    const mintPubkey   = pubkeyFromBase58(mintStr.replace(B58_CHARS, ""));
    const connection   = new Connection(rpcUrl, "confirmed");

    // ── Resolve mint → token program, decimals, expected entry-fee amount ────
    const mintAcct = await connection.getAccountInfo(mintPubkey);
    if (!mintAcct) return errorResponse("Mint account not found on-chain", 500);
    const tokenProgStr   = (mintAcct.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID).toString();
    const tok2022Str     = TOKEN_2022_PROGRAM_ID.toString();
    const decimals       = mintAcct.data[44];
    const entryFeeAmtStr = (BigInt(2500) * BigInt(10 ** decimals)).toString();

    const escrowAccounts = await connection.getParsedTokenAccountsByOwner(escrowPubkey, { mint: mintPubkey });
    if (escrowAccounts.value.length === 0) return errorResponse("Escrow has no token account for this mint", 500);
    const escrowAtaStr = new PublicKey(escrowAccounts.value[0].pubkey).toString();

    // ── Verify the deposit tx is confirmed on-chain ──────────────────────────
    // searchTransactionHistory: true so a deposit that has aged out of the
    // recent (~2 min) status cache is still found.
    const { value: [status] } = await connection.getSignatureStatuses([depositTx], {
      searchTransactionHistory: true,
    });
    if (!status) return errorResponse("Deposit not found on-chain", 400);
    if (status.err) return errorResponse("Deposit failed on-chain", 400);
    if (status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized") {
      return errorResponse("Deposit not yet confirmed — try again in a moment", 400);
    }

    // ── Verify the tx transferred the entry fee from the caller to escrow ────
    const parsed = await connection.getParsedTransaction(depositTx, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!parsed) return errorResponse("Deposit could not be parsed", 400);

    const topLevel = parsed.transaction.message.instructions as any[];
    const inner    = (parsed.meta?.innerInstructions ?? []).flatMap((ii: any) => ii.instructions);
    const valid = [...topLevel, ...inner].some((ix: any) => {
      const prog = ix.programId?.toString();
      if (prog !== tokenProgStr && prog !== tok2022Str) return false;
      if (!ix.parsed) return false;
      const { type, info } = ix.parsed;
      // Check destination (escrow), exact amount, and authority (this caller's
      // wallet) — the authority check prevents replaying someone else's deposit.
      if (type === "transfer") {
        return info.destination === escrowAtaStr &&
               info.amount === entryFeeAmtStr &&
               info.authority === depositorWallet;
      }
      if (type === "transferChecked") {
        return info.destination === escrowAtaStr &&
               info.tokenAmount?.amount === entryFeeAmtStr &&
               info.authority === depositorWallet;
      }
      return false;
    });
    if (!valid) {
      return errorResponse("Deposit does not contain a valid FIGHT10 entry-fee transfer to escrow from your wallet", 400);
    }

    // ── Record the join (under the caller's JWT so auth.uid() resolves) ──────
    const { data: joinResult, error: joinErr } = await userClient.rpc("join_pvp_match", {
      p_max_players: maxPlayers,
      p_deposit_tx: depositTx,
    });
    if (joinErr) return errorResponse(joinErr.message || "Could not join match", 400);

    // ── Mark the deposit verified (service role; clients cannot set this) ────
    // Skip on rejoin: the player is resuming an existing match whose deposit was
    // already verified on the original join.
    if (!joinResult?.rejoining) {
      const { error: flagErr } = await adminClient
        .from("match_players")
        .update({ deposit_verified: true })
        .eq("match_id", joinResult.match_id)
        .eq("user_id", user.id);
      if (flagErr) {
        // The join succeeded but the flag write failed. Don't fail the request —
        // f10treasurer falls back to on-chain verification for unflagged deposits.
        console.error("deposit_verified write failed:", flagErr);
      }
    }

    return new Response(JSON.stringify(joinResult), {
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error("Deposit/join error:", err);
    return errorResponse(String(err), 500);
  }
});
