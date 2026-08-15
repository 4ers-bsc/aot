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
| `VITE_FIGHT10_DECIMALS` | Token decimals | `9` |
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

## Development

```sh
npm install
npm run dev    # http://localhost:3000 (port must match Supabase Site URL for SIWS)
npm run build
```

Database: apply `supabase/migrations/*.sql` in order (or `supabase/fresh_setup.sql`
on a fresh project). Auth uses Supabase **Sign in with Web3 (Solana / SIWS)** —
enable the Web3 provider (Solana) in the Supabase dashboard.
