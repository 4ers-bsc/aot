/// Verified-join Edge Function
//
// Deposit verification happens BEFORE lobby admission. The browser sends the
// confirmed deposit tx signature here; this function:
//   1. authenticates the caller (JWT),
//   2. verifies the tx on-chain (confirmed + correct FIGHT10 amount to escrow,
//      signed by the player's own wallet),
//   3. ONLY THEN calls the service-role `join_pvp_match` RPC to take a seat.
//
// Because join_pvp_match is no longer granted to `authenticated`, a malicious
// user cannot call the RPC directly with a fake signature to fill a lobby.
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
// RPC endpoint pool — spread load across up to 3 keys (RPC_URL, RPC_URL_2,
// RPC_URL_3). Each call grabs the next endpoint round-robin, so concurrent joins
// and parallel lookups hit different keys; on error (e.g. a 429 rate limit) the
// call rotates to the next key instead of failing. Random start index keeps load
// balanced across function instances rather than all hammering RPC #1 first.
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
  return unique.length ? unique : ["https://api.mainnet-beta.solana.com"];
}

function createRpcPool(commitment: "confirmed" | "finalized" = "confirmed") {
  const conns = getRpcUrls().map((u) => new Connection(u, commitment));
  let idx = Math.floor(Math.random() * conns.length);
  const next = () => {
    const c = conns[idx];
    idx = (idx + 1) % conns.length;
    return c;
  };
  return {
    // One connection (round-robin) for a sticky sequence such as send+confirm.
    lease: () => next(),
    // Run a read with failover: rotate to the next endpoint on error.
    async run<T>(fn: (c: Connection) => Promise<T>): Promise<T> {
      let lastErr: unknown;
      for (let i = 0; i < conns.length; i++) {
        try {
          return await fn(next());
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr;
    },
  };
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

    // Non-browser / direct (curl) request detection. A genuine browser fetch to
    // this cross-origin function ALWAYS sends an Origin header; a missing Origin
    // means the call did not come from the game client → ban the wallet. (A
    // *mismatched* Origin is intentionally not banned — it's already blocked by
    // CORS and could be a legitimate alternate domain.)
    const reqOrigin = req.headers.get("Origin");
    if (!reqOrigin) {
      await adminClient.rpc("ban_user", { p_user_id: user.id, p_reason: "non_browser_request" });
      console.error("Banned non-browser join (no Origin)", { user: user.id });
      return fail("Request rejected — this wallet has been banned for automated access.");
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
    const depositTx     = String(body?.deposit_tx ?? "").trim();
    const depositWallet = String(body?.deposit_wallet ?? "").trim();
    const displayName   = body?.display_name ?? null;

    if (![2, 5, 10].includes(maxPlayers)) return fail("max_players must be 2, 5, or 10");
    if (!depositTx)     return fail("deposit_tx is required");
    if (!depositWallet) return fail("deposit_wallet is required");

    // ── Escrow / mint config ────────────────────────────────────────────────
    const escrowB58 = Deno.env.get("ESCROW_PRIVATE_KEY");
    const mintStr   = Deno.env.get("FIGHT10_MINT");
    if (!escrowB58 || !mintStr) return jsonResponse({ ok: false, error: "Escrow configuration missing" }, 500);

    const B58_CHARS     = /[^123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]/g;
    const escrowKeypair = Keypair.fromSecretKey(base58Decode(escrowB58.replace(B58_CHARS, "")));
    const mintPubkey    = pubkeyFromBase58(mintStr.replace(B58_CHARS, ""));
    const rpc           = createRpcPool("confirmed");

    // The wallet that must have authorised this deposit (the player's own wallet).
    let expectedSender: string;
    try {
      expectedSender = pubkeyFromBase58(depositWallet.split(":").pop() ?? "").toBase58();
    } catch {
      return fail("deposit_wallet is invalid");
    }

    // ── Resolve mint → token program, decimals, escrow token account ─────────
    const mintAcct = await rpc.run((c) => c.getAccountInfo(mintPubkey));
    if (!mintAcct) return jsonResponse({ ok: false, error: "Mint account not found on-chain" }, 500);
    const tokenProgramId = mintAcct.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const decimals       = mintAcct.data[44];
    const entryFeeAmtStr = (BigInt(2500) * BigInt(10 ** decimals)).toString();
    const tokenProgStr   = tokenProgramId.toString();
    const tok2022Str     = TOKEN_2022_PROGRAM_ID.toString();

    const escrowAccounts = await rpc.run((c) => c.getParsedTokenAccountsByOwner(escrowKeypair.publicKey, { mint: mintPubkey }));
    if (escrowAccounts.value.length === 0) return jsonResponse({ ok: false, error: "Escrow has no token account for this mint" }, 500);
    const escrowAtaStr = new PublicKey(escrowAccounts.value[0].pubkey).toString();

    // ── Verify the deposit tx is confirmed on-chain ──────────────────────────
    const { value: sigStatuses } = await rpc.run((c) => c.getSignatureStatuses([depositTx]));
    const sigStatus = sigStatuses[0];
    if (!sigStatus) return fail("Deposit not found on-chain");
    if (sigStatus.err) return fail("Deposit failed on-chain");
    if (sigStatus.confirmationStatus !== "confirmed" && sigStatus.confirmationStatus !== "finalized") {
      return fail("Deposit not yet confirmed — try again in a moment");
    }

    // ── Verify the tx transferred the correct amount to escrow from the player ─
    const parsed = await rpc.run((c) => c.getParsedTransaction(depositTx, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    }));
    if (!parsed) return fail("Deposit could not be parsed");

    const topLevel = parsed.transaction.message.instructions as any[];
    const inner    = (parsed.meta?.innerInstructions ?? []).flatMap((ii: any) => ii.instructions);

    const valid = [...topLevel, ...inner].some((ix: any) => {
      const prog = ix.programId?.toString();
      if (prog !== tokenProgStr && prog !== tok2022Str) return false;
      if (!ix.parsed) return false;
      const { type, info } = ix.parsed;
      // Single-sig wallets use `authority`; multisig uses `multisigAuthority`.
      const senderRaw = info.authority ?? info.multisigAuthority;
      if (!senderRaw) return false;
      let sender: string;
      try {
        sender = pubkeyFromBase58(senderRaw).toBase58();
      } catch {
        return false;
      }
      if (sender !== expectedSender) return false;
      if (type === "transfer") {
        return info.destination === escrowAtaStr && info.amount === entryFeeAmtStr;
      }
      if (type === "transferChecked") {
        return info.destination === escrowAtaStr && info.tokenAmount?.amount === entryFeeAmtStr;
      }
      return false;
    });

    if (!valid) {
      console.error("Join deposit verification failed", JSON.stringify({
        user: user.id, expectedSender, escrowAtaStr, entryFeeAmtStr,
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
