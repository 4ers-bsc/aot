// Payout Edge Function
// Invoked by the match winner after finish_match() resolves.
// Sends 90% of the total pot from the escrow wallet to the winner's wallet.
// 10% stays in the escrow wallet as treasury.
//
// Required Supabase secrets:
//   ESCROW_PRIVATE_KEY  — base58-encoded keypair of the escrow/treasury wallet
//   FIGHT10_MINT        — SPL token mint address
//   RPC_URL             — Solana RPC endpoint (mainnet-beta)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "https://esm.sh/@solana/web3.js@1.87.6?bundle";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getMint,
  getAccount,
  TokenAccountNotFoundError,
} from "https://esm.sh/@solana/spl-token@0.3.11?bundle";
import bs58 from "https://esm.sh/bs58@5.0.0";

const TREASURY_CUT = 0.10;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    // -------------------------------------------------------------------------
    // 1. Authenticate caller via Supabase JWT
    // -------------------------------------------------------------------------
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return errorResponse("Missing Authorization header", 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // User-scoped client to verify the caller's identity
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return errorResponse("Unauthorized", 401);
    }

    // Service-role client for privileged DB writes
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // -------------------------------------------------------------------------
    // 2. Parse request body
    // -------------------------------------------------------------------------
    const body = await req.json();
    const matchId: string = body?.match_id;
    if (!matchId) {
      return errorResponse("match_id is required", 400);
    }

    // -------------------------------------------------------------------------
    // 3. Verify caller is the match winner
    // -------------------------------------------------------------------------
    const { data: matchRow, error: matchErr } = await adminClient
      .from("matches")
      .select("id, status, winner_user_id, max_players, payout_tx")
      .eq("id", matchId)
      .maybeSingle();

    if (matchErr || !matchRow) {
      return errorResponse("Match not found", 404);
    }
    if (matchRow.status !== "finished") {
      return errorResponse("Match is not finished", 400);
    }
    if (matchRow.winner_user_id !== user.id) {
      return errorResponse("Only the winner may claim the prize", 403);
    }
    if (matchRow.payout_tx) {
      return errorResponse("Prize already claimed", 409);
    }

    // -------------------------------------------------------------------------
    // 4. Verify all players deposited
    // -------------------------------------------------------------------------
    const { data: players, error: playersErr } = await adminClient
      .from("match_players")
      .select("user_id, deposit_tx")
      .eq("match_id", matchId);

    if (playersErr || !players) {
      return errorResponse("Could not fetch match players", 500);
    }
    const missing = players.filter((p) => !p.deposit_tx);
    if (missing.length > 0) {
      return errorResponse(
        `${missing.length} player(s) have not deposited — cannot pay out`,
        400,
      );
    }

    // -------------------------------------------------------------------------
    // 5. Get winner wallet address from profiles
    // -------------------------------------------------------------------------
    const { data: profile, error: profileErr } = await adminClient
      .from("profiles")
      .select("wallet_address")
      .eq("user_id", user.id)
      .maybeSingle();

    if (profileErr || !profile?.wallet_address) {
      return errorResponse("Winner wallet address not found", 400);
    }

    // -------------------------------------------------------------------------
    // 6. Load escrow keypair + mint info
    // -------------------------------------------------------------------------
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

    // Get mint decimals to compute raw units
    const mintInfo = await getMint(connection, mintPubkey);
    const decimals = mintInfo.decimals;
    const entryFeeRaw = BigInt(2500) * BigInt(10 ** decimals);

    // -------------------------------------------------------------------------
    // 7. Calculate payout amount
    // -------------------------------------------------------------------------
    const numPlayers = BigInt(players.length);
    const totalRaw = numPlayers * entryFeeRaw;
    const winnerAmountRaw = (totalRaw * BigInt(Math.round((1 - TREASURY_CUT) * 1000))) / BigInt(1000);

    // -------------------------------------------------------------------------
    // 8. Build & send SPL transfer: escrow ATA → winner ATA
    // -------------------------------------------------------------------------
    const escrowAta = await getAssociatedTokenAddress(mintPubkey, escrowKeypair.publicKey);
    const winnerAta = await getAssociatedTokenAddress(mintPubkey, winnerPubkey);

    const tx = new Transaction();

    // Create winner's ATA if it doesn't exist
    try {
      await getAccount(connection, winnerAta);
    } catch (e) {
      if (e instanceof TokenAccountNotFoundError) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            escrowKeypair.publicKey,
            winnerAta,
            winnerPubkey,
            mintPubkey,
          ),
        );
      } else {
        throw e;
      }
    }

    tx.add(
      createTransferInstruction(
        escrowAta,
        winnerAta,
        escrowKeypair.publicKey,
        winnerAmountRaw,
      ),
    );

    const payoutSig = await sendAndConfirmTransaction(connection, tx, [escrowKeypair]);

    // -------------------------------------------------------------------------
    // 9. Record payout_tx on the match row
    // -------------------------------------------------------------------------
    const { error: updateErr } = await adminClient
      .from("matches")
      .update({ payout_tx: payoutSig })
      .eq("id", matchId);

    if (updateErr) {
      console.error("Failed to record payout_tx:", updateErr);
      // Don't fail — funds already sent
    }

    return new Response(
      JSON.stringify({
        ok: true,
        payout_tx: payoutSig,
        winner_amount: winnerAmountRaw.toString(),
        num_players: players.length,
        decimals,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (err) {
    console.error("Payout error:", err);
    return errorResponse(String(err), 500);
  }
});

function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
