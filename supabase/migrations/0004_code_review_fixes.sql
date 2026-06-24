-- Code review fixes: unique deposit constraint, stale-payout TTL, max_players restriction.

-- ---------------------------------------------------------------------------
-- Fix 2: Unique constraint on deposit_tx prevents two players from recording
--        the same on-chain signature (shared-deposit attack).
-- ---------------------------------------------------------------------------
alter table public.match_players
  add constraint match_players_deposit_tx_unique unique (deposit_tx);

-- ---------------------------------------------------------------------------
-- Fix 4 (SQL): Add payout_claimed_at to track when 'pending' was set, so
--              claim_payout_slot can auto-release stale reservations (>10 min)
--              and return true, allowing the winner to retry without manual
--              intervention.
-- ---------------------------------------------------------------------------
alter table public.matches
  add column if not exists payout_claimed_at timestamptz;

create or replace function public.claim_payout_slot(p_match_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  -- Auto-release any stale 'pending' reservation older than 10 minutes.
  update public.matches
  set payout_tx = null, payout_claimed_at = null
  where id              = p_match_id
    and payout_tx       = 'pending'
    and payout_claimed_at < now() - interval '10 minutes';

  -- Atomically claim the slot.
  update public.matches
  set payout_tx = 'pending', payout_claimed_at = now()
  where id              = p_match_id
    and status          = 'finished'
    and winner_user_id  = v_uid
    and payout_tx is null;

  return found;
end;
$$;

grant execute on function public.claim_payout_slot(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Fix 5: Restrict max_players to the three supported lobby sizes (2, 5, 10).
--        Drop the old permissive range check and add an exact-values check.
-- ---------------------------------------------------------------------------
alter table public.matches
  drop constraint if exists matches_max_players_check;

alter table public.matches
  add constraint matches_max_players_check check (max_players in (2, 5, 10));
