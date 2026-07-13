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
// Monitoring + config (read/write) actions the UI also calls here:
//   • db_stats          database health snapshot (admin_db_stats RPC)
//   • functions_health  pings each edge function's ?health=1 probe
//   • get_config        reads pvp_config / match_config / maintain
//   • set_config        edits those static constants (audited via review_notes)
//   • db_export         JSON snapshot of one table / the whole schema (download)
//   • db_wipe           TRUNCATE one table / every table (typed confirmation)
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
import { Contract, JsonRpcProvider, Wallet } from "npm:ethers@6.13.0";

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

// Cash-flow tab limits. Incoming amount is a fixed entry fee per deposit, so its
// total is exact from the count alone; outgoing amounts vary, so we sum matching
// payout rows in JS up to a cap (and flag when a narrower range is needed).
const CASHFLOW_ROWS    = 200;   // rows returned per side for the on-screen table
const CASHFLOW_SUM_CAP = 5000;  // max payout rows summed for the outgoing total
// Token decimals used only to scale dashboard amounts (the payout path reads
// the contract's decimals() on-chain). Standard ERC-20 tokens use 18; override
// with the FIGHT10_DECIMALS secret if the deployed token differs.
const TOKEN_DECIMALS = Number(Deno.env.get("FIGHT10_DECIMALS") ?? "18");
// Fixed historical entry fee for the cashflow/treasury ESTIMATE only (incoming
// totals across past seats). Deliberately NOT sourced from pvp_config: seats
// settled at whatever fee applied then, so a mutable current value would skew
// historical rows. The live deposit-validation + payout paths below read the
// entry fee from pvp_config per request.
const ENTRY_FEE_RAW  = 2500n * 10n ** BigInt(TOKEN_DECIMALS);

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

// Robinhood Chain network (mainnet). Kept in sync with src/network.js on the
// client.
const NETWORK: { name: string; chainId: number; rpcUrl: string } = {
  name: "Robinhood Chain",
  chainId: 4663,
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
};

// keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer event.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

const isAddress = (a: string) => /^0x[0-9a-f]{40}$/.test(a);
// An indexed address event topic is the address left-padded to 32 bytes.
const topicToAddr = (t?: string) => (t ? "0x" + t.slice(-40).toLowerCase() : "");

// Does this receipt contain the exact entry-fee Transfer from the player's
// wallet to escrow, emitted by OUR token contract?
function receiptHasDeposit(receipt: any, tokenAddr: string, sender: string, escrow: string, amount: bigint): boolean {
  return (receipt?.logs ?? []).some((log: any) =>
    (log.address ?? "").toLowerCase() === tokenAddr &&
    (log.topics?.[0] ?? "") === TRANSFER_TOPIC &&
    topicToAddr(log.topics?.[1]) === sender &&
    topicToAddr(log.topics?.[2]) === escrow &&
    BigInt(log.data ?? "0x0") === amount
  );
}

function getRpcUrls(): string[] {
  const urls = [Deno.env.get("RPC_URL"), Deno.env.get("RPC_URL_2"), Deno.env.get("RPC_URL_3")]
    .map((u) => u?.trim()).filter((u): u is string => !!u);
  const unique = [...new Set(urls)];
  return unique.length ? unique : [NETWORK.rpcUrl];
}
function createRpcPool() {
  const providers = getRpcUrls().map((u) =>
    new JsonRpcProvider(u, NETWORK.chainId, { staticNetwork: true }));
  let idx = Math.floor(Math.random() * providers.length);
  const next = () => { const p = providers[idx]; idx = (idx + 1) % providers.length; return p; };
  return {
    lease: () => next(),
    async run<T>(fn: (p: JsonRpcProvider) => Promise<T>): Promise<T> {
      let lastErr: unknown;
      for (let i = 0; i < providers.length; i++) {
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
    .from("matches")
    .select("id, status, winner_user_id, payout_tx, entry_fee_tokens, winner_share_bps")
    .eq("id", matchId).maybeSingle();
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
    players.map((p: any) => [p.user_id, norm(p.deposit_wallet)]),
  );

  const { data: profile } = await admin
    .from("profiles").select("wallet_address").eq("user_id", winnerId).maybeSingle();
  if (!profile?.wallet_address) throw new Error("Winner wallet address not found");

  const escrowKey = (Deno.env.get("ESCROW_PRIVATE_KEY") ?? "").trim();
  const tokenAddr = norm(Deno.env.get("FIGHT10_TOKEN"));
  if (!escrowKey || !isAddress(tokenAddr)) throw new Error("Escrow configuration missing (ESCROW_PRIVATE_KEY / FIGHT10_TOKEN)");

  const escrowWallet = new Wallet(escrowKey.startsWith("0x") ? escrowKey : "0x" + escrowKey);
  const escrowAddr = escrowWallet.address.toLowerCase();
  const winnerAddr = norm(profile.wallet_address);
  if (!isAddress(winnerAddr)) throw new Error("Winner wallet address invalid");
  const rpc = createRpcPool();

  const decimals = Number(await rpc.run((p) => new Contract(tokenAddr, ERC20_ABI, p).decimals()));
  // Entry fee + winner share are frozen onto the match at creation
  // (join_pvp_match snapshots pvp_config), so a later config edit can't change
  // how THIS match's deposits verify or its prize computes (#4). Prefer that
  // snapshot; fall back to live pvp_config for pre-snapshot matches, then to the
  // historical literals so a DB blip never strands a payout.
  const { data: cfg } = await admin
    .from("pvp_config").select("entry_fee_tokens, winner_share_bps").maybeSingle();
  const entryFeeTokens = Number(matchRow.entry_fee_tokens) > 0 ? Number(matchRow.entry_fee_tokens)
    : Number(cfg?.entry_fee_tokens) > 0 ? Number(cfg.entry_fee_tokens) : 2500;
  const winnerShareBps = Number(matchRow.winner_share_bps) > 0 ? Number(matchRow.winner_share_bps)
    : Number(cfg?.winner_share_bps) > 0 ? Number(cfg.winner_share_bps) : 9000;
  const entryFeeRaw = BigInt(entryFeeTokens) * BigInt(10) ** BigInt(decimals);

  // Receipts are queryable for the chain's full history (no status-cache
  // window like Solana's), and the Transfer log proves token contract,
  // sender, destination, and exact amount — a confirmed-but-unrelated tx
  // hash cannot pass.
  const depositTxs = players.map((p: any) => p.deposit_tx as string);
  const receipts = await Promise.all(
    depositTxs.map((tx) => rpc.run((p) => p.getTransactionReceipt(tx))),
  );
  for (let i = 0; i < depositTxs.length; i++) {
    const receipt = receipts[i];
    if (!receipt) throw new Error(`Deposit ${i + 1} not found on-chain`);
    if (receipt.status !== 1) throw new Error(`Deposit ${i + 1} failed on-chain`);
    const expectedSender = walletByUser.get(players[i].user_id) ?? "";
    if (!isAddress(expectedSender)) throw new Error(`Deposit ${i + 1}: depositing wallet was not recorded at join time`);
    if (!receiptHasDeposit(receipt, tokenAddr, expectedSender, escrowAddr, entryFeeRaw)) {
      throw new Error(`Deposit ${i + 1} does not contain a valid FIGHT10 transfer from the player to escrow`);
    }
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

  let broadcast = false;   // transfer broadcast (nonce spent)
  let escrowLocked = false;
  const escrowLockHolder = `${matchId}:${crypto.randomUUID()}`;
  try {
    // Serialise escrow usage across matches (#6): hold the single-flight lock
    // across nonce assignment + broadcast so two concurrent payouts can't grab
    // the same nonce, then release it once the tx is in the mempool.
    for (let attempt = 0; ; attempt++) {
      const { data: got } = await admin.rpc("begin_escrow_payout", { p_holder: escrowLockHolder, p_ttl_seconds: 90 });
      if (got === true) { escrowLocked = true; break; }
      if (attempt >= 20) throw new Error("Another payout is in progress — retry in a moment");
      await new Promise((r) => setTimeout(r, 1500));
    }

    const totalRaw = BigInt(players.length) * entryFeeRaw;
    const winnerAmountRaw = (totalRaw * BigInt(winnerShareBps)) / BigInt(10000);

    // Lease one provider for the whole send + confirm sequence so the tx is
    // broadcast and polled on a single endpoint.
    const payProvider = rpc.lease();
    const signer = escrowWallet.connect(payProvider);
    const token = new Contract(tokenAddr, ERC20_ABI, signer);
    const sentTx = await token.transfer(winnerAddr, winnerAmountRaw);
    const payoutSig: string = String(sentTx.hash).toLowerCase(); // #7 normalise
    broadcast = true;

    // Nonce consumed + tx broadcast — release the escrow lock for other matches.
    if (escrowLocked) {
      escrowLocked = false;
      try { await admin.rpc("end_escrow_payout", { p_holder: escrowLockHolder }); }
      catch (_) { /* best-effort; the lock's TTL frees it anyway */ }
    }

    // #5: persist the REAL hash immediately, BEFORE waiting for the receipt, so a
    // retry can never send a second transfer even if confirmation is slow.
    let hashWritten = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
      const { error: writeErr } = await admin.from("matches").update({ payout_tx: payoutSig }).eq("id", matchId);
      if (!writeErr) { hashWritten = true; break; }
      console.error(`[f10admin payout] DB hash write attempt ${attempt + 1} failed:`, writeErr);
    }

    // Poll for confirmation. REVERT ⇒ definitive failure (no tokens moved) — clear
    // the recorded hash and surface it. TIMEOUT ⇒ not definitive — keep the hash
    // and report pending rather than risk a double transfer.
    const deadline = Date.now() + 90000;
    let confirmed = false;
    let reverted = false;
    while (Date.now() < deadline) {
      const receipt = await payProvider.getTransactionReceipt(payoutSig).catch(() => null);
      if (receipt) {
        if (receipt.status !== 1) { reverted = true; break; }
        confirmed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (reverted) {
      try {
        await admin.from("matches").update({ payout_tx: null, payout_claimed_at: null })
          .eq("id", matchId).eq("payout_tx", payoutSig);
      } catch (_) { /* best-effort */ }
      throw new Error("Payout tx reverted on-chain: " + payoutSig);
    }

    if (!hashWritten) {
      // Broadcast but the hash could not be recorded. Leave the slot 'pending'
      // (NOT cleared) so a retry can't double-send; set payout_tx manually.
      console.error(`[f10admin payout] CRITICAL: tx ${payoutSig} broadcast but DB update failed for match ${matchId}. Manual resolution required.`);
      throw new Error(`Payout sent on-chain (${payoutSig}) but internal record failed. Set payout_tx manually.`);
    }

    // supabase-js reports failures via the returned error, not by throwing —
    // check it explicitly or a failed ledger write vanishes without a trace.
    const { error: ledgerErr } = await admin.from("payouts").upsert({
      match_id: matchId, winner_user_id: winnerId, payout_tx: payoutSig,
      amount_raw: winnerAmountRaw.toString(), decimals, num_players: players.length,
    }, { onConflict: "match_id" });
    if (ledgerErr) console.error("[f10admin payout] payouts insert failed (non-fatal):", ledgerErr);

    console.log(`[f10admin payout] paid match=${matchId} tx=${payoutSig} amount=${winnerAmountRaw.toString()} players=${players.length} confirmed=${confirmed}`);
    return { payout_tx: payoutSig, winner_amount: winnerAmountRaw.toString(), num_players: players.length, decimals, confirmed };
  } catch (err) {
    // Release the escrow lock if still held (error before/around broadcast).
    if (escrowLocked) {
      try { await admin.rpc("end_escrow_payout", { p_holder: escrowLockHolder }); } catch (_) { /* TTL frees it */ }
    }
    // Only release the slot if the tx was NOT broadcast — clearing after a
    // broadcast could double-pay on retry.
    if (!broadcast) {
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

  // Unauthenticated health probe (…/f10admin?health=1). Lets the dashboard's
  // "Edge functions" tab report this function's own reachability + config the
  // same way it does for the others. Booleans / public addresses only.
  if (new URL(req.url).searchParams.has("health")) {
    let escrowAddr: string | null = null;
    const escrowKey = (Deno.env.get("ESCROW_PRIVATE_KEY") ?? "").trim();
    if (escrowKey) {
      try {
        escrowAddr = new Wallet(escrowKey.startsWith("0x") ? escrowKey : "0x" + escrowKey)
          .address.toLowerCase();
      } catch (_) { /* malformed key */ }
    }
    return json({
      ok: true,
      service: "f10admin",
      time: new Date().toISOString(),
      config: {
        escrow_key_set: !!escrowKey,
        escrow_wallet:  escrowAddr,
        token:          norm(Deno.env.get("FIGHT10_TOKEN")) || null,
        rpc_endpoints:  getRpcUrls().length,
        admins_configured: csv(Deno.env.get("ADMIN_USER_IDS")).length + csv(Deno.env.get("ADMIN_WALLETS")).length,
        app_origin_set: !!appOrigin,
      },
    });
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
        case "cashflow": {
          // Money in vs money out, with optional date-range + wallet filters.
          // Incoming = player entry-fee deposits recorded on seats (fixed fee
          // each — total is exact from the count). Outgoing = winner payouts
          // from the payouts ledger (variable amount, summed over matching rows).
          const fromRaw = String(body?.from ?? "").trim();
          const toRaw   = String(body?.to ?? "").trim();
          const walletTail = (String(body?.wallet ?? "").split(":").pop() ?? "").trim();

          // Accept a date (YYYY-MM-DD → inclusive UTC day bounds) or a full ISO
          // string. Returns null when absent, undefined when unparseable.
          const dayIso = (raw: string, endOfDay: boolean): string | null | undefined => {
            if (!raw) return null;
            const s = raw.length <= 10
              ? `${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
              : raw;
            const d = new Date(s);
            return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
          };
          const fromIso = dayIso(fromRaw, false);
          const toIso   = dayIso(toRaw, true);
          if (fromIso === undefined) return fail("Invalid 'from' date");
          if (toIso === undefined)   return fail("Invalid 'to' date");

          // The payouts ledger has no wallet column, so a wallet filter for
          // outgoing maps to the set of winner user ids whose profile wallet
          // matches. No matching profile ⇒ no payouts.
          let winnerIds: string[] | null = null;
          if (walletTail) {
            const { data: profs, error: profErr } = await admin
              .from("profiles").select("user_id").ilike("wallet_address", `%${walletTail}%`);
            if (profErr) return fail(profErr.message);
            winnerIds = (profs ?? []).map((p: any) => p.user_id);
          }
          const emptyGuard = ["00000000-0000-0000-0000-000000000000"];
          const applyRange = (q: any, col: string) => {
            if (fromIso) q = q.gte(col, fromIso);
            if (toIso)   q = q.lte(col, toIso);
            return q;
          };

          // Incoming: exact count (× fixed fee) + latest rows for the table.
          let inCountQ = admin.from("match_players")
            .select("match_id", { count: "exact", head: true }).not("deposit_tx", "is", null);
          inCountQ = applyRange(inCountQ, "joined_at");
          if (walletTail) inCountQ = inCountQ.ilike("deposit_wallet", `%${walletTail}%`);

          let inRowsQ = admin.from("match_players")
            .select("match_id, user_id, display_name, joined_at, deposit_tx, deposit_wallet")
            .not("deposit_tx", "is", null)
            .order("joined_at", { ascending: false }).limit(CASHFLOW_ROWS);
          inRowsQ = applyRange(inRowsQ, "joined_at");
          if (walletTail) inRowsQ = inRowsQ.ilike("deposit_wallet", `%${walletTail}%`);

          // Outgoing: exact count + rows up to the sum cap (summed in JS).
          let outCountQ = admin.from("payouts").select("match_id", { count: "exact", head: true });
          outCountQ = applyRange(outCountQ, "created_at");
          if (winnerIds) outCountQ = outCountQ.in("winner_user_id", winnerIds.length ? winnerIds : emptyGuard);

          let outRowsQ = admin.from("payouts")
            .select("match_id, winner_user_id, payout_tx, amount_raw, decimals, num_players, created_at")
            .order("created_at", { ascending: false }).limit(CASHFLOW_SUM_CAP);
          outRowsQ = applyRange(outRowsQ, "created_at");
          if (winnerIds) outRowsQ = outRowsQ.in("winner_user_id", winnerIds.length ? winnerIds : emptyGuard);

          const [inCountRes, inRowsRes, outCountRes, outRowsRes] = await Promise.all([
            inCountQ, inRowsQ, outCountQ, outRowsQ,
          ]);
          const cfErr = [inCountRes, inRowsRes, outCountRes, outRowsRes].find((r: any) => r.error)?.error;
          if (cfErr) return fail(`Query failed: ${cfErr.message}`, 500);

          const inCount    = inCountRes.count ?? 0;
          const outRows    = outRowsRes.data ?? [];
          const outCount   = outCountRes.count ?? outRows.length;
          const inTotalRaw  = BigInt(inCount) * ENTRY_FEE_RAW;
          const outTotalRaw = outRows.reduce((acc: bigint, r: any) => acc + BigInt(r.amount_raw ?? 0), 0n);

          const outNames = await resolveNames(outRows.map((r: any) => r.winner_user_id));

          // Winners whose profile has no wallet_address recorded: fall back to
          // the wallet that signed their deposit for that match (the seat row).
          const outSeatWallets = new Map<string, string>();
          {
            const missingIds = [...new Set(outRows
              .filter((r: any) => !outNames.get(r.winner_user_id)?.wallet)
              .map((r: any) => r.match_id))];
            if (missingIds.length) {
              const { data: seats } = await admin
                .from("match_players").select("match_id, user_id, deposit_wallet").in("match_id", missingIds);
              for (const s of seats ?? []) {
                if (s.deposit_wallet) outSeatWallets.set(`${s.match_id}:${s.user_id}`, s.deposit_wallet);
              }
            }
          }

          return json({
            ok: true,
            filters: { from: fromRaw, to: toRaw, wallet: walletTail },
            decimals: TOKEN_DECIMALS,
            incoming: {
              count: inCount,
              total_raw: inTotalRaw.toString(),
              rows: (inRowsRes.data ?? []).map((r: any) => ({
                joined_at: r.joined_at,
                display_name: r.display_name,
                user_id: r.user_id,
                deposit_wallet: r.deposit_wallet,
                deposit_tx: r.deposit_tx,
                match_id: r.match_id,
                amount_raw: ENTRY_FEE_RAW.toString(),
              })),
            },
            outgoing: {
              count: outCount,
              total_raw: outTotalRaw.toString(),
              truncated: outCount > outRows.length,
              rows: outRows.slice(0, CASHFLOW_ROWS).map((r: any) => ({
                created_at: r.created_at,
                winner_user_id: r.winner_user_id,
                winner_name: outNames.get(r.winner_user_id)?.name ?? null,
                winner_wallet: outNames.get(r.winner_user_id)?.wallet
                  ?? outSeatWallets.get(`${r.match_id}:${r.winner_user_id}`) ?? null,
                num_players: r.num_players,
                amount_raw: String(r.amount_raw ?? "0"),
                decimals: r.decimals ?? TOKEN_DECIMALS,
                payout_tx: r.payout_tx,
                match_id: r.match_id,
              })),
            },
            net_raw: (inTotalRaw - outTotalRaw).toString(),
          });
        }

        case "match_detail": {
          // Full drill-down for one match: the row itself (incl. the economics
          // snapshot), every seat with its deposit, the payout ledger row, the
          // review notes filed against it, and the combat ledger totals. Powers
          // the dashboard's clickable match-id detail modal. Read-only.
          const matchId = String(body?.match_id ?? "");
          if (!matchId) return fail("match_id is required");
          const [mRes, seatsRes, payRes, notesRes, dmgRes, killRes] = await Promise.all([
            admin.from("matches")
              .select("id, match_no, status, max_players, created_by, winner_user_id, created_at, started_at, ended_at, pot_tokens, payout_tx, payout_claimed_at, stats_applied, entry_fee_tokens, winner_share_bps, duration_seconds, economics_version, forfeited_user_ids")
              .eq("id", matchId).maybeSingle(),
            admin.from("match_players")
              .select("user_id, seat, display_name, joined_at, deposit_tx, deposit_wallet, final_hp, last_seen")
              .eq("match_id", matchId).order("seat", { ascending: true }),
            admin.from("payouts")
              .select("payout_tx, amount_raw, decimals, num_players, winner_user_id, created_at")
              .eq("match_id", matchId).maybeSingle(),
            admin.from("review_notes")
              .select("id, subject_type, note, action, author_id, created_at")
              .eq("subject_id", matchId).order("created_at", { ascending: false }).limit(50),
            admin.from("match_damage")
              .select("attacker, victim, total_damage, hit_count").eq("match_id", matchId),
            admin.from("match_kills")
              .select("attacker, victim, t_ms").eq("match_id", matchId),
          ]);
          const dErr = [mRes, seatsRes, payRes, notesRes, dmgRes, killRes].find((r: any) => r.error)?.error;
          if (dErr) return fail(`match_detail failed: ${dErr.message}`, 500);
          if (!mRes.data) return fail("Match not found", 404);

          const seats = seatsRes.data ?? [];
          const nameMap = await resolveNames([
            mRes.data.winner_user_id, mRes.data.created_by,
            ...seats.map((s: any) => s.user_id),
            ...(notesRes.data ?? []).map((n: any) => n.author_id),
          ]);
          const nm = (id?: string | null) => (id ? nameMap.get(id)?.name ?? null : null);
          const wl = (id?: string | null) => (id ? nameMap.get(id)?.wallet ?? null : null);

          return json({
            ok: true,
            match: mRes.data,
            created_by_name: nm(mRes.data.created_by),
            winner_name: nm(mRes.data.winner_user_id),
            winner_wallet: wl(mRes.data.winner_user_id),
            players: seats.map((s: any) => ({ ...s, name: nm(s.user_id) })),
            payout: payRes.data ?? null,
            notes: (notesRes.data ?? []).map((n: any) => ({ ...n, author_name: nm(n.author_id) })),
            damage: dmgRes.data ?? [],
            kills: killRes.data ?? [],
          });
        }

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

          // Status flip + stats apply happen inside one transaction (the
          // admin_resolve_dispute RPC) so they can never land half-applied.
          // It re-validates 'disputed' status and participant membership under a
          // row lock, surfacing a friendly message for each failure mode.
          const { error: rpcErr } = await admin.rpc("admin_resolve_dispute", {
            p_match_id: matchId, p_winner_id: winnerId,
          });
          if (rpcErr) {
            const msg = rpcErr.message || "";
            if (msg.includes("match_not_found")) return fail("Match not found");
            if (msg.includes("not_disputed")) return fail(`Match is '${msg.split("not_disputed:")[1] ?? "not disputed"}', not disputed`);
            if (msg.includes("winner_not_participant")) return fail("Chosen winner is not a participant in this match");
            return fail(msg);
          }

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
          // re-claimed. Only overwrites an unpaid ('pending' / null) match, and
          // the supplied hash is VERIFIED on-chain first — it must be a confirmed
          // FIGHT10 transfer from escrow to the winner for at least the winner's
          // share, so an arbitrary/typo'd string can never mark a match paid.
          const matchId = String(body?.match_id ?? "");
          // Normalise to lowercase (#7) so the stored payout hash matches the
          // casing every other path writes, keeping the column consistent.
          const tx = String(body?.payout_tx ?? "").trim().toLowerCase();
          const note = String(body?.note ?? "").trim();
          if (!matchId || !tx) return fail("match_id and payout_tx are required");
          if (!/^0x[0-9a-f]{64}$/.test(tx)) return fail("payout_tx is not a valid transaction hash");
          const { data: m } = await admin
            .from("matches").select("payout_tx, status, winner_user_id, max_players").eq("id", matchId).maybeSingle();
          if (!m) return fail("Match not found");
          if (m.payout_tx && m.payout_tx !== "pending") {
            return fail(`Match already has payout_tx ${m.payout_tx}`);
          }
          if (m.status !== "finished" || !m.winner_user_id) {
            return fail("Match is not finished with a winner — nothing to mark paid.");
          }

          // Resolve the winner wallet + expected minimum payout, then verify the
          // hash actually moved that from escrow to the winner on-chain. Reuses
          // the same inline chain helpers as payoutWinner (above).
          try {
            const { data: prof } = await admin
              .from("profiles").select("wallet_address").eq("user_id", m.winner_user_id).maybeSingle();
            const winnerAddr = norm(prof?.wallet_address);
            if (!isAddress(winnerAddr)) return fail("Winner wallet address not found/invalid — cannot verify the transfer.");

            const { data: seats } = await admin
              .from("match_players").select("user_id").eq("match_id", matchId);
            const numPlayers = seats?.length ?? m.max_players ?? 0;
            if (numPlayers <= 0) return fail("Could not determine the match's player count.");

            const escrowKey = (Deno.env.get("ESCROW_PRIVATE_KEY") ?? "").trim();
            const tokenAddr = norm(Deno.env.get("FIGHT10_TOKEN"));
            if (!escrowKey || !isAddress(tokenAddr)) return fail("Escrow configuration missing (ESCROW_PRIVATE_KEY / FIGHT10_TOKEN)");
            const escrowAddr = new Wallet(escrowKey.startsWith("0x") ? escrowKey : "0x" + escrowKey).address.toLowerCase();

            const rpc = createRpcPool();
            const decimals = Number(await rpc.run((p) => new Contract(tokenAddr, ERC20_ABI, p).decimals()));
            const { data: cfg } = await admin
              .from("pvp_config").select("entry_fee_tokens, winner_share_bps").maybeSingle();
            const entryFeeTokens = Number(cfg?.entry_fee_tokens) > 0 ? Number(cfg.entry_fee_tokens) : 2500;
            const winnerShareBps = Number(cfg?.winner_share_bps) > 0 ? Number(cfg.winner_share_bps) : 9000;
            const entryFeeRaw = BigInt(entryFeeTokens) * BigInt(10) ** BigInt(decimals);
            const expectedRaw = (BigInt(numPlayers) * entryFeeRaw * BigInt(winnerShareBps)) / BigInt(10000);

            const receipt = await rpc.run((p) => p.getTransactionReceipt(tx));
            if (!receipt) return fail("On-chain verification failed: transaction not found");
            if (receipt.status !== 1) return fail("On-chain verification failed: transaction failed on-chain");
            const transfer = (receipt.logs ?? []).find((log: any) =>
              (log.address ?? "").toLowerCase() === tokenAddr &&
              (log.topics?.[0] ?? "") === TRANSFER_TOPIC &&
              topicToAddr(log.topics?.[1]) === escrowAddr &&
              topicToAddr(log.topics?.[2]) === winnerAddr
            );
            if (!transfer) return fail("On-chain verification failed: not a FIGHT10 transfer from escrow to the winner");
            if (BigInt(transfer.data ?? "0x0") < expectedRaw) {
              return fail(`On-chain verification failed: transfer amount is below the expected payout (${expectedRaw})`);
            }
          } catch (err) {
            return fail(`On-chain verification failed: ${String(err?.message ?? err)}`);
          }

          const { error } = await admin.from("matches").update({
            payout_tx: tx, payout_claimed_at: new Date().toISOString(),
          }).eq("id", matchId).or("payout_tx.is.null,payout_tx.eq.pending");
          if (error) return fail(error.message);
          await logNote("payout", matchId, note || `Payout marked resolved (verified on-chain): ${tx}`, "mark_payout_resolved");
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

        case "db_stats": {
          // Database monitoring: size, per-table rows/bytes, connections,
          // longest running query, cache-hit ratio. All read-only catalog +
          // statistics reads (see admin_db_stats()), safe on every refresh.
          const { data, error } = await admin.rpc("admin_db_stats");
          if (error) return fail(`db_stats failed: ${error.message}`, 500);
          return json({ ok: true, ...data });
        }

        case "db_export": {
          // Snapshot for download. With `table`, returns that table's rows;
          // without it, returns a full { table -> rows } snapshot of every
          // public table. Read-only (service role).
          const table = body?.table != null ? String(body.table) : "";
          try {
            if (table) {
              const { data, error } = await admin.rpc("admin_export_table", { p_table: table });
              if (error) {
                if ((error.message || "").includes("unknown_table")) return fail(`Unknown table '${table}'`);
                return fail(`Export failed: ${error.message}`, 500);
              }
              return json({ ok: true, table, generated_at: new Date().toISOString(), rows: data ?? [] });
            }
            const { data, error } = await admin.rpc("admin_snapshot");
            if (error) return fail(`Snapshot failed: ${error.message}`, 500);
            return json({ ok: true, generated_at: new Date().toISOString(), tables: data ?? {} });
          } catch (err) {
            return fail(String(err?.message ?? err), 500);
          }
        }

        case "db_wipe": {
          // DESTRUCTIVE: TRUNCATE one table (or every public table). Requires a
          // typed confirmation that must match exactly, as a guard against an
          // accidental click — the table name for a single table, or the phrase
          // "WIPE ALL" for the whole schema.
          const table = body?.table != null ? String(body.table) : "";
          const confirm = String(body?.confirm ?? "");
          if (table) {
            if (confirm !== table) return fail(`Confirmation mismatch — type the exact table name ('${table}') to wipe it.`);
            const { data, error } = await admin.rpc("admin_truncate_table", { p_table: table });
            if (error) {
              const m = error.message || "";
              if (m.includes("unknown_table")) return fail(`Unknown table '${table}'`);
              // Refused because other tables' FKs reference this one — surface
              // the referencing tables so the operator knows what to wipe first.
              if (m.includes("has_references")) return fail(m.replace(/^.*has_references:\s*/, "").trim());
              return fail(`Wipe failed: ${m}`, 500);
            }
            await logNote("general", table, `WIPED table ${table} (${data ?? 0} rows removed)`, "db_wipe");
            return json({ ok: true, table, rows_removed: data ?? 0 });
          }
          if (confirm !== "WIPE ALL") return fail(`Confirmation mismatch — type "WIPE ALL" to empty every table.`);
          const { data, error } = await admin.rpc("admin_truncate_all");
          if (error) return fail(`Wipe failed: ${error.message}`, 500);
          const tables = data?.tables ?? [];
          const rows = data?.rows ?? 0;
          // Written after the truncate, so the audit note survives the wipe.
          await logNote("general", null, `WIPED ALL TABLES — ${tables.length} tables, ${rows} rows removed`, "db_wipe_all");
          return json({ ok: true, tables, rows_removed: rows });
        }

        case "functions_health": {
          // Edge-function monitoring: ping every function's unauthenticated
          // health probe and report reachability, latency and (non-sensitive)
          // config. Run server-side so one dashboard call covers all functions
          // without per-function CORS round-trips from the browser.
          const base = `${supabaseUrl}/functions/v1`;
          const names = ["f10join", "f10treasurer", "f10admin"];
          const ping = async (name: string) => {
            const started = Date.now();
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 6000);
            try {
              const res = await fetch(`${base}/${name}?health=1`, {
                method: "GET",
                headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}` },
                signal: controller.signal,
              });
              const latency_ms = Date.now() - started;
              const bodyJson = await res.json().catch(() => null);
              return {
                name,
                ok: res.ok && bodyJson?.ok === true,
                status: res.status,
                latency_ms,
                config: bodyJson?.config ?? null,
              };
            } catch (err: any) {
              return {
                name,
                ok: false,
                status: 0,
                latency_ms: Date.now() - started,
                error: err?.name === "AbortError" ? "timed out (>6s)" : String(err?.message ?? err),
              };
            } finally {
              clearTimeout(timer);
            }
          };
          const functions = await Promise.all(names.map(ping));
          return json({ ok: true, generated_at: new Date().toISOString(), functions });
        }

        case "get_config": {
          // Read the editable static constants that otherwise live only in the
          // Supabase table editor: global PvP tunables, per-lobby match
          // durations, and the maintenance switch. `entry_fee_locked` tells the
          // UI when the entry fee can't be changed (matches in flight).
          const [pvpRes, matchRes, maintRes, liveRes] = await Promise.all([
            admin.from("pvp_config").select("player_cap, entry_fee_tokens, winner_share_bps").maybeSingle(),
            admin.from("match_config").select("max_players, duration_seconds").order("max_players", { ascending: true }),
            admin.from("maintain").select("value").limit(1).maybeSingle(),
            admin.from("matches").select("id", { count: "exact", head: true }).in("status", ["waiting", "active"]),
          ]);
          const cfgErr = [pvpRes, matchRes, maintRes, liveRes].find((r: any) => r.error)?.error;
          if (cfgErr) return fail(`get_config failed: ${cfgErr.message}`, 500);
          return json({
            ok: true,
            pvp_config: pvpRes.data ?? null,
            match_config: matchRes.data ?? [],
            maintain: String(maintRes.data?.value ?? "n"),
            live_matches: liveRes.count ?? 0,
            entry_fee_locked: (liveRes.count ?? 0) > 0,
          });
        }

        case "set_config": {
          // Edit a static constant. `target` selects the table; only the fields
          // supplied are changed. Ranges mirror the DB CHECK constraints so the
          // operator gets a clean message instead of a raw constraint violation.
          const target = String(body?.target ?? "");
          const intField = (v: unknown) => {
            const n = Number(v);
            return Number.isInteger(n) ? n : NaN;
          };

          if (target === "pvp_config") {
            const patch: Record<string, number> = {};
            const label: string[] = [];
            if (body?.player_cap != null) {
              const n = intField(body.player_cap);
              if (!(n >= 1 && n <= 100000)) return fail("player_cap must be between 1 and 100000");
              patch.player_cap = n; label.push(`player_cap=${n}`);
            }
            if (body?.entry_fee_tokens != null) {
              const n = intField(body.entry_fee_tokens);
              if (!(n >= 1 && n <= 100000000)) return fail("entry_fee_tokens must be between 1 and 100000000");
              patch.entry_fee_tokens = n; label.push(`entry_fee_tokens=${n}`);
            }
            if (body?.winner_share_bps != null) {
              const n = intField(body.winner_share_bps);
              if (!(n >= 0 && n <= 10000)) return fail("winner_share_bps must be between 0 and 10000 (bps)");
              patch.winner_share_bps = n; label.push(`winner_share_bps=${n}`);
            }
            if (Object.keys(patch).length === 0) return fail("No pvp_config fields to update");
            // Upsert (not update) so the editor still works if the singleton row
            // is missing — e.g. after a table wipe. Column defaults fill any
            // field not being set on insert.
            const { error } = await admin.from("pvp_config").upsert({ id: true, ...patch }, { onConflict: "id" });
            if (error) {
              // The pvp_config_guard trigger blocks entry-fee changes while
              // matches are live — surface that as a friendly message.
              if ((error.message || "").includes("entry_fee_locked")) {
                return fail("Entry fee is locked while matches are waiting or active — change it once the board is clear.");
              }
              return fail(error.message);
            }
            await logNote("general", "pvp_config", `Updated pvp_config: ${label.join(", ")}`, "set_config");
            return json({ ok: true });
          }

          if (target === "match_config") {
            // Accept one row or an array of { max_players, duration_seconds }.
            const raw = Array.isArray(body?.rows) ? body.rows
              : [{ max_players: body?.max_players, duration_seconds: body?.duration_seconds }];
            const rows: { max_players: number; duration_seconds: number }[] = [];
            for (const r of raw) {
              const mp = intField(r?.max_players);
              const ds = intField(r?.duration_seconds);
              if (![2, 5, 10].includes(mp)) return fail("max_players must be 2, 5, or 10");
              if (!(ds >= 30 && ds <= 3600)) return fail("duration_seconds must be between 30 and 3600");
              rows.push({ max_players: mp, duration_seconds: ds });
            }
            if (rows.length === 0) return fail("No match_config rows to update");
            const { error } = await admin.from("match_config").upsert(rows, { onConflict: "max_players" });
            if (error) return fail(error.message);
            await logNote("general", "match_config",
              `Updated match durations: ${rows.map((r) => `${r.max_players}p=${r.duration_seconds}s`).join(", ")}`, "set_config");
            return json({ ok: true });
          }

          if (target === "maintain") {
            const value = String(body?.value ?? "").trim().toLowerCase();
            if (value !== "y" && value !== "n") return fail("maintain value must be 'y' or 'n'");
            // Upsert so a missing singleton row (e.g. after a wipe) is recreated.
            const { error } = await admin.from("maintain").upsert({ id: true, value }, { onConflict: "id" });
            if (error) return fail(error.message);
            await logNote("general", "maintain",
              value === "y" ? "Maintenance mode turned ON" : "Maintenance mode turned OFF", "set_config");
            return json({ ok: true });
          }

          return fail(`Unknown set_config target '${target}'`);
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
      consumedRes, waitingRes, bannedRes, notesRes, payoutsRes,
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
      // "All payouts" is driven by matches (the source of truth for a landed
      // payout), not by the payouts ledger: ledger writes are best-effort, so
      // a paid match must still show here even when its ledger row is missing
      // (insert failed, or the match was paid before the ledger existed).
      admin.from("matches")
        .select("id, match_no, max_players, winner_user_id, ended_at, pot_tokens, payout_tx, payout_claimed_at")
        .eq("status", "finished").not("winner_user_id", "is", null)
        .not("payout_tx", "is", null).neq("payout_tx", "pending")
        .order("ended_at", { ascending: false, nullsFirst: false }).limit(LIST_LIMIT),
    ]);

    const firstErr = [
      disputedRes, integrityRes, payoutPendingRes, payoutFailedRes,
      consumedRes, waitingRes, bannedRes, notesRes, payoutsRes,
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
    const paidMatches = payoutsRes.data ?? [];

    // Seats for disputed + stale-waiting matches + ledger rows for the paid
    // matches (exact amounts where available), in batched lookups. Seat rows
    // for the remaining tabs are also fetched so a player's deposit_wallet can
    // stand in when their profile has no wallet_address recorded (accounts
    // that predate wallet syncing would otherwise show "—").
    const disputedIds = disputed.map((m: any) => m.id);
    const waitingIds = waiting.map((m: any) => m.id);
    const paidIds = paidMatches.map((m: any) => m.id);
    const seatWalletIds = [...new Set(
      [...consumed, ...integrity, ...payoutPending, ...payoutFailed, ...paidMatches]
        .map((r: any) => r.match_id ?? r.id).filter(Boolean),
    )];
    const [seatRes, waitSeatRes, ledgerRes, seatWalletRes] = await Promise.all([
      disputedIds.length
        ? admin.from("match_players").select("match_id, user_id, seat, display_name, deposit_wallet, final_hp, last_seen").in("match_id", disputedIds)
        : Promise.resolve({ data: [] as any[] }),
      waitingIds.length
        ? admin.from("match_players").select("match_id, user_id, seat, display_name, deposit_wallet").in("match_id", waitingIds)
        : Promise.resolve({ data: [] as any[] }),
      paidIds.length
        ? admin.from("payouts").select("match_id, winner_user_id, payout_tx, amount_raw, decimals, num_players, created_at").in("match_id", paidIds)
        : Promise.resolve({ data: [] as any[] }),
      seatWalletIds.length
        ? admin.from("match_players").select("match_id, user_id, deposit_wallet").in("match_id", seatWalletIds)
        : Promise.resolve({ data: [] as any[] }),
    ]);
    // (match_id, user_id) → the wallet that signed that seat's deposit.
    const seatWallets = new Map<string, string>();
    for (const s of (seatWalletRes.data ?? [])) {
      if (s.deposit_wallet) seatWallets.set(`${s.match_id}:${s.user_id}`, s.deposit_wallet);
    }
    const seatWalletOf = (matchId?: string | null, userId?: string | null) =>
      (matchId && userId ? seatWallets.get(`${matchId}:${userId}`) ?? null : null);
    const ledgerByMatch = new Map<string, any>();
    for (const p of (ledgerRes.data ?? [])) ledgerByMatch.set(p.match_id, p);
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
      ...paidMatches.map((r: any) => r.winner_user_id),
    ]);
    const nameOf = (id?: string | null) => (id ? nameMap.get(id)?.name ?? null : null);
    const walletOf = (id?: string | null) => (id ? nameMap.get(id)?.wallet ?? null : null);

    const payoutView = (m: any) => ({
      ...m,
      winner_name: nameOf(m.winner_user_id),
      winner_wallet: walletOf(m.winner_user_id) ?? seatWalletOf(m.id, m.winner_user_id),
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
        payouts: paidMatches.length,
      },
      disputed: disputed.map((m: any) => ({
        ...m,
        players: (seatsByMatch.get(m.id) ?? []).sort((a, b) => a.seat - b.seat),
      })),
      integrity: integrity.map((r: any) => ({
        ...r,
        user_name: nameOf(r.user_id),
        user_wallet: walletOf(r.user_id) ?? seatWalletOf(r.match_id, r.user_id),
      })),
      payout_pending: payoutPending.map(payoutView),
      payout_failed: payoutFailed.map(payoutView),
      // Deposit-centric: prefer the wallet that actually signed this deposit
      // (the seat row), falling back to the player's profile login wallet.
      consumed_deposits: consumed.map((r: any) => ({
        ...r,
        user_name: nameOf(r.user_id),
        user_wallet: seatWalletOf(r.match_id, r.user_id) ?? walletOf(r.user_id),
      })),
      stale_waiting: waiting.map((m: any) => ({
        ...m,
        creator_name: nameOf(m.created_by),
        creator_wallet: walletOf(m.created_by),
        players: (waitSeatsByMatch.get(m.id) ?? []).sort((a, b) => a.seat - b.seat),
        seats_filled: (waitSeatsByMatch.get(m.id) ?? []).length,
        open_minutes: Math.floor((now - new Date(m.created_at).getTime()) / 60_000),
      })),
      banned,
      notes: notes.map((r: any) => ({ ...r, author_name: nameOf(r.author_id), author_wallet: walletOf(r.author_id) })),
      payouts: paidMatches.map((m: any) => {
        // Prefer the ledger row (exact paid amount at its recorded decimals);
        // fall back to 90% of the pot for matches whose ledger insert never
        // landed — pot_tokens is stored in WHOLE tokens, so decimals 0.
        const p = ledgerByMatch.get(m.id);
        const amount_raw = p?.amount_raw ?? Math.floor(Number(m.pot_tokens ?? 0) * 0.9);
        const decimals = p ? (p.decimals ?? TOKEN_DECIMALS) : 0;
        return {
          match_id: m.id,
          match_no: m.match_no,
          max_players: m.max_players,
          winner_user_id: m.winner_user_id,
          winner_name: nameOf(m.winner_user_id),
          winner_wallet: walletOf(m.winner_user_id) ?? seatWalletOf(m.id, m.winner_user_id),
          payout_tx: m.payout_tx,
          amount_raw,
          decimals,
          num_players: p?.num_players ?? m.max_players,
          created_at: p?.created_at ?? m.payout_claimed_at ?? m.ended_at,
          amount: amount_raw != null ? Number(amount_raw) / 10 ** decimals : null,
        };
      }),
    });
  } catch (err) {
    console.error("f10admin error:", err);
    return fail(String(err), 500);
  }
});
