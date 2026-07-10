# FIGHT10 — last one standing

Skill-based PvP arena on **Robinhood Chain** (an Ethereum L2 built on the
Arbitrum Orbit stack). Players stake 2,500 $FIGHT10 (a standard ERC-20) to
enter; the last fighter alive takes 90% of the pot, paid from escrow and
verified on-chain end to end.

## Networks: testnet ⇄ mainnet

The whole stack reads its network from **one table**, defined in
[`src/network.js`](src/network.js) for the client and mirrored in each
Supabase edge function (`f10join`, `f10treasurer`, `f10admin`):

| | Testnet (default) | Mainnet |
|---|---|---|
| **Network name** | Robinhood Chain Testnet | Robinhood Chain |
| **Chain ID** | `46630` (`0xb626`) | `4663` (`0x1237`) |
| **RPC URL** | `https://rpc.testnet.chain.robinhood.com/rpc` | `https://rpc.mainnet.chain.robinhood.com` |
| **Explorer (Blockscout)** | `https://explorer.testnet.chain.robinhood.com` | `https://robinhoodchain.blockscout.com` |
| **Native currency (gas)** | ETH | ETH |
| **Faucet** | `https://faucet.testnet.chain.robinhood.com` | — |

### How to switch

| Where | Setting | Values |
|---|---|---|
| Client (Vite) | `VITE_NETWORK` | `testnet` (default) \| `mainnet` |
| Edge functions (Supabase secrets) | `NETWORK` | `testnet` (default) \| `mainnet` |

Both must be flipped **together** — the client deposits on the network it is
built for, and the edge functions verify deposits and send payouts on the
network their secret selects. Everything downstream (wallet add/switch-chain
prompts, the read RPC, every Blockscout link) follows the table automatically.

## Configuration

### Client (`VITE_*` env vars)

| Variable | Purpose | Default |
|---|---|---|
| `VITE_NETWORK` | `testnet` or `mainnet` (table above) | `testnet` |
| `VITE_FIGHT10_TOKEN` | $FIGHT10 ERC-20 contract address | placeholder |
| `VITE_ESCROW_WALLET` | Escrow wallet address (public) | placeholder |
| `VITE_FIGHT10_DECIMALS` | Token decimals | `18` |
| `VITE_ROBINHOOD_RPC_URL` | Override the network's public RPC (e.g. a dedicated key) | table RPC |
| `VITE_BUY_FIGHT10_URL` | "Buy $FIGHT10" link (e.g. a DEX swap URL) | token's explorer page |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | Supabase project | — |

### Edge functions (Supabase secrets)

| Secret | Used by | Purpose |
|---|---|---|
| `NETWORK` | all three | `testnet` or `mainnet` (table above) |
| `FIGHT10_TOKEN` | all three | $FIGHT10 ERC-20 contract address |
| `ESCROW_WALLET` | `f10join` | Escrow **public** address (deposit destination) |
| `ESCROW_PRIVATE_KEY` | `f10treasurer`, `f10admin` | Escrow signer, 0x-prefixed hex — only the payout functions hold it |
| `RPC_URL`, `RPC_URL_2`, `RPC_URL_3` | all three | Optional RPC pool (round-robin + failover); falls back to the table RPC |
| `FIGHT10_DECIMALS` | `f10admin` | Dashboard display decimals (on-chain paths read `decimals()` live) |
| `APP_ORIGIN` | all three | Locks CORS to the game origin |
| `ADMIN_USER_IDS` / `ADMIN_WALLETS` | `f10admin` | Ops dashboard allowlist |

## How money moves

1. **Deposit** — the client puts the wallet on the configured Robinhood Chain
   network (`wallet_switchEthereumChain`, adding it from the table if needed)
   and sends an ERC-20 `transfer` of 2,500 $FIGHT10 to escrow.
2. **Verified join** — `f10join` checks the transaction receipt on-chain
   (status, token contract, sender = the player's own wallet, destination =
   escrow, exact amount via the `Transfer` event log) before a seat is taken.
3. **Payout** — `f10treasurer` re-verifies every deposit, atomically claims
   the payout slot, then signs an ERC-20 transfer of 90% of the pot from
   escrow to the winner and records the confirmed hash.

## Development

```sh
npm install
npm run dev    # http://localhost:3000 (port must match Supabase Site URL for SIWE)
npm run build
```

Database: apply `supabase/migrations/*.sql` in order (or `supabase/fresh_setup.sql`
on a fresh project). Auth uses Supabase **Sign in with Web3 (Ethereum / SIWE)** —
enable the Web3 provider in the Supabase dashboard.
