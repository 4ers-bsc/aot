// Supabase Edge Function: payout
// Triggered by the match winner after finish_match() resolves.
// Verifies the result, then sends 90% of the pot to the winner's wallet via SPL transfer.
// 10% remains in the escrow/treasury wallet.
//
// Required Supabase secrets:
//   ESCROW_PRIVATE_KEY  — base58 keypair of the escrow wallet
//   FIGHT10_MINT        — SPL token mint address
//   RPC_URL             — Solana RPC endpoint (e.g. https://api.mainnet-beta.solana.com)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "https://esm.sh/@solana/web3.js@1";
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "https://esm.sh/@solana/spl-token@0.3";
import bs58 from "https://esm.sh/bs58@5";

const ENTRY_FEE = 2_500_000_000n; // 2500 FIGHT10, 6 decimals → base units
const TREASURY_CUT = 0.1;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    // ---------- Auth: verify caller via Supabase JWT ----------
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("missing_auth");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Client acting as the caller (respects RLS / JWT)
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !user) throw new Error("invalid_token");

    // Service client for privileged reads & writes
    const adminClient = createClient(supabaseUrl, serviceKey);

    // ---------- Validate request body ----------
    const { match_id } = await req.json();
    if (!match_id) throw new Error("missing_match_id");

    // ---------- Verify match result ----------
    const { data: match, error: matchErr } = await adminClient
      .from("matches")
      .select("id, status, winner_user_id, max_players, pot_tokens, payout_tx")
      .eq("id", match_id)
      .single();
    if (matchErr || !match) throw new Error("match_not_found");
    if (match.status !== "finished") throw new Error("match_not_finished");
    if (match.winner_user_id !== user.id) throw new Error("caller_not_winner");
    if (match.payout_tx) throw new Error("already_paid_out");

    // ---------- Fetch winner wallet address ----------
    const { data: profile, error: profileErr } = await adminClient
      .from("profiles")
      .select("wallet_address")
      .eq("user_id", user.id)
      .single();
    if (profileErr || !profile?.wallet_address) throw new Error("winner_wallet_not_found");

    // ---------- Verify all deposits are recorded ----------
    const { data: players, error: playersErr } = await adminClient
      .from("match_players")
      .select("user_id, deposit_tx")
      .eq("match_id", match_id);
    if (playersErr) throw new Error("could_not_fetch_players");

    const undeposited = (players || []).filter((p) => !p.deposit_tx);
    if (undeposited.length > 0) throw new Error("missing_deposits");

    // ---------- Calculate payout ----------
    const numPlayers = BigInt(players!.length);
    const totalPot = ENTRY_FEE * numPlayers;
    const winnerAmount = BigInt(Math.floor(Number(totalPot) * (1 - TREASURY_CUT)));

    // ---------- Build & send SPL transfer ----------
    const rpcUrl = Deno.env.get("RPC_URL") || "https://api.mainnet-beta.solana.com";
    const escrowKeyRaw = Deno.env.get("ESCROW_PRIVATE_KEY");
    if (!escrowKeyRaw) throw new Error("escrow_key_not_configured");

    const mintAddress = Deno.env.get("FIGHT10_MINT");
    if (!mintAddress) throw new Error("mint_not_configured");

    const connection = new Connection(rpcUrl, "confirmed");
    const escrowKeypair = Keypair.fromSecretKey(bs58.decode(escrowKeyRaw));
    const mint = new PublicKey(mintAddress);
    const winnerPubkey = new PublicKey(profile.wallet_address);

    // Get or create winner's ATA (escrow pays rent)
    const winnerAta = await getOrCreateAssociatedTokenAccount(
      connection,
      escrowKeypair,
      mint,
      winnerPubkey,
    );

    const escrowAta = await getAssociatedTokenAddress(mint, escrowKeypair.publicKey);

    const tx = new Transaction().add(
      createTransferInstruction(
        escrowAta,
        winnerAta.address,
        escrowKeypair.publicKey,
        winnerAmount,
        [],
        TOKEN_PROGRAM_ID,
      ),
    );

    tx.feePayer = escrowKeypair.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(escrowKeypair);

    const payoutSig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(payoutSig, "confirmed");

    // ---------- Record payout tx on match ----------
    await adminClient.rpc("record_payout_tx", {
      p_match_id: match_id,
      p_payout_tx: payoutSig,
    });

    return new Response(
      JSON.stringify({ ok: true, payout_tx: payoutSig, winner_amount: winnerAmount.toString() }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("payout error:", msg);
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});
