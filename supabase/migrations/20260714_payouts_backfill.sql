-- ============================================================================
-- Payout ledger backfill.
-- ----------------------------------------------------------------------------
-- The admin "All payouts" tab and the player-facing explorer links read from
-- public.payouts, but ledger writes are best-effort: a payout that landed
-- on-chain while the insert failed (or before the ledger existed) has no row.
-- This migration (1) makes sure the table exists (idempotent copy of
-- 20260630_payouts.sql, in case that file was never applied), then
-- (2) backfills one row per paid match from public.matches — the source of
-- truth — using 90% of the pot, the same split the treasurer pays.
--
-- Safe to run repeatedly.
-- ============================================================================

create table if not exists public.payouts (
  match_id       uuid     not null references public.matches(id) on delete cascade,
  winner_user_id uuid     not null references auth.users(id) on delete cascade,
  payout_tx      text     not null,
  amount_raw     bigint   not null,
  decimals       smallint not null default 6,
  num_players    int      not null default 0,
  created_at     timestamptz not null default now(),
  primary key (match_id)
);

create index if not exists idx_payouts_winner on public.payouts(winner_user_id, created_at desc);

alter table public.payouts enable row level security;

drop policy if exists "payouts_select_own" on public.payouts;
create policy "payouts_select_own"
on public.payouts for select to authenticated
using (winner_user_id = auth.uid());

grant select on public.payouts to authenticated;

-- Backfill: every finished match with a real (non-'pending') payout signature
-- gets a ledger row. Amount is 90% of the raw pot ((pot * 9) / 10 in integer
-- math, matching the treasurer's (total * 900) / 1000); num_players from the
-- actual seats, falling back to the lobby size.
insert into public.payouts (match_id, winner_user_id, payout_tx, amount_raw, decimals, num_players, created_at)
select m.id,
       m.winner_user_id,
       m.payout_tx,
       (m.pot_tokens * 9) / 10,
       6,
       coalesce(nullif((select count(*) from public.match_players mp where mp.match_id = m.id), 0), m.max_players),
       coalesce(m.payout_claimed_at, m.ended_at, m.created_at)
from public.matches m
where m.status = 'finished'
  and m.winner_user_id is not null
  and m.payout_tx is not null
  and m.payout_tx <> 'pending'
on conflict (match_id) do nothing;
