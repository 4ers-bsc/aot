# Age of Trenches — Vite + Supabase PvP Foundation

This repo is now a Vite app backed by Supabase for a two-player PvP duel foundation.

Auth modes:
- Solana wallet via Supabase Web3 auth: full player account, inventory, wallet-bound PvP progression, and gold escrow matches.
- Anonymous Supabase auth: spectator-only session that can watch a random live PvP room but cannot queue or touch escrow.

Assumption used for this implementation:
- "2v2 player where both enter with 10 gold" was interpreted as a two-player head-to-head duel where each player escrows 10 gold and the winner receives the 20-gold pot.

## What is included

- Browser client with:
  - Solana Web3 wallet sign-in for players
  - anonymous spectator sign-in
  - wallet display
  - display-name editing
  - stored inventory and loadout
  - recent PvP history
  - match queue / cancel / forfeit / result claim actions
  - private Realtime player room plus spectator room
  - lightweight synced duel arena with spectator mode
- Supabase SQL migration with:
  - `profiles`
  - `matches`
  - `match_players`
  - `wallet_ledger`
  - `match_result_claims`
  - `item_catalog`
  - `player_inventory`
  - `player_loadouts`
  - `pvp_match_events`
  - RLS policies
  - Realtime channel authorization policies
  - SQL functions for wallet sync, loadouts, escrow, refund, result confirmation, and payout
- Supabase Edge Function:
  - `matchmaking`

## Security model

This setup secures the money path, which is the important part to keep off the client:

- The browser only uses the Supabase publishable/anon key.
- Gold balance changes happen only in Postgres functions called from an Edge Function using service-role privileges.
- Clients cannot directly update `gold_balance`.
- Player and spectator channels are private and gated by Realtime RLS.
- A single player cannot unilaterally take the pot.
  - The payout only happens when both players submit the same `winner_user_id`, or
  - one player explicitly forfeits.
- Anonymous users can spectate, but queueing requires a wallet-backed profile with `can_compete = true`.

Important limitation:
- This is not yet a fully authoritative anti-cheat combat server.
- Realtime movement and attack events are peer-synced for the prototype arena.
- That means the match economy is protected, but the combat loop is not production-grade esports security yet.
- For fully cheat-resistant combat, move hit validation and simulation authority to a dedicated server process.

## Local development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a local env file from [.env.example](/Users/aj/Documents/Age%20of%20Trenches/.env.example):
   ```bash
   cp .env.example .env.local
   ```
3. Set:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Start Vite:
   ```bash
   npm run dev
   ```

The UI will auto-connect from Vite env vars when those values are present. Manual entry in the sidebar still works for quick testing.

## Supabase setup

1. Create a Supabase project.
2. Enable Anonymous Sign-Ins in Auth.
3. Enable Web3 Wallet auth for Solana in Auth.
4. Add your Vercel production URL and preview wildcard to Supabase Redirect URLs, because Web3 sign-in validates the signing page URL. Example:
   - `https://your-app.vercel.app/**`
   - `https://your-team-your-app-*.vercel.app/**`
5. Run the SQL in:
   - [supabase/migrations/20260622_pvp_foundation.sql](/Users/aj/Documents/Age%20of%20Trenches/supabase/migrations/20260622_pvp_foundation.sql)
   - [supabase/migrations/20260622_web3_player_progression.sql](/Users/aj/Documents/Age%20of%20Trenches/supabase/migrations/20260622_web3_player_progression.sql)
6. Deploy the Edge Function in [supabase/functions/matchmaking/index.ts](/Users/aj/Documents/Age%20of%20Trenches/supabase/functions/matchmaking/index.ts).
7. In Realtime settings, use private channels with the provided RLS policies on `realtime.messages`.
8. Use your project values in Vite env vars or enter them in the config card.

## Vercel deployment

1. Import this repo into Vercel.
2. Framework preset:
   - `Vite`
3. Build command:
   - `npm run build`
4. Output directory:
   - `dist`
5. Add environment variables in Vercel:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
6. Redeploy after adding env vars.

## Notes

- New users start with 10 gold by default so each player can enter one duel immediately.
- The winner takes the full 20-gold pot when a match settles.
- Anonymous users are still authenticated users in Supabase, so RLS applies to them the same way it does for normal accounts.
- Before production, add CAPTCHA to anonymous sign-ins to reduce abuse.
