-- ---------------------------------------------------------------------------
-- Migration: count cash-flow "incoming" at each match's own entry fee.
--
-- The ops dashboard's Cash flow tab computed incoming as
--   (number of paid seats) × a hardcoded 10,000 $GULAG
-- which is wrong for any match played at a different fee. Every match now
-- freezes its fee at creation (matches.entry_fee_tokens), so sum that per
-- seat instead. Done server-side so the total stays exact for any number of
-- seats (PostgREST can't aggregate, and the tab must not page through rows).
-- Seats on matches that predate the snapshot count at the historical 10,000,
-- exactly as before.
--
-- Filters mirror the tab's: deposit time range, deposit-wallet substring, and
-- an optional set of match ids (an empty array matches nothing).
--
-- Service role only (f10admin). Until this is applied, f10admin falls back to
-- the old flat-fee estimate and the tab says so.
--
-- Safe to run (and re-run) on an existing database. Kept in sync with
-- fresh_setup.sql §22.
-- ---------------------------------------------------------------------------

create or replace function public.admin_cashflow_incoming(
  p_from      timestamptz default null,
  p_to        timestamptz default null,
  p_wallet    text        default null,
  p_match_ids uuid[]      default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'count',        count(*),
    'total_tokens', coalesce(sum(coalesce(m.entry_fee_tokens, 10000)), 0)
  )
  from public.match_players mp
  join public.matches m on m.id = mp.match_id
  where mp.deposit_tx is not null
    and (p_from      is null or mp.joined_at >= p_from)
    and (p_to        is null or mp.joined_at <= p_to)
    and (p_wallet    is null or mp.deposit_wallet ilike '%' || p_wallet || '%')
    and (p_match_ids is null or mp.match_id = any (p_match_ids));
$$;

revoke all on function public.admin_cashflow_incoming(timestamptz, timestamptz, text, uuid[]) from public, anon, authenticated;
grant execute on function public.admin_cashflow_incoming(timestamptz, timestamptz, text, uuid[]) to service_role;
