-- ============================================================================
-- Option A — Phase 2: the combat ledger becomes AUTHORITATIVE.
-- ----------------------------------------------------------------------------
-- finalize_match now decides the winner from match_damage (validated by a
-- per-pair cap AND a new per-attacker TOTAL-output cap) instead of the
-- self-reported final_hp. If the ledger cannot produce a clean, plausible
-- winner — or the player who would win dealt physically impossible damage —
-- the match is marked 'disputed': no winner, no payout, deposits held.
--
-- The payout function needs no change: it only pays when status = 'finished'
-- AND winner_user_id = caller, so a 'disputed' match (status != finished,
-- winner NULL) is already unclaimable.
--
-- Safe to run on an existing project (idempotent).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Allow the new 'disputed' status
-- ---------------------------------------------------------------------------
alter table public.matches drop constraint if exists matches_status_check;
alter table public.matches add constraint matches_status_check
  check (status in ('waiting', 'active', 'finished', 'disputed'));

-- ---------------------------------------------------------------------------
-- 2. finalize_match — ledger-authoritative settlement
-- ---------------------------------------------------------------------------
-- p_force = true settles even if some players never reported (used by the
-- stale-match sweeper on timeout). Otherwise it waits until everyone reported.
drop function if exists public.finalize_match(uuid);

create or replace function public.finalize_match(p_match_id uuid, p_force boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status     text;
  v_started    timestamptz;
  v_ended      timestamptz;
  v_secs       numeric;
  v_unreported int;
  v_dmg_total  bigint;
  v_winner     uuid;
  v_disputed   boolean := false;
  v_meta       jsonb;
  -- Physical ceilings (with buffer over real weapon stats: sword ~40 dps,
  -- ~1.4 hits/s). Tune from shadow data. These now gate real payouts.
  c_max_dps      constant numeric := 50;   -- per attacker, total across all victims
  c_max_firerate constant numeric := 4;    -- hits per second, per attacker→victim pair
begin
  select status, started_at into v_status, v_started
  from matches where id = p_match_id for update;
  if v_status is null                       then raise exception 'match_not_found'; end if;
  if v_status in ('finished', 'disputed')   then return; end if;

  select count(*) filter (where final_hp is null) into v_unreported
  from match_players where match_id = p_match_id;

  -- Without force, hold the match open until every player has reported in.
  if not p_force and v_unreported > 0 then
    return;
  end if;

  v_ended := now();
  v_secs  := greatest(5, extract(epoch from (v_ended - coalesce(v_started, v_ended))));

  -- No combat recorded at all → no real contest. Refuse to crown anyone.
  select coalesce(sum(total_damage), 0) into v_dmg_total
  from match_damage where match_id = p_match_id;

  if v_dmg_total = 0 then
    update matches
      set status = 'disputed', winner_user_id = NULL, ended_at = v_ended,
          shadow_winner = NULL,
          shadow_meta = jsonb_build_object('reason', 'no_combat', 'secs', v_secs)
      where id = p_match_id and status not in ('finished', 'disputed');
    return;
  end if;

  with raw as (
    select attacker, victim, total_damage, hit_count
    from match_damage where match_id = p_match_id
  ),
  attacker_totals as (                       -- per-attacker TOTAL output
    select attacker, sum(total_damage) as out_total
    from raw group by attacker
  ),
  flagged as (                               -- attackers who dealt the impossible
    select attacker from attacker_totals
    where out_total > (c_max_dps * v_secs)
  ),
  valid as (                                 -- per-pair capped, fire-rate filtered
    select victim, least(total_damage, (c_max_dps * v_secs)::int) as dmg
    from raw
    where hit_count <= c_max_firerate * v_secs
  ),
  hp as (                                    -- HP = 100 − incoming (from OTHERS)
    select mp.user_id, mp.seat,
           greatest(0, 100 - coalesce(sum(v.dmg), 0))::int as hp
    from match_players mp
    left join valid v on v.victim = mp.user_id
    group by mp.user_id, mp.seat
  ),
  ranked as (
    select user_id, hp, seat,
           row_number() over (order by hp desc, seat asc) as rn
    from hp
  )
  select
    (select user_id from ranked where rn = 1),
    -- dispute when the would-be winner dealt physically impossible damage
    exists (select 1 from flagged f join ranked r on r.user_id = f.attacker and r.rn = 1),
    jsonb_build_object(
      'secs',  v_secs,
      'caps',  jsonb_build_object('dps', c_max_dps, 'firerate', c_max_firerate),
      'hp',    (select jsonb_agg(jsonb_build_object('user_id', user_id, 'hp', hp, 'seat', seat)
                                 order by hp desc, seat asc) from ranked),
      'flagged',      (select coalesce(jsonb_agg(attacker), '[]'::jsonb) from flagged),
      'attacker_out', (select jsonb_object_agg(attacker::text, out_total) from attacker_totals)
    )
    into v_winner, v_disputed, v_meta;

  if v_winner is null then v_disputed := true; end if;

  if v_disputed then
    update matches
      set status = 'disputed', winner_user_id = NULL, ended_at = v_ended,
          shadow_winner = v_winner, shadow_meta = v_meta
      where id = p_match_id and status not in ('finished', 'disputed');
  else
    update matches
      set status = 'finished', winner_user_id = v_winner, ended_at = v_ended,
          shadow_winner = v_winner, shadow_meta = v_meta
      where id = p_match_id and status not in ('finished', 'disputed');
    if found then
      perform public.apply_match_result(p_match_id, v_winner);
    end if;
  end if;
end;
$$;

grant execute on function public.finalize_match(uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 3. close_stale_matches — route timeouts through the authoritative settler
-- ---------------------------------------------------------------------------
create or replace function public.close_stale_matches()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_closed int := 0;
  r        record;
begin
  for r in
    select m.id
    from matches m
    where m.status     = 'active'
      and m.started_at is not null
      and m.started_at < now() - (
        case m.max_players
          when 2  then interval '10 minutes'
          when 5  then interval '15 minutes'
          when 10 then interval '20 minutes'
          else         interval '20 minutes'
        end
      )
    for update of m skip locked
  loop
    perform public.finalize_match(r.id, true);   -- force-settle from the ledger
    v_closed := v_closed + 1;
  end loop;

  return v_closed;
end;
$$;
