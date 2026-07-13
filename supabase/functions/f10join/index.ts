/// Verified-join Edge Function
//
// Deposit verification happens BEFORE lobby admission. The browser sends the
// confirmed deposit tx hash here; this function:
//   1. authenticates the caller (JWT),
//   2. verifies the tx on-chain (mined + successful + an ERC-20 Transfer of
//      the exact FIGHT10 amount from the player's own wallet to escrow),
//   3. ONLY THEN calls the service-role `join_pvp_match` RPC to take a seat.
//
// Because join_pvp_match is no longer granted to `authenticated`, a malicious
// user cannot call the RPC directly with a fake hash to fill a lobby.
//
// Chain: Robinhood Chain (an Ethereum L2). The app runs on mainnet only —
// the network is defined below and matches the client's src/network.js.
// Verification runs on raw JSON-RPC (eth_getTransactionReceipt / eth_call),
// no web3 library needed.
//
// Required Supabase secrets: ESCROW_WALLET (0x address), FIGHT10_TOKEN
// (ERC-20 contract 0x address), and optionally RPC_URL(_2, _3).
// Verifying a deposit only needs the escrow's PUBLIC address — the private
// key stays with f10treasurer, the only function that signs payouts.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Robinhood Chain network (mainnet). Kept in sync with src/network.js on the
// client.
// ---------------------------------------------------------------------------
const NETWORK: { name: string; chainId: number; rpcUrl: string } = {
  name: "Robinhood Chain",
  chainId: 4663,
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
};

// keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer event.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// ---------------------------------------------------------------------------
// Address / hex helpers
// ---------------------------------------------------------------------------
// Ethereum addresses are case-insensitive (EIP-55 checksums just vary the
// case), and stored wallet_address values may carry a "chain:" prefix
// (e.g. "ethereum:0x…") — normalise to the lowercased trailing segment.
const normAddr = (w?: string | null) =>
  ((w ?? "").trim().split(":").pop() ?? "").trim().toLowerCase();
const isAddress = (a: string) => /^0x[0-9a-f]{40}$/.test(a);
const isTxHash = (h: string) => /^0x[0-9a-fA-F]{64}$/.test(h);
// An indexed address event topic is the address left-padded to 32 bytes.
const topicToAddr = (t?: string) => (t ? "0x" + t.slice(-40).toLowerCase() : "");

// ---------------------------------------------------------------------------
// RPC endpoint pool — spread load across up to 3 keys (RPC_URL, RPC_URL_2,
// RPC_URL_3; the network's public RPC as fallback). Each call grabs the next
// endpoint round-robin, so concurrent joins hit different keys; on error
// (e.g. a 429 rate limit) the call rotates to the next key instead of failing.
// Random start index keeps load balanced across function instances.
// ---------------------------------------------------------------------------
function getRpcUrls(): string[] {
  const urls = [
    Deno.env.get("RPC_URL"),
    Deno.env.get("RPC_URL_2"),
    Deno.env.get("RPC_URL_3"),
  ]
    .map((u) => u?.trim())
    .filter((u): u is string => !!u);
  const unique = [...new Set(urls)];
  return unique.length ? unique : [NETWORK.rpcUrl];
}

async function rpcCall(url: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC ${method} error: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

function createRpcPool() {
  const urls = getRpcUrls();
  let idx = Math.floor(Math.random() * urls.length);
  const next = () => {
    const u = urls[idx];
    idx = (idx + 1) % urls.length;
    return u;
  };
  return {
    async run(method: string, params: unknown[]): Promise<any> {
      let lastErr: unknown;
      for (let i = 0; i < urls.length; i++) {
        try {
          return await rpcCall(next(), method, params);
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr;
    },
  };
}

// ERC-20 decimals() — selector 0x313ce567.
async function getTokenDecimals(rpc: ReturnType<typeof createRpcPool>, token: string): Promise<number> {
  const result = await rpc.run("eth_call", [{ to: token, data: "0x313ce567" }, "latest"]);
  if (!result || result === "0x") throw new Error("Token contract not found on-chain");
  return Number(BigInt(result));
}

// ---------------------------------------------------------------------------

const appOrigin = Deno.env.get("APP_ORIGIN");
if (!appOrigin) console.error("WARNING: APP_ORIGIN secret not set — CORS is open to all origins. Set it in Supabase secrets for production.");
const corsHeaders = {
  "Access-Control-Allow-Origin": appOrigin || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Business errors (bad deposit, already joined, …) are returned as HTTP 200 with
// { ok:false, error } so supabase-js `functions.invoke` surfaces the real reason
// to the client instead of a generic "non-2xx" message. Only unexpected failures
// use a 5xx status.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
function fail(error: string): Response {
  return jsonResponse({ ok: false, error }, 200);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Unauthenticated health probe (…/f10join?health=1). Used by the ops
  // dashboard's "Edge functions" tab to check reachability + report whether the
  // deposit-verification config is wired up. Returns only booleans / public
  // addresses — never a secret value. Handled before auth and before the body
  // is read, so it can't interfere with a real join request.
  if (new URL(req.url).searchParams.has("health")) {
    return jsonResponse({
      ok: true,
      service: "f10join",
      time: new Date().toISOString(),
      config: {
        escrow_wallet: normAddr(Deno.env.get("ESCROW_WALLET")) || null,
        token:         normAddr(Deno.env.get("FIGHT10_TOKEN")) || null,
        rpc_endpoints: getRpcUrls().length,
        app_origin_set: !!appOrigin,
      },
    });
  }

  const supabaseUrl        = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey    = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ ok: false, error: "Missing Authorization header" }, 401);

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Reject already-banned accounts up front.
    const { data: alreadyBanned } = await adminClient.rpc("is_banned", { p_user_id: user.id });
    if (alreadyBanned === true) return fail("This account is banned from play.");

    // Maintenance gate: refuse new joins while the game is under maintenance,
    // BEFORE any on-chain work, so a client that stripped the maintenance
    // overlay still can't enter. The join_pvp_match seat trigger is the hard
    // guarantee; this is the clean, early message (and skips RPC/chain calls).
    const { data: maint } = await adminClient
      .from("maintain").select("value").limit(1).maybeSingle();
    if (String(maint?.value ?? "").trim().toLowerCase() === "y") {
      return fail("The game is under maintenance — please try again later.");
    }

    // Non-browser / direct (curl) request detection. A genuine browser fetch to
    // this cross-origin function normally sends an Origin header, but privacy
    // extensions, proxies and some webviews strip it — so a missing Origin is
    // grounds to REJECT the request, never to ban the wallet. When APP_ORIGIN
    // is configured the Origin must also MATCH it — presence alone is trivially
    // spoofed (`curl -H "Origin: x"`). Defense-in-depth only: real abuse still
    // surfaces through the rate limiter and the server-side combat validation.
    const reqOrigin = req.headers.get("Origin");
    const stripSlash = (o: string) => o.replace(/\/+$/, "");
    if (!reqOrigin || (appOrigin && stripSlash(reqOrigin) !== stripSlash(appOrigin))) {
      console.error("Rejected non-browser join (bad Origin)", { user: user.id, origin: reqOrigin });
      return fail("Request rejected — please join from the game client.");
    }

    // Throttle join attempts per user (anti-abuse). Uses the caller's JWT so
    // auth.uid() resolves inside the function. 10/min is generous for real play.
    const { error: rlErr } = await userClient.rpc("enforce_rate_limit", {
      p_action: "join",
      p_max: 10,
      p_window: "1 minute",
    });
    if (rlErr) {
      // Only block on a real rate-limit hit. If the function is missing (anti-cheat
      // migration not applied) or the call is otherwise broken, fail open so joins
      // keep working instead of returning a misleading "too many attempts".
      if ((rlErr.message || "").includes("rate_limited")) {
        return fail("Too many join attempts — slow down and try again shortly.");
      }
      console.error("rate-limit check skipped:", rlErr);
    }

    const body = await req.json().catch(() => null);
    const maxPlayers    = Number(body?.max_players);
    // EVM tx hashes are case-insensitive, but the DB compares deposit_tx as an
    // exact string and the consumed-deposit ledger is keyed on it — normalise to
    // lowercase so a re-cased hash can't pass replay protection as a new deposit
    // (matches join_pvp_match + the lower(deposit_tx) unique indexes). #7
    const depositTx     = String(body?.deposit_tx ?? "").trim().toLowerCase();
    const depositWallet = String(body?.deposit_wallet ?? "").trim();
    const displayName   = body?.display_name ?? null;

    if (![2, 5, 10].includes(maxPlayers)) return fail("max_players must be 2, 5, or 10");
    if (!depositTx)     return fail("deposit_tx is required");
    if (!isTxHash(depositTx)) return fail("deposit_tx is not a valid transaction hash");
    if (!depositWallet) return fail("deposit_wallet is required");

    // ── Escrow / token config ────────────────────────────────────────────────
    // Only the escrow's PUBLIC address is needed to verify a deposit landed in
    // it — the same address the client pays into. Never load the private key
    // here; f10treasurer is the only function that signs with it.
    const escrowAddr = normAddr(Deno.env.get("ESCROW_WALLET"));
    const tokenAddr  = normAddr(Deno.env.get("FIGHT10_TOKEN"));
    if (!isAddress(escrowAddr) || !isAddress(tokenAddr)) {
      return jsonResponse({ ok: false, error: "Escrow configuration missing" }, 500);
    }
    const rpc = createRpcPool();

    // The wallet that must have sent this deposit (the player's own wallet).
    const expectedSender = normAddr(depositWallet);
    if (!isAddress(expectedSender)) return fail("deposit_wallet is invalid");

    // ── Resolve token decimals → exact entry-fee amount ─────────────────────
    const decimals = await getTokenDecimals(rpc, tokenAddr);
    // Entry fee is a tunable in pvp_config (single source of truth shared with
    // the client + the payout functions). Fall back to the historical literal
    // if the row is unreadable. The pvp_config_guard trigger blocks fee changes
    // while matches are live, so this validates the deposit against the same fee
    // the client just charged.
    const { data: cfg } = await adminClient
      .from("pvp_config").select("entry_fee_tokens").maybeSingle();
    const entryFeeTokens = Number(cfg?.entry_fee_tokens) > 0 ? Number(cfg.entry_fee_tokens) : 10000;
    const entryFeeRaw = BigInt(entryFeeTokens) * BigInt(10) ** BigInt(decimals);

    // ── Verify the deposit tx is mined and succeeded ─────────────────────────
    // A receipt only exists once the tx is included in a block; status 0x1
    // means it executed without reverting. Unlike Solana there is no separate
    // status cache — receipts are queryable for the chain's full history.
    const receipt = await rpc.run("eth_getTransactionReceipt", [depositTx]);
    if (!receipt) return fail("Deposit not found on-chain — try again in a moment");
    if (receipt.status !== "0x1") return fail("Deposit failed on-chain");

    // ── Verify the tx transferred the correct amount to escrow from the player ─
    // The ERC-20 Transfer event is emitted by the token contract itself, so a
    // confirmed-but-unrelated tx hash cannot pass this: the log must come from
    // OUR token contract, from the player's wallet, to escrow, for the exact
    // entry fee. Works for direct transfers and router/contract-wrapped ones.
    const valid = (receipt.logs ?? []).some((log: any) =>
      (log.address ?? "").toLowerCase() === tokenAddr &&
      log.topics?.[0] === TRANSFER_TOPIC &&
      topicToAddr(log.topics?.[1]) === expectedSender &&
      topicToAddr(log.topics?.[2]) === escrowAddr &&
      BigInt(log.data ?? "0x0") === entryFeeRaw
    );

    if (!valid) {
      console.error("Join deposit verification failed", JSON.stringify({
        user: user.id, expectedSender, escrowAddr, tokenAddr, entryFee: entryFeeRaw.toString(),
      }));
      return fail("Deposit does not contain a valid FIGHT10 transfer from your wallet to escrow");
    }

    // ── Deposit verified → admit the player via the service-role RPC ──────────
    const { data: joinResult, error: joinErr } = await adminClient.rpc("join_pvp_match", {
      p_user_id:        user.id,
      p_max_players:    maxPlayers,
      p_deposit_tx:     depositTx,
      p_display_name:   displayName,
      p_deposit_wallet: depositWallet,
    });
    if (joinErr) {
      console.error("join_pvp_match RPC failed", joinErr);
      // Surface the RPC's own message (e.g. deposit_wallet_mismatch) to the client.
      return fail(joinErr.message || "Could not join match");
    }

    return jsonResponse({ ok: true, ...(joinResult as Record<string, unknown>) });
  } catch (err) {
    console.error("Join error:", err);
    return jsonResponse({ ok: false, error: String(err) }, 500);
  }
});
