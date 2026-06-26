-- ---------------------------------------------------------------------------
-- Migration: split finish_match into finish_match + finalize_match.
--
-- Previously finish_match() had two responsibilities: it recorded a player's
-- final HP AND, on the same call, selected the winner, applied profile stats
-- and closed the match. This tangled "a player reports their result" with
-- "the match is decided", duplicating the winner-selection logic and making
-- the flow hard to reason about.
--
-- After this migration:
--   * finish_match(match_id, final_hp) records ONLY the caller's HP, then calls
--     finalize_match() to attempt settlement.
--   * finalize_match(match_id) owns winner selection, stats and closure. It is
--     idempotent and a no-op until a winner can be determined, so it is safe to
--     call on every report.
--
-- Behaviour is unchanged: same fast-crown rule, same highest-HP/seat tiebreak,
-- same idempotent stats via apply_match_result. Safe to run on an existing
-- database — run in the Supabase SQL editor.
-- ---------------------------------------------------------------------------

-- finalize_match — decides the winner and closes the match. Server-side; only
-- ever invoked from finish_match (security definer), so no grant to authenticated.
create or replace function public.finalize_match(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status      text;
  v_winner      uuid;
  v_alive_count int;
  v_dead_count  int;
  v_total       int;
  v_unreported  int;
begin
  -- Lock the row to prevent concurrent finalisations.
  select status into v_status from matches where id = p_match_id for update;
  if v_status is null       then raise exception 'match_not_found'; end if;
  if v_status = 'finished'  then return; end if;

  select count(*) into v_total
  from match_players where match_id = p_match_id;

  select count(*) into v_unreported
  from match_players where match_id = p_match_id and final_hp is null;

  select count(*) into v_alive_count
  from match_players where match_id = p_match_id and final_hp is not null and final_hp > 0;

  select count(*) into v_dead_count
  from match_players where match_id = p_match_id and final_hp is not null and final_hp = 0;

  if v_alive_count = 1 and v_dead_count = v_total - 1 then
    -- Fast-crown: exactly one survivor, everyone else confirmed dead (hp=0).
    select user_id into v_winner
    from match_players
    where match_id = p_match_id and final_hp > 0
    limit 1;
  elsif v_unreported = 0 then
    -- Everyone reported — highest HP wins; seat ASC breaks ties.
    select user_id into v_winner
    from match_players
    where match_id = p_match_id
    order by final_hp desc, seat asc
    limit 1;
  else
    -- Not enough reports yet to know the winner — leave the match running.
    return;
  end if;

  update matches
  set winner_user_id = v_winner, status = 'finished', ended_at = now()
  where id = p_match_id and status != 'finished';

  perform public.apply_match_result(p_match_id, v_winner);
end;
$$;

-- finish_match — records ONE player's final HP, then defers to finalize_match.
create or replace function public.finish_match(p_match_id uuid, p_final_hp int default 0)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'not_authenticated';
  end if;

  if not exists (
    select 1 from match_players
    where match_id = p_match_id and user_id = v_caller
  ) then
    raise exception 'not_a_participant';
  end if;

  -- Record caller's HP (clamped 0–100). This is finish_match's only side effect.
  update match_players
  set final_hp = greatest(0, least(100, p_final_hp))
  where match_id = p_match_id and user_id = v_caller;

  -- Settle the match if possible; no-op until enough players have reported.
  perform public.finalize_match(p_match_id);
end;
$$;

grant execute on function public.finish_match(uuid, int) to authenticated;
grant execute on function public.finalize_match(uuid)    to service_role;
