// ============================================================================
// Shared payout core — verified, escrow-signed winner payout.
//
// This is the same on-chain logic f10treasurer runs when a winner claims,
// factored out so f10admin can pay a winner who never claimed (closed the tab,
// won by walkover, etc.) without duplicating the money path. It:
//   1. reserves the payout slot atomically (so it can never double-pay),
//   2. re-verifies EVERY player's deposit on-chain (amount, mint, escrow dest,
//      and the depositing wallet) — an admin cannot pay out a match whose
//      stakes were never really funded,
//   3. sends 90% of the pot from escrow to the winner,
//   4. records matches.payout_tx + a payouts row ONLY after the transfer is
//      confirmed on-chain.
//
// Kept behaviourally in sync with supabase/functions/f10treasurer/index.ts —
// edit both together if the payout math or verification changes.
// ============================================================================

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram,
} from "npm:@solana/web3.js@1.87.6";

// ---- base58 (no external dep) ---------------------------------------------
export function base58Decode(str: string): Uint8Array {
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
const B58_CHARS = /[^123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]/g;
function pubkeyFromBase58(str: string): PublicKey {
  const raw = base58Decode(str.replace(B58_CHARS, ""));
  if (raw.length > 32) throw new Error(`base58 too long: ${raw.length} bytes`);
  const padded = new Uint8Array(32);
  padded.set(raw, 32 - raw.length);
  return new PublicKey(padded);
}

// ---- SPL helpers (no @solana/spl-token dep) --------------------------------
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bj");

async function getATA(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey): Promise<PublicKey> {
  const [address] = await PublicKey.findProgramAddress(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}
function transferInstruction(source: PublicKey, dest: PublicKey, owner: PublicKey, amount: bigint, tokenProgram: PublicKey): TransactionInstruction {
  const data = new Uint8Array(9);
  data[0] = 3;
  const lo = Number(amount & BigInt(0xffffffff));
  const hi = Number(amount >> BigInt(32));
  new DataView(data.buffer).setUint32(1, lo, true);
  new DataView(data.buffer).setUint32(5, hi, true);
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}
function createATAInstruction(payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array(0),
  });
}

// ---- RPC pool --------------------------------------------------------------
function getRpcUrls(env: (k: string) => string | undefined): string[] {
  const urls = [env("RPC_URL"), env("RPC_URL_2"), env("RPC_URL_3")]
    .map((u) => u?.trim()).filter((u): u is string => !!u);
  const unique = [...new Set(urls)];
  return unique.length ? unique : ["https://api.mainnet-beta.solana.com"];
}
function createRpcPool(env: (k: string) => string | undefined, commitment: "confirmed" | "finalized" = "confirmed") {
  const conns = getRpcUrls(env).map((u) => new Connection(u, commitment));
  let idx = Math.floor(Math.random() * conns.length);
  const next = () => { const c = conns[idx]; idx = (idx + 1) % conns.length; return c; };
  return {
    lease: () => next(),
    async run<T>(fn: (c: Connection) => Promise<T>): Promise<T> {
      let lastErr: unknown;
      for (let i = 0; i < conns.length; i++) {
        try { return await fn(next()); } catch (err) { lastErr = err; }
      }
      throw lastErr;
    },
  };
}

export interface PayoutResult {
  ok: true;
  payout_tx: string;
  winner_amount: string;
  num_players: number;
  decimals: number;
}

// payoutWinner — pay the recorded winner of a finished match from escrow.
// `admin` must be a SERVICE-ROLE client. Throws Error(<reason>) on any failure;
// the caller maps that to an error response. Slot reservation + rollback mirror
// f10treasurer so a failed send never strands the slot as 'pending'.
export async function payoutWinner(
  admin: SupabaseClient,
  matchId: string,
  env: (k: string) => string | undefined,
): Promise<PayoutResult> {
  // ── Validate match state ──────────────────────────────────────────────────
  const { data: matchRow, error: matchErr } = await admin
    .from("matches").select("id, status, winner_user_id, payout_tx").eq("id", matchId).maybeSingle();
  if (matchErr || !matchRow) throw new Error("Match not found");
  if (matchRow.status !== "finished") throw new Error(`Match is '${matchRow.status}', not finished`);
  if (!matchRow.winner_user_id) throw new Error("Match has no winner");
  if (matchRow.payout_tx && matchRow.payout_tx !== "pending") throw new Error(`Already paid (${matchRow.payout_tx})`);
  const winnerId = matchRow.winner_user_id as string;

  // ── Verify all deposits recorded ─────────────────────────────────────────
  const { data: players, error: playersErr } = await admin
    .from("match_players").select("user_id, deposit_tx, deposit_wallet").eq("match_id", matchId);
  if (playersErr || !players || players.length === 0) throw new Error("Could not fetch match players");
  const missing = players.filter((p) => !p.deposit_tx);
  if (missing.length > 0) throw new Error(`${missing.length} player(s) have no recorded deposit`);

  const walletByUser = new Map<string, string>(
    players.map((p) => [p.user_id, ((p.deposit_wallet ?? "").split(":").pop() ?? "").trim()]),
  );

  const { data: profile } = await admin
    .from("profiles").select("wallet_address").eq("user_id", winnerId).maybeSingle();
  if (!profile?.wallet_address) throw new Error("Winner wallet address not found");

  // ── Escrow / mint config ─────────────────────────────────────────────────
  const escrowB58 = env("ESCROW_PRIVATE_KEY");
  const mintStr = env("FIGHT10_MINT");
  if (!escrowB58 || !mintStr) throw new Error("Escrow configuration missing (ESCROW_PRIVATE_KEY / FIGHT10_MINT)");

  const escrowKeypair = Keypair.fromSecretKey(base58Decode(escrowB58.replace(B58_CHARS, "")));
  const mintPubkey = pubkeyFromBase58(mintStr.replace(B58_CHARS, ""));
  const rawWallet = (profile.wallet_address ?? "").split(":").pop() ?? "";
  if (!rawWallet) throw new Error("Winner wallet address invalid");
  const winnerPubkey = pubkeyFromBase58(rawWallet);
  const rpc = createRpcPool(env, "confirmed");

  const mintAcct = await rpc.run((c) => c.getAccountInfo(mintPubkey));
  if (!mintAcct) throw new Error("Mint account not found on-chain");
  const tokenProgramId = mintAcct.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const decimals = mintAcct.data[44];
  const entryFeeRaw = BigInt(2500) * BigInt(10 ** decimals);
  const entryFeeAmtStr = entryFeeRaw.toString();
  const tokenProgStr = tokenProgramId.toString();
  const tok2022Str = TOKEN_2022_PROGRAM_ID.toString();

  const escrowAccounts = await rpc.run((c) => c.getParsedTokenAccountsByOwner(escrowKeypair.publicKey, { mint: mintPubkey }));
  if (escrowAccounts.value.length === 0) throw new Error("Escrow has no token account for this mint");
  const escrowTokenAccount = new PublicKey(escrowAccounts.value[0].pubkey);
  const escrowAtaStr = escrowTokenAccount.toString();

  // ── Verify each deposit confirmed + valid transfer to escrow ─────────────
  const depositSigs = players.map((p) => p.deposit_tx as string);
  const { value: sigStatuses } = await rpc.run((c) => c.getSignatureStatuses(depositSigs));
  for (let i = 0; i < depositSigs.length; i++) {
    const s = sigStatuses[i];
    if (!s) throw new Error(`Deposit ${i + 1} not found on-chain`);
    if (s.err) throw new Error(`Deposit ${i + 1} failed on-chain`);
    if (s.confirmationStatus !== "confirmed" && s.confirmationStatus !== "finalized") {
      throw new Error(`Deposit ${i + 1} not yet confirmed`);
    }
  }
  const parsedTxs = await Promise.all(
    depositSigs.map((sig) => rpc.run((c) => c.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))),
  );
  for (let i = 0; i < depositSigs.length; i++) {
    const parsed = parsedTxs[i];
    if (!parsed) throw new Error(`Deposit ${i + 1} could not be parsed`);
    const expectedSenderRaw = walletByUser.get(players[i].user_id);
    if (!expectedSenderRaw) throw new Error(`Deposit ${i + 1}: depositing wallet was not recorded at join time`);
    let expectedSender: string;
    try { expectedSender = pubkeyFromBase58(expectedSenderRaw).toBase58(); }
    catch { throw new Error(`Deposit ${i + 1}: depositor wallet invalid`); }

    const topLevel = parsed.transaction.message.instructions as any[];
    const inner = (parsed.meta?.innerInstructions ?? []).flatMap((ii: any) => ii.instructions);
    const valid = [...topLevel, ...inner].some((ix: any) => {
      const prog = ix.programId?.toString();
      if (prog !== tokenProgStr && prog !== tok2022Str) return false;
      if (!ix.parsed) return false;
      const { type, info } = ix.parsed;
      const senderRaw = info.authority ?? info.multisigAuthority;
      if (!senderRaw) return false;
      let sender: string;
      try { sender = pubkeyFromBase58(senderRaw).toBase58(); } catch { return false; }
      if (sender !== expectedSender) return false;
      if (type === "transfer") return info.destination === escrowAtaStr && info.amount === entryFeeAmtStr;
      if (type === "transferChecked") return info.destination === escrowAtaStr && info.tokenAmount?.amount === entryFeeAmtStr;
      return false;
    });
    if (!valid) throw new Error(`Deposit ${i + 1} does not contain a valid FIGHT10 transfer from the player to escrow`);
  }

  // ── Reserve the payout slot atomically (service role; no winner JWT) ──────
  // Replicates claim_payout_slot()'s guard: claim only when unpaid, or when a
  // prior 'pending' reservation is >10 min stale. Returns the row so we can
  // tell whether WE reserved it (0 rows ⇒ someone else holds it / already paid).
  const staleCutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: reserved, error: reserveErr } = await admin
    .from("matches")
    .update({ payout_tx: "pending", payout_claimed_at: new Date().toISOString() })
    .eq("id", matchId).eq("status", "finished").eq("winner_user_id", winnerId)
    .or(`payout_tx.is.null,and(payout_tx.eq.pending,payout_claimed_at.lt.${staleCutoff})`)
    .select("id");
  if (reserveErr) throw new Error("Could not reserve payout slot");
  if (!reserved || reserved.length === 0) throw new Error("Payout already in progress or completed");

  let payoutConfirmed = false;
  try {
    const totalRaw = BigInt(players.length) * entryFeeRaw;
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

    const payConn = rpc.lease();
    const { blockhash } = await payConn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = escrowKeypair.publicKey;
    tx.sign(escrowKeypair);

    const payoutSig = await payConn.sendRawTransaction(tx.serialize(), { skipPreflight: false });

    const deadline = Date.now() + 90000;
    let confirmed = false;
    while (Date.now() < deadline) {
      const { value } = await payConn.getSignatureStatuses([payoutSig]);
      const s = value[0];
      if (s?.err) throw new Error("Payout tx failed: " + JSON.stringify(s.err));
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") { confirmed = true; break; }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!confirmed) throw new Error(`Payout tx not confirmed after 90s — sig: ${payoutSig}`);
    payoutConfirmed = true;

    // Confirmed on-chain — now (and only now) record the signature. Retry the
    // DB write so a transient failure after a real transfer can't clear the slot.
    let dbWritten = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
      const { error: writeErr } = await admin.from("matches").update({ payout_tx: payoutSig }).eq("id", matchId);
      if (!writeErr) { dbWritten = true; break; }
      console.error(`[payout] DB write attempt ${attempt + 1} failed:`, writeErr);
    }
    if (!dbWritten) {
      console.error(`[payout] CRITICAL: tx ${payoutSig} confirmed but DB update failed for match ${matchId}. Manual resolution required.`);
      throw new Error(`Payout sent on-chain (${payoutSig}) but internal record failed. Set payout_tx manually.`);
    }

    // Durable audit row (best-effort; matches.payout_tx is source of truth).
    try {
      await admin.from("payouts").upsert({
        match_id: matchId, winner_user_id: winnerId, payout_tx: payoutSig,
        amount_raw: winnerAmountRaw.toString(), decimals, num_players: players.length,
      }, { onConflict: "match_id" });
    } catch (e) { console.error("[payout] payouts insert failed (non-fatal):", e); }

    console.log(`[payout] paid match=${matchId} tx=${payoutSig} amount=${winnerAmountRaw.toString()} players=${players.length}`);
    return { ok: true, payout_tx: payoutSig, winner_amount: winnerAmountRaw.toString(), num_players: players.length, decimals };
  } catch (err) {
    // Release the reservation ONLY if the transfer did not confirm — otherwise a
    // retry could double-pay. When confirmed-but-record-failed we leave 'pending'.
    if (!payoutConfirmed) {
      try {
        await admin.from("matches").update({ payout_tx: null, payout_claimed_at: null })
          .eq("id", matchId).eq("payout_tx", "pending");
      } catch (_) { /* best-effort */ }
    }
    throw err;
  }
}
