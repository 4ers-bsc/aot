-- ============================================================================
-- Enforce maintenance mode SERVER-SIDE.
-- ----------------------------------------------------------------------------
-- The `maintain` switch (20260718) drives a client overlay, but that overlay is
-- just DOM — anyone can delete it from the console. The only authoritative place
-- to stop play is the server. Every PvP seat is created by an INSERT into
-- match_players (from join_pvp_match, service-role), so a BEFORE INSERT trigger
-- there blocks ALL new seats while maintenance is on, no matter what the client
-- does or which join_pvp_match revision is deployed. It runs inside the join
-- transaction, so the consumed-deposit record and pot bump roll back with it —
-- the deposit tx stays unconsumed and can be used once maintenance is lifted.
--
-- Scope is deliberately "no NEW matches": in-flight matches can still settle and
-- pay out (finalize_match / payouts are untouched) so maintenance never strands
-- a live game or escrowed funds.
--
-- Safe to run on an existing project (idempotent).
-- ============================================================================

-- Is the game currently under maintenance? Reads the single-row switch.
create or replace function public.is_maintenance()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select lower(trim(value)) = 'y' from public.maintain limit 1), false);
$$;
revoke all on function public.is_maintenance() from public;
grant execute on function public.is_maintenance() to authenticated, anon, service_role;

-- Reject any new seat while maintenance is on.
create or replace function public.block_join_during_maintenance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_maintenance() then
    raise exception 'maintenance: the game is under maintenance — please try again later';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_block_join_maintenance on public.match_players;
create trigger trg_block_join_maintenance
  before insert on public.match_players
  for each row execute function public.block_join_during_maintenance();
