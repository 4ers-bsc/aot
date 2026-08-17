# FIGHT10 — last one standing

Skill-based PvP arena on **Solana**. Players stake 10,000 $FIGHT10 (an SPL
token) to enter; the last fighter alive takes 90% of the pot, paid from escrow
and verified on-chain end to end.

## Network: Solana (mainnet-beta)

The whole stack runs on **Solana mainnet-beta**, defined once in
[`src/network.js`](src/network.js) for the client and mirrored in each
Supabase edge function (`f10join`, `f10treasurer`, `f10admin`):

| | mainnet-beta |
|---|---|
| **Network name** | Solana |
| **Cluster** | `mainnet-beta` |
| **RPC URL** | `https://api.mainnet-beta.solana.com` (set a dedicated key for prod) |
| **Explorer** | `https://solscan.io` |
| **Native currency (fees)** | SOL |

Everything downstream (the read RPC, wallet connection, every explorer link)
follows this definition automatically. Solana wallets have no "switch/add
network" prompt — the cluster follows the RPC endpoint the app uses.

## Configuration

### Client (`VITE_*` env vars)

| Variable | Purpose | Default |
|---|---|---|
| `VITE_FIGHT10_TOKEN` | $FIGHT10 SPL token mint address (base58) | placeholder |
| `VITE_ESCROW_WALLET` | Escrow wallet address (base58, public) | placeholder |
| `VITE_FIGHT10_DECIMALS` | Token decimals — seed/fallback only; the client reads the mint's real decimals on-chain at boot (Pump.fun mints use 6) | `6` |
| `VITE_SOLANA_RPC_URL` | Override the cluster's public RPC (e.g. a dedicated key) | mainnet RPC |
| `VITE_BUY_FIGHT10_URL` | "Buy $FIGHT10" link (e.g. a Jupiter/Raydium swap URL) | token's Solscan page |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | Supabase project | — |

### Edge functions (Supabase secrets)

| Secret | Used by | Purpose |
|---|---|---|
| `FIGHT10_TOKEN` | all three | $FIGHT10 SPL token mint address (base58) |
| `ESCROW_WALLET` | `f10join` | Escrow **public** address (deposit destination) |
| `ESCROW_PRIVATE_KEY` | `f10treasurer`, `f10admin` | Escrow signer — base58 secret key OR a JSON byte array (`id.json`); only the payout functions hold it |
| `RPC_URL`, `RPC_URL_2`, `RPC_URL_3` | all three | Optional RPC pool (round-robin + failover); falls back to the cluster's public RPC |
| `FIGHT10_DECIMALS` | `f10admin` | Dashboard display decimals (on-chain paths read the mint's decimals live) |
| `APP_ORIGIN` | all three | Locks CORS to the game origin |
| `ADMIN_USER_IDS` / `ADMIN_WALLETS` | `f10admin` | Ops dashboard allowlist |

> The escrow account must also hold a little **SOL** to pay transaction fees and
> the one-time rent when a winner's token account has to be created.

### Verifying the deployed config

The ops dashboard (`<app>/#admin` → **System → Deployment**) shows the on-chain
and environment constants the app is actually running with — the $FIGHT10 mint,
escrow wallet, RPC pool, network and CORS origin — split into the **client**
(browser build) and **server** (edge-function) side, and flags any
**mismatch**. Secrets are never exposed: the escrow wallet is a public address,
RPC keys are redacted, and the private key shows only as a yes/no. A client vs.
server mint mismatch (or an unset `VITE_FIGHT10_TOKEN`) is the usual cause of a
balance that won't load or a deposit that won't verify — check this tab first.

## How money moves

1. **Deposit** — the client builds an SPL `transferChecked` of 10,000 $FIGHT10
   from the player's associated token account (ATA) to the escrow's ATA (created
   idempotently if it doesn't exist yet), signs it with the connected Solana
   wallet, and submits it.
2. **Verified join** — `f10join` fetches the transaction on-chain and checks the
   token-balance deltas (success, our mint, sender = the player's own wallet,
   destination = escrow, exact amount) before a seat is taken.
3. **Payout** — `f10treasurer` re-verifies every deposit, atomically claims the
   payout slot, then signs an SPL transfer of 90% of the pot from escrow to the
   winner and records the confirmed signature.

## Home chat & host-run vote

The landing screen has a broadcast chat box (bottom-right). Everyone — signed in
or not — reads the message stream, the live **online** count (the same presence
count the home screen shows), and the running **Yes / No** tally. Only the
**host** can post messages and open/close votes; any signed-in player casts or
changes a Yes/No while a vote is open, and the count updates for everyone in
real time.

"Host" is **not a new role or DB flag** — it reuses the same operator allowlist
as the ops dashboard: `ADMIN_USER_IDS` / `ADMIN_WALLETS` on the `f10admin` edge
function. Posting and running votes go through `f10admin` (service role, admin-
gated), so a browser can never write a message, and the composer + poll controls
are revealed only after `f10admin` confirms the caller is on the allowlist. Reads
and voting are public RLS + Realtime Postgres Changes (`chat_messages`,
`chat_poll`); votes go through the `cast_chat_vote` RPC (one per player, per
poll). See `supabase/migrations/20260817_home_chat.sql`.

The host can drive all of this from **two places**: the chat box on the page, or
the ops dashboard's **Chat & votes** tab (`#admin` → Community). The dashboard
tab adds message + vote **history** and per-message moderation (delete) on top of
the same post / start-vote / close-vote controls.

First sign-in prompts a new player to pick a **name + avatar** (skin). The row is
created on sign-in with `profiles.onboarded = false`; the picker saves the choice
via `complete_onboarding` and flips the flag. Existing players are backfilled to
`onboarded = true`, so nobody is re-prompted.

## Development

```sh
npm install
npm run dev    # http://localhost:3000 (port must match Supabase Site URL for SIWS)
npm run build
```

Database: apply `supabase/migrations/*.sql` in order (or `supabase/fresh_setup.sql`
on a fresh project). Auth uses Supabase **Sign in with Web3 (Solana / SIWS)** —
enable the Web3 provider (Solana) in the Supabase dashboard. The home chat +
running vote use **Realtime Postgres Changes**: the `20260817_home_chat`
migration adds `chat_messages` and `chat_poll` to the `supabase_realtime`
publication, so no dashboard toggle is needed.
