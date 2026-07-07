// ============================================================================
// f10admin — internal operations dashboard gateway.
//
// One authenticated, admin-gated endpoint the operator UI (src/admin.js) calls
// to (a) READ every operational queue that can leave a real user stuck, and
// (b) RESOLVE them — so nobody has to open the Supabase table editor by hand.
//
// Queues surfaced:
//   • disputed matches            (matches.status = 'disputed')
//   • integrity flags             (integrity_signals)
//   • payout pending              (finished + winner, payout_tx null / 'pending')
//   • payout failed / stuck       (payout_tx = 'pending' older than the retry window)
//   • consumed deposits           (consumed_deposits ledger)
//   • stale waiting rooms         (status = 'waiting', open past a grace window)
//   • banned users                (banned_users)
//   • manual review notes         (review_notes)
//
// Auth model: mirrors f10join / f10treasurer. The caller's JWT is verified
// (userClient.auth.getUser()); the user id is then checked against the
// ADMIN_USER_IDS allowlist (and optionally ADMIN_WALLETS). Everything the
// endpoint reads/writes runs through the service-role client, so admin identity
// lives entirely in the function's env — no admin flag in the database, nothing
// for a browser to escalate. Non-admins get 403.
//
// Required Supabase secrets:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (auto-provided)
//   ADMIN_USER_IDS   comma-separated auth user UUIDs allowed to use this tool
//   ADMIN_WALLETS    (optional) comma-separated wallet addresses, also allowed
//   APP_ORIGIN       (recommended) locks CORS to the game origin
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram,
} from "npm:@solana/web3.js@1.87.6";

const appOrigin = Deno.env.get("APP_ORIGIN");
if (!appOrigin) {
  console.error("WARNING: APP_ORIGIN not set — CORS is open to all origins. Set it in Supabase secrets for production.");
}
const corsHeaders = {
  "Access-Control-Allow-Origin": appOrigin || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
const fail = (error: string, status = 200) => json({ ok: false, error }, status);

// Windows that define "stale" / "stuck". Kept here so the dashboard and any
// future sweeper agree on the same thresholds.
const STALE_WAITING_MINUTES = 15;   // a lobby open this long with empty seats
const PAYOUT_STUCK_MINUTES   = 15;   // a 'pending' payout reservation this old
const LIST_LIMIT = 100;

const norm = (w?: string | null) => ((w ?? "").split(":").pop() ?? "").trim().toLowerCase();
const csv = (v?: string | null) =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// ============================================================================
// Verified escrow-signed winner payout. Same on-chain logic f10treasurer runs
// on a winner claim, inlined here (Supabase deploys a function's own folder, so
// a shared sibling import can't be bundled) so f10admin can pay a winner who
// never claimed. Kept behaviourally in sync with f10treasurer/index.ts — edit
// both together if the payout math or deposit verification changes.
// ============================================================================
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
const B58_CHARS = /[^123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]/g;
function pubkeyFromBase58(str: string): PublicKey {
  const raw = base58Decode(str.replace(B58_CHARS, ""));
  if (raw.length > 32) throw new Error(`base58 too long: ${raw.length} bytes`);
  const padded = new Uint8Array(32);
  padded.set(raw, 32 - raw.length);
  return new PublicKey(padded);
}

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

function getRpcUrls(): string[] {
  const urls = [Deno.env.get("RPC_URL"), Deno.env.get("RPC_URL_2"), Deno.env.get("RPC_URL_3")]
    .map((u) => u?.trim()).filter((u): u is string => !!u);
  const unique = [...new Set(urls)];
  return unique.length ? unique : ["https://api.mainnet-beta.solana.com"];
}
function createRpcPool(commitment: "confirmed" | "finalized" = "confirmed") {
  const conns = getRpcUrls().map((u) => new Connection(u, commitment));
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

// payoutWinner — pay the recorded winner of a finished match from escrow.
// `admin` must be a SERVICE-ROLE client. Throws Error(<reason>) on any failure.
// Slot reservation + rollback mirror f10treasurer so a failed send never strands
// the slot as 'pending'.
async function payoutWinner(admin: any, matchId: string) {
  const { data: matchRow, error: matchErr } = await admin
    .from("matches").select("id, status, winner_user_id, payout_tx").eq("id", matchId).maybeSingle();
  if (matchErr || !matchRow) throw new Error("Match not found");
  if (matchRow.status !== "finished") throw new Error(`Match is '${matchRow.status}', not finished`);
  if (!matchRow.winner_user_id) throw new Error("Match has no winner");
  if (matchRow.payout_tx && matchRow.payout_tx !== "pending") throw new Error(`Already paid (${matchRow.payout_tx})`);
  const winnerId = matchRow.winner_user_id as string;

  const { data: players, error: playersErr } = await admin
    .from("match_players").select("user_id, deposit_tx, deposit_wallet").eq("match_id", matchId);
  if (playersErr || !players || players.length === 0) throw new Error("Could not fetch match players");
  const missing = players.filter((p: any) => !p.deposit_tx);
  if (missing.length > 0) throw new Error(`${missing.length} player(s) have no recorded deposit`);

  const walletByUser = new Map<string, string>(
    players.map((p: any) => [p.user_id, ((p.deposit_wallet ?? "").split(":").pop() ?? "").trim()]),
  );

  const { data: profile } = await admin
    .from("profiles").select("wallet_address").eq("user_id", winnerId).maybeSingle();
  if (!profile?.wallet_address) throw new Error("Winner wallet address not found");

  const escrowB58 = Deno.env.get("ESCROW_PRIVATE_KEY");
  const mintStr = Deno.env.get("FIGHT10_MINT");
  if (!escrowB58 || !mintStr) throw new Error("Escrow configuration missing (ESCROW_PRIVATE_KEY / FIGHT10_MINT)");

  const escrowKeypair = Keypair.fromSecretKey(base58Decode(escrowB58.replace(B58_CHARS, "")));
  const mintPubkey = pubkeyFromBase58(mintStr.replace(B58_CHARS, ""));
  const rawWallet = (profile.wallet_address ?? "").split(":").pop() ?? "";
  if (!rawWallet) throw new Error("Winner wallet address invalid");
  const winnerPubkey = pubkeyFromBase58(rawWallet);
  const rpc = createRpcPool("confirmed");

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

  const depositSigs = players.map((p: any) => p.deposit_tx as string);
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

  // Reserve the slot atomically (service role; no winner JWT). Replicates
  // claim_payout_slot()'s guard: claim only when unpaid or a prior 'pending'
  // reservation is >10 min stale. 0 rows ⇒ someone else holds it / already paid.
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

    let dbWritten = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
      const { error: writeErr } = await admin.from("matches").update({ payout_tx: payoutSig }).eq("id", matchId);
      if (!writeErr) { dbWritten = true; break; }
      console.error(`[f10admin payout] DB write attempt ${attempt + 1} failed:`, writeErr);
    }
    if (!dbWritten) {
      console.error(`[f10admin payout] CRITICAL: tx ${payoutSig} confirmed but DB update failed for match ${matchId}. Manual resolution required.`);
      throw new Error(`Payout sent on-chain (${payoutSig}) but internal record failed. Set payout_tx manually.`);
    }

    try {
      await admin.from("payouts").upsert({
        match_id: matchId, winner_user_id: winnerId, payout_tx: payoutSig,
        amount_raw: winnerAmountRaw.toString(), decimals, num_players: players.length,
      }, { onConflict: "match_id" });
    } catch (e) { console.error("[f10admin payout] payouts insert failed (non-fatal):", e); }

    console.log(`[f10admin payout] paid match=${matchId} tx=${payoutSig} amount=${winnerAmountRaw.toString()} players=${players.length}`);
    return { payout_tx: payoutSig, winner_amount: winnerAmountRaw.toString(), num_players: players.length, decimals };
  } catch (err) {
    if (!payoutConfirmed) {
      try {
        await admin.from("matches").update({ payout_tx: null, payout_claimed_at: null })
          .eq("id", matchId).eq("payout_tx", "pending");
      } catch (_) { /* best-effort */ }
    }
    throw err;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const supabaseUrl        = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey    = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  try {
    // ── Authenticate the caller ──────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return fail("Missing Authorization header", 401);

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return fail("Unauthorized", 401);

    const admin = createClient(supabaseUrl, supabaseServiceKey);

    // ── Authorize: allowlisted admin only ────────────────────────────────────
    const adminIds = new Set(csv(Deno.env.get("ADMIN_USER_IDS")));
    const adminWallets = new Set(csv(Deno.env.get("ADMIN_WALLETS")).map(norm));
    if (adminIds.size === 0 && adminWallets.size === 0) {
      console.error("f10admin: no ADMIN_USER_IDS / ADMIN_WALLETS configured — refusing all access.");
      return fail("Admin dashboard is not configured.", 403);
    }
    let isAdmin = adminIds.has(user.id);
    if (!isAdmin && adminWallets.size > 0) {
      const { data: prof } = await admin
        .from("profiles").select("wallet_address").eq("user_id", user.id).maybeSingle();
      if (prof?.wallet_address && adminWallets.has(norm(prof.wallet_address))) isAdmin = true;
    }
    if (!isAdmin) {
      console.error("f10admin: rejected non-admin", { user: user.id });
      return fail("Not authorized.", 403);
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "overview");

    // Small helper: attach display names to a set of rows keyed by user id.
    const resolveNames = async (ids: (string | null | undefined)[]) => {
      const uniq = [...new Set(ids.filter((x): x is string => !!x))];
      const map = new Map<string, { name: string; wallet: string | null }>();
      if (uniq.length === 0) return map;
      const { data } = await admin
        .from("profiles").select("user_id, display_name, wallet_address").in("user_id", uniq);
      for (const p of data ?? []) {
        map.set(p.user_id, { name: p.display_name, wallet: p.wallet_address ?? null });
      }
      return map;
    };

    // Record an audit note for any mutating action.
    const logNote = (subject_type: string, subject_id: string | null, note: string, act: string) =>
      admin.from("review_notes").insert({
        subject_type, subject_id, note, action: act, author_id: user.id,
      });

    // ── Mutating actions ─────────────────────────────────────────────────────
    if (action !== "overview") {
      switch (action) {
        case "add_note": {
          const subject_type = String(body?.subject_type ?? "general");
          const subject_id = body?.subject_id != null ? String(body.subject_id) : null;
          const note = String(body?.note ?? "").trim();
          if (!note) return fail("note is required");
          const { error } = await logNote(subject_type, subject_id, note, "note");
          if (error) return fail(error.message);
          return json({ ok: true });
        }

        case "delete_note": {
          // Remove a review note (e.g. clean up the duplicate no-op notes the old
          // release_payout produced). Accepts one id or an array of ids.
          const raw = body?.id ?? body?.ids;
          const ids = (Array.isArray(raw) ? raw : [raw]).map(Number).filter((n) => Number.isFinite(n));
          if (ids.length === 0) return fail("id (or ids[]) is required");
          const { data: rows, error } = await admin.from("review_notes").delete().in("id", ids).select("id");
          if (error) return fail(error.message);
          return json({ ok: true, deleted: rows?.length ?? 0 });
        }

        case "resolve_dispute": {
          // Award a disputed match to a chosen participant, apply their stats,
          // and flip it to 'finished' so the winner can claim their payout
          // through f10treasurer (which still verifies the deposits on-chain).
          const matchId = String(body?.match_id ?? "");
          const winnerId = String(body?.winner_user_id ?? "");
          const note = String(body?.note ?? "").trim();
          if (!matchId || !winnerId) return fail("match_id and winner_user_id are required");

          const { data: m } = await admin
            .from("matches").select("id, status").eq("id", matchId).maybeSingle();
          if (!m) return fail("Match not found");
          if (m.status !== "disputed") return fail(`Match is '${m.status}', not disputed`);

          const { data: seat } = await admin
            .from("match_players").select("user_id")
            .eq("match_id", matchId).eq("user_id", winnerId).maybeSingle();
          if (!seat) return fail("Chosen winner is not a participant in this match");

          const { error: upErr } = await admin.from("matches").update({
            status: "finished",
            winner_user_id: winnerId,
            shadow_winner: winnerId,
            ended_at: new Date().toISOString(),
          }).eq("id", matchId).eq("status", "disputed");
          if (upErr) return fail(upErr.message);

          // Award win/loss stats (idempotent via matches.stats_applied).
          const { error: statErr } = await admin.rpc("apply_match_result", {
            p_match_id: matchId, p_winner_id: winnerId,
          });
          if (statErr) console.error("apply_match_result failed:", statErr);

          await logNote("match", matchId,
            note || `Dispute resolved: awarded to ${winnerId}.`, "resolve_dispute");
          return json({ ok: true });
        }

        case "void_match": {
          // Close a disputed match with no winner (no payout). Use when no clean
          // winner can be determined — the pot stays in escrow for manual handling.
          const matchId = String(body?.match_id ?? "");
          const note = String(body?.note ?? "").trim();
          if (!matchId) return fail("match_id is required");
          const { data: rows, error } = await admin.from("matches").update({
            status: "finished", winner_user_id: null, ended_at: new Date().toISOString(),
          }).eq("id", matchId).eq("status", "disputed").select("id");
          if (error) return fail(error.message);
          if (!rows || rows.length === 0) return fail("Match is no longer disputed — nothing to void.");
          await logNote("match", matchId, note || "Match voided (no winner).", "void_match");
          return json({ ok: true });
        }

        case "close_waiting_room": {
          // Close a stale waiting lobby so it stops showing as open.
          const matchId = String(body?.match_id ?? "");
          const note = String(body?.note ?? "").trim();
          if (!matchId) return fail("match_id is required");
          const { data: rows, error } = await admin.from("matches").update({
            status: "finished", ended_at: new Date().toISOString(),
          }).eq("id", matchId).eq("status", "waiting").select("id");
          if (error) return fail(error.message);
          if (!rows || rows.length === 0) return fail("This match is no longer waiting — nothing to close.");
          await logNote("waiting", matchId, note || "Stale waiting room closed.", "close_waiting_room");
          return json({ ok: true });
        }

        case "admin_pay_winner": {
          // Pay the recorded winner of a finished match directly from escrow —
          // for winners who never claimed (closed tab / walkover). Re-verifies
          // every deposit on-chain, reserves the slot, transfers, and records
          // the tx ONLY after on-chain confirmation (shared with f10treasurer).
          const matchId = String(body?.match_id ?? "");
          if (!matchId) return fail("match_id is required");
          try {
            const result = await payoutWinner(admin, matchId);
            const winnerAmt = (Number(result.winner_amount) / 10 ** result.decimals)
              .toLocaleString(undefined, { maximumFractionDigits: 0 });
            await logNote("payout", matchId,
              `Admin paid winner: ${winnerAmt} $FIGHT10 — tx ${result.payout_tx}`, "admin_pay_winner");
            return json({ ok: true, ...result });
          } catch (err) {
            console.error(`[f10admin] admin_pay_winner failed match=${matchId}:`, err);
            return fail(String(err?.message ?? err));
          }
        }

        case "release_payout": {
          // Clear a stuck 'pending' reservation so the winner can retry claiming.
          // Only clears while it is still 'pending' — never touches a real tx sig.
          const matchId = String(body?.match_id ?? "");
          const note = String(body?.note ?? "").trim();
          if (!matchId) return fail("match_id is required");
          const { data: rows, error } = await admin.from("matches").update({
            payout_tx: null, payout_claimed_at: null,
          }).eq("id", matchId).eq("payout_tx", "pending").select("id");
          if (error) return fail(error.message);
          // No-op guard: a null (never-claimed) payout has nothing to release.
          // Report it honestly and DON'T log a note (this was producing piles of
          // meaningless "released" notes on unclaimed matches).
          if (!rows || rows.length === 0) {
            return fail("Nothing to release — this payout isn't stuck on 'pending' (it was never claimed). Use \"Pay winner now\", or have the winner claim in-app.");
          }
          await logNote("payout", matchId, note || "Stuck payout slot released for retry.", "release_payout");
          return json({ ok: true });
        }

        case "mark_payout_resolved": {
          // Record a real, out-of-band payout signature (e.g. the operator sent
          // the transfer manually) so the match reads as paid and can't be
          // re-claimed. Only overwrites an unpaid ('pending' / null) match.
          const matchId = String(body?.match_id ?? "");
          const tx = String(body?.payout_tx ?? "").trim();
          const note = String(body?.note ?? "").trim();
          if (!matchId || !tx) return fail("match_id and payout_tx are required");
          const { data: m } = await admin
            .from("matches").select("payout_tx").eq("id", matchId).maybeSingle();
          if (!m) return fail("Match not found");
          if (m.payout_tx && m.payout_tx !== "pending") {
            return fail(`Match already has payout_tx ${m.payout_tx}`);
          }
          const { error } = await admin.from("matches").update({
            payout_tx: tx, payout_claimed_at: new Date().toISOString(),
          }).eq("id", matchId);
          if (error) return fail(error.message);
          await logNote("payout", matchId, note || `Payout marked resolved: ${tx}`, "mark_payout_resolved");
          return json({ ok: true });
        }

        case "ban_user": {
          const uid = String(body?.user_id ?? "");
          const reason = String(body?.reason ?? "manual_admin_ban").trim();
          if (!uid) return fail("user_id is required");
          const { error } = await admin.rpc("ban_user", { p_user_id: uid, p_reason: reason });
          if (error) return fail(error.message);
          await logNote("user", uid, `Banned: ${reason}`, "ban_user");
          return json({ ok: true });
        }

        case "unban_user": {
          const uid = String(body?.user_id ?? "");
          const note = String(body?.note ?? "").trim();
          if (!uid) return fail("user_id is required");
          const { data: rows, error } = await admin.from("banned_users").delete().eq("user_id", uid).select("user_id");
          if (error) return fail(error.message);
          if (!rows || rows.length === 0) return fail("User was not banned — nothing to undo.");
          await logNote("user", uid, note || "Unbanned.", "unban_user");
          return json({ ok: true });
        }

        default:
          return fail(`Unknown action '${action}'`);
      }
    }

    // ── Overview (default): read every queue in parallel ─────────────────────
    const now = Date.now();
    const staleWaitingCutoff = new Date(now - STALE_WAITING_MINUTES * 60_000).toISOString();
    const payoutStuckCutoff  = new Date(now - PAYOUT_STUCK_MINUTES * 60_000).toISOString();

    const [
      disputedRes, integrityRes, payoutPendingRes, payoutFailedRes,
      consumedRes, waitingRes, bannedRes, notesRes,
    ] = await Promise.all([
      admin.from("matches")
        .select("id, match_no, max_players, created_at, started_at, ended_at, pot_tokens, shadow_meta, forfeited_user_ids")
        .eq("status", "disputed").order("ended_at", { ascending: false, nullsFirst: false }).limit(LIST_LIMIT),
      admin.from("integrity_signals")
        .select("id, user_id, match_id, kind, detail, created_at")
        .order("created_at", { ascending: false }).limit(LIST_LIMIT),
      admin.from("matches")
        .select("id, match_no, max_players, winner_user_id, ended_at, pot_tokens, payout_tx, payout_claimed_at")
        .eq("status", "finished").not("winner_user_id", "is", null)
        .or("payout_tx.is.null,payout_tx.eq.pending")
        .order("ended_at", { ascending: false, nullsFirst: false }).limit(LIST_LIMIT),
      admin.from("matches")
        .select("id, match_no, max_players, winner_user_id, ended_at, pot_tokens, payout_tx, payout_claimed_at")
        .eq("payout_tx", "pending").lt("payout_claimed_at", payoutStuckCutoff)
        .order("payout_claimed_at", { ascending: true }).limit(LIST_LIMIT),
      admin.from("consumed_deposits")
        .select("deposit_tx, user_id, match_id, consumed_at")
        .order("consumed_at", { ascending: false }).limit(LIST_LIMIT),
      admin.from("matches")
        .select("id, match_no, max_players, created_by, created_at, pot_tokens")
        .eq("status", "waiting").lt("created_at", staleWaitingCutoff)
        .order("created_at", { ascending: true }).limit(LIST_LIMIT),
      admin.from("banned_users")
        .select("user_id, wallet, reason, created_at")
        .order("created_at", { ascending: false }).limit(LIST_LIMIT),
      admin.from("review_notes")
        .select("id, subject_type, subject_id, note, action, author_id, created_at")
        .order("created_at", { ascending: false }).limit(LIST_LIMIT),
    ]);

    const firstErr = [
      disputedRes, integrityRes, payoutPendingRes, payoutFailedRes,
      consumedRes, waitingRes, bannedRes, notesRes,
    ].find((r) => r.error)?.error;
    if (firstErr) {
      console.error("f10admin overview query failed:", firstErr);
      return fail(`Query failed: ${firstErr.message}`, 500);
    }

    const disputed = disputedRes.data ?? [];
    const integrity = integrityRes.data ?? [];
    const payoutPending = payoutPendingRes.data ?? [];
    const payoutFailed = payoutFailedRes.data ?? [];
    const consumed = consumedRes.data ?? [];
    const waiting = waitingRes.data ?? [];
    const banned = bannedRes.data ?? [];
    const notes = notesRes.data ?? [];

    // Seats for disputed + stale-waiting matches, in two batched queries.
    const disputedIds = disputed.map((m: any) => m.id);
    const waitingIds = waiting.map((m: any) => m.id);
    const [seatRes, waitSeatRes] = await Promise.all([
      disputedIds.length
        ? admin.from("match_players").select("match_id, user_id, seat, display_name, final_hp, last_seen").in("match_id", disputedIds)
        : Promise.resolve({ data: [] as any[] }),
      waitingIds.length
        ? admin.from("match_players").select("match_id, user_id, seat, display_name").in("match_id", waitingIds)
        : Promise.resolve({ data: [] as any[] }),
    ]);
    const groupByMatch = (rows: any[]) => {
      const map = new Map<string, any[]>();
      for (const s of rows) {
        const list = map.get(s.match_id);
        if (list) list.push(s);
        else map.set(s.match_id, [s]);
      }
      return map;
    };
    const seatsByMatch = groupByMatch(seatRes.data ?? []);
    const waitSeatsByMatch = groupByMatch(waitSeatRes.data ?? []);

    // Resolve display names for every user id we're about to return.
    const nameMap = await resolveNames([
      ...integrity.map((r: any) => r.user_id),
      ...payoutPending.map((r: any) => r.winner_user_id),
      ...payoutFailed.map((r: any) => r.winner_user_id),
      ...consumed.map((r: any) => r.user_id),
      ...waiting.map((r: any) => r.created_by),
      ...notes.map((r: any) => r.author_id),
    ]);
    const nameOf = (id?: string | null) => (id ? nameMap.get(id)?.name ?? null : null);

    const payoutView = (m: any) => ({
      ...m,
      winner_name: nameOf(m.winner_user_id),
      stuck_minutes: m.payout_claimed_at
        ? Math.floor((now - new Date(m.payout_claimed_at).getTime()) / 60_000)
        : null,
    });

    return json({
      ok: true,
      generated_at: new Date().toISOString(),
      thresholds: { stale_waiting_minutes: STALE_WAITING_MINUTES, payout_stuck_minutes: PAYOUT_STUCK_MINUTES },
      counts: {
        disputed: disputed.length,
        integrity: integrity.length,
        payout_pending: payoutPending.length,
        payout_failed: payoutFailed.length,
        consumed_deposits: consumed.length,
        stale_waiting: waiting.length,
        banned: banned.length,
        notes: notes.length,
      },
      disputed: disputed.map((m: any) => ({
        ...m,
        players: (seatsByMatch.get(m.id) ?? []).sort((a, b) => a.seat - b.seat),
      })),
      integrity: integrity.map((r: any) => ({ ...r, user_name: nameOf(r.user_id) })),
      payout_pending: payoutPending.map(payoutView),
      payout_failed: payoutFailed.map(payoutView),
      consumed_deposits: consumed.map((r: any) => ({ ...r, user_name: nameOf(r.user_id) })),
      stale_waiting: waiting.map((m: any) => ({
        ...m,
        creator_name: nameOf(m.created_by),
        players: (waitSeatsByMatch.get(m.id) ?? []).sort((a, b) => a.seat - b.seat),
        seats_filled: (waitSeatsByMatch.get(m.id) ?? []).length,
        open_minutes: Math.floor((now - new Date(m.created_at).getTime()) / 60_000),
      })),
      banned,
      notes: notes.map((r: any) => ({ ...r, author_name: nameOf(r.author_id) })),
    });
  } catch (err) {
    console.error("f10admin error:", err);
    return fail(String(err), 500);
  }
});
