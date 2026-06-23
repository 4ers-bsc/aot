// Payout Edge Function — uses npm: specifiers so Deno resolves Node built-ins.
// Invoked by the match winner after finish_match() resolves.
// Sends 90% of the total pot from escrow to the winner. 10% stays in treasury.
//
// Required Supabase secrets:
//   ESCROW_PRIVATE_KEY  — base58 keypair of the escrow/treasury wallet
//   FIGHT10_MINT        — SPL token mint address
//   RPC_URL             — Solana RPC endpoint (mainnet-beta)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "npm:@solana/web3.js@1.87.6";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getMint,
  getAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "npm:@solana/spl-token@0.4.9";
import bs58 from "npm:bs58@5.0.0";

const TREASURY_CUT = 0.10;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

    // Verify caller is the match winner
    const { data: matchRow, error: matchErr } = await adminClient
      .from("matches")
      .select("id, status, winner_user_id, max_players, payout_tx")
      .eq("id", matchId)
      .maybeSingle();

    if (matchErr || !matchRow) return errorResponse("Match not found", 404);
    if (matchRow.status !== "finished") return errorResponse("Match is not finished", 400);
    if (matchRow.winner_user_id !== user.id) return errorResponse("Only the winner may claim the prize", 403);
    if (matchRow.payout_tx) return errorResponse("Prize already claimed", 409);

    // Verify all players deposited
    const { data: players, error: playersErr } = await adminClient
      .from("match_players")
      .select("user_id, deposit_tx")
      .eq("match_id", matchId);

    if (playersErr || !players) return errorResponse("Could not fetch match players", 500);
    const missing = players.filter((p) => !p.deposit_tx);
    if (missing.length > 0) {
      return errorResponse(`${missing.length} player(s) have not deposited`, 400);
    }

    // Get winner wallet
    const { data: profile, error: profileErr } = await adminClient
      .from("profiles")
      .select("wallet_address")
      .eq("user_id", user.id)
      .maybeSingle();

    if (profileErr || !profile?.wallet_address) {
      return errorResponse("Winner wallet address not found", 400);
    }

    const escrowPrivateKeyB58 = Deno.env.get("ESCROW_PRIVATE_KEY");
    const fightMintStr = Deno.env.get("FIGHT10_MINT");
    const rpcUrl = Deno.env.get("RPC_URL") ?? "https://api.mainnet-beta.solana.com";

    if (!escrowPrivateKeyB58 || !fightMintStr) {
      return errorResponse("Escrow configuration missing", 500);
    }

    const escrowKeypair = Keypair.fromSecretKey(bs58.decode(escrowPrivateKeyB58));
    const mintPubkey = new PublicKey(fightMintStr);
    const winnerPubkey = new PublicKey(profile.wallet_address);
    const connection = new Connection(rpcUrl, "confirmed");

    // Detect token program (Token vs Token-2022) from the mint account owner
    const mintAccountInfo = await connection.getAccountInfo(mintPubkey);
    if (!mintAccountInfo) return errorResponse("Mint account not found", 500);
    const tokenProgramId = mintAccountInfo.owner;

    const mintInfo = await getMint(connection, mintPubkey, "confirmed", tokenProgramId);
    const decimals = mintInfo.decimals;
    const entryFeeRaw = BigInt(2500) * BigInt(10 ** decimals);

    const numPlayers = BigInt(players.length);
    const totalRaw = numPlayers * entryFeeRaw;
    const winnerAmountRaw = (totalRaw * BigInt(900)) / BigInt(1000);

    // Find escrow's actual token account for this mint
    const escrowAccounts = await connection.getParsedTokenAccountsByOwner(
      escrowKeypair.publicKey,
      { mint: mintPubkey },
    );
    if (escrowAccounts.value.length === 0) {
      return errorResponse("Escrow has no token account for this mint", 500);
    }
    const escrowTokenAccount = new PublicKey(escrowAccounts.value[0].pubkey);

    // Winner's ATA (create if needed)
    const winnerAta = await getAssociatedTokenAddress(
      mintPubkey, winnerPubkey, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const tx = new Transaction();

    try {
      await getAccount(connection, winnerAta, "confirmed", tokenProgramId);
    } catch (_) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          escrowKeypair.publicKey,
          winnerAta,
          winnerPubkey,
          mintPubkey,
          tokenProgramId,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      );
    }

    tx.add(
      createTransferInstruction(
        escrowTokenAccount,
        winnerAta,
        escrowKeypair.publicKey,
        winnerAmountRaw,
        [],
        tokenProgramId,
      ),
    );

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = escrowKeypair.publicKey;
    tx.sign(escrowKeypair);

    const rawTx = tx.serialize();
    const payoutSig = await connection.sendRawTransaction(rawTx, { skipPreflight: false });

    // Poll for confirmation (no WebSocket dependency)
    const start = Date.now();
    while (Date.now() - start < 90000) {
      const { value } = await connection.getSignatureStatuses([payoutSig]);
      const s = value[0];
      if (s) {
        if (s.err) throw new Error("Payout tx failed: " + JSON.stringify(s.err));
        if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    await adminClient
      .from("matches")
      .update({ payout_tx: payoutSig })
      .eq("id", matchId);

    return new Response(
      JSON.stringify({ ok: true, payout_tx: payoutSig, winner_amount: winnerAmountRaw.toString(), num_players: players.length, decimals }),
      { headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  } catch (err) {
    console.error("Payout error:", err);
    return errorResponse(String(err), 500);
  }
});

function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
