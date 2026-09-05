# FIGHT10 — last one standing

Skill-based PvP arena on **Robinhood Chain** (an Ethereum L2 built on the
Arbitrum Orbit stack). Players stake 10,000 $FIGHT10 (a standard ERC-20) to
enter; the last fighter alive takes 90% of the pot, paid from escrow and
verified on-chain end to end.

## Network: Robinhood Chain (mainnet)

The whole stack runs on **Robinhood Chain mainnet**, defined once in
[`src/network.js`](src/network.js) for the client and mirrored in each
Supabase edge function (`f10join`, `f10treasurer`, `f10admin`):

| | Mainnet |
|---|---|
| **Network name** | Robinhood Chain |
| **Chain ID** | `4663` (`0x1237`) |
| **RPC URL** | `https://rpc.mainnet.chain.robinhood.com` (rate-limited — set a dedicated key for prod) |
| **Explorer (Blockscout)** | `https://robinhoodchain.blockscout.com` |
| **Native currency (gas)** | ETH |

Everything downstream (wallet add/switch-chain prompts, the read RPC, every
Blockscout link) follows this definition automatically. The client asks the
wallet to switch to — or add — the network before signing in and before every
deposit, and refuses to sign on any other chain.

## Configuration

### Client (`VITE_*` env vars)

| Variable | Purpose | Default |
|---|---|---|
| `VITE_FIGHT10_TOKEN` | $FIGHT10 ERC-20 contract address (`0x…`) | placeholder (pre-launch state) |
| `VITE_ESCROW_WALLET` | Escrow wallet address (`0x…`, public) | placeholder |
| `VITE_FIGHT10_DECIMALS` | Token decimals — seed/fallback only; the client reads the contract's `decimals()` on-chain at boot | `18` |
| `VITE_ROBINHOOD_RPC_URL` | Override the network's public RPC (e.g. a dedicated key) | mainnet RPC |
| `VITE_BUY_FIGHT10_URL` | "Buy $FIGHT10" link (e.g. a DEX swap URL) | token's Blockscout page |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | Supabase project | — |

### Edge functions (Supabase secrets)

| Secret | Used by | Purpose |
|---|---|---|
| `FIGHT10_TOKEN` | all three | $FIGHT10 ERC-20 contract address (`0x…`) |
| `ESCROW_WALLET` | `f10join` | Escrow **public** address (deposit destination) |
| `ESCROW_PRIVATE_KEY` | `f10treasurer`, `f10admin` | Escrow signer, 0x-prefixed hex private key — only the payout functions hold it |
| `RPC_URL`, `RPC_URL_2`, `RPC_URL_3` | all three | Optional RPC pool (round-robin + failover); falls back to the network's public RPC |
| `FIGHT10_DECIMALS` | `f10admin` | Dashboard display decimals (on-chain paths read `decimals()` live) |
| `APP_ORIGIN` | all three | Locks CORS to the game origin |
| `ADMIN_USER_IDS` / `ADMIN_WALLETS` | `f10admin` | Ops dashboard allowlist |
| `RECONCILE_SECRET` | `f10treasurer` | Enables the background payout reconciler (`…?reconcile=1`); unset = off |

> The escrow account must also hold a little **ETH** on Robinhood Chain to pay
> gas for payout transfers.

### Verifying the deployed config

The ops dashboard (`<app>/#admin` → **System → Deployment**) shows the on-chain
and environment constants the app is actually running with — the $FIGHT10
contract, escrow wallet, RPC pool, network/chain id and CORS origin — split into
the **client** (browser build) and **server** (edge-function) side, and flags
any **mismatch**. Secrets are never exposed: the escrow wallet is a public
address, RPC keys are redacted, and the private key shows only as a yes/no. A
client vs. server token mismatch (or an unset `VITE_FIGHT10_TOKEN`) is the usual
cause of a balance that won't load or a deposit that won't verify — check this
tab first.

## How money moves

1. **Deposit** — the client puts the wallet on the configured Robinhood Chain
   network (`wallet_switchEthereumChain`, adding it from the table if needed)
   and sends an ERC-20 `transfer` of 10,000 $FIGHT10 to escrow, signed with the
   connected Ethereum wallet.
2. **Verified join** — `f10join` checks the transaction receipt on-chain
   (status, token contract, sender = the player's own wallet, destination =
   escrow, exact amount via the `Transfer` event log) before a seat is taken.
3. **Payout** — `f10treasurer` re-verifies every deposit, atomically claims the
   payout slot, then signs an ERC-20 transfer of 90% of the pot from escrow to
   the winner and records the hash + nonce **before** broadcasting it, so a
   retry can never double-pay.

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
npm run dev    # http://localhost:3000 (port must match Supabase Site URL for SIWE)
npm run build
```

Database: apply `supabase/migrations/*.sql` in order (or `supabase/fresh_setup.sql`
on a fresh project). Auth uses Supabase **Sign in with Web3 (Ethereum / SIWE)** —
enable the Web3 provider (Ethereum) in the Supabase dashboard. The home chat +
running vote use **Realtime Postgres Changes**: the `20260817_home_chat`
migration adds `chat_messages` and `chat_poll` to the `supabase_realtime`
publication, so no dashboard toggle is needed.

### Moving from the Solana build

`supabase/migrations/20260905_robinhood_chain_return.sql` carries an existing
(Solana-era) database across: wallet / deposit comparisons become
case-insensitive again, the `lower(deposit_tx)` replay indexes return, and new
payout rows default to 18 decimals. Rows from matches that settled on Solana are
left untouched; the payout functions refuse to reconcile a non-`0x` deposit or
payout hash rather than misread it. Go-live steps: enable the Supabase **Web3
(Ethereum)** provider, apply the migration, set the client `VITE_*` vars and the
edge-function secrets above to the ERC-20 / escrow on Robinhood Chain, and fund
the escrow with ETH for gas.
