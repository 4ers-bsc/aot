-- ============================================================================
-- Payout ledger — one durable record per winning payout, with the on-chain
-- transaction signature so the client can show an explorer link in the victory
-- screen and in match history. matches.payout_tx remains the source of truth for
-- the claim slot; this table is the user-facing audit record.
--
-- Safe to run on an existing project (idempotent).
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

-- A player can read their own payout records. Inserts come only from the payout
-- edge function via the service role (which bypasses RLS), so there is no insert
-- policy for clients.
drop policy if exists "payouts_select_own" on public.payouts;
create policy "payouts_select_own"
on public.payouts for select to authenticated
using (winner_user_id = auth.uid());

grant select on public.payouts to authenticated;
