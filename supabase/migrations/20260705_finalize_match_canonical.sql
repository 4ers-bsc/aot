-- ============================================================================
-- CANONICAL settlement path — single source of truth for finalize_match().
-- ----------------------------------------------------------------------------
-- The winner-selection logic churned through many incremental redefinitions
-- while the disconnect / walkover / dispute semantics were being worked out:
--
--   20260626_split_finish_finalize.sql   -- finish/finalize split
--   20260627_shadow_damage_ledger.sql    -- shadow ledger (comparison only)
--   20260628_phase2_authoritative.sql    -- ledger becomes authoritative
--   20260629_fixed_5min_settlement.sql   -- fixed settlement deadline
--   20260629_match_config.sql            -- per-lobby duration from config
--   20260630_anticheat.sql               -- cap / flag integration
--   20260701_dc_settle.sql               -- disconnect settlement
--   20260702_dc_walkover.sql             -- lone-survivor walkover
--   20260703_dc_do_nothing.sql           -- DC = do nothing (reverted below)
--   20260704_dc_settle.sql               -- surviving player wins (current)
--
-- Those migrations remain in the tree for historical fidelity (they have run
-- against live databases and must not be edited). This migration re-states the
-- FINAL intended behaviour in one place so future changes have a single
-- canonical definition to edit instead of adding yet another patch. It is
-- byte-for-byte equivalent in behaviour to 20260704_dc_settle.sql plus the
-- config-driven close_stale_matches from 20260629_match_config.sql.
--
-- SEMANTICS (authoritative):
--   * Winner HP is derived from damage OTHERS reported dealing to each player
--     (match_damage), never from self-reported final_hp.
--   * Per-pair fire-rate cap and per-attacker total-DPS cap gate the ledger;
--     an attacker who dealt physically impossible damage is flagged.
--   * A flagged player can never win; a disconnected player (stale heartbeat,
--     no report past the grace window) is excluded from winner selection.
--   * No combat at all + exactly one live player  -> that player wins (walkover).
--   * No combat at all + more than one live player -> disputed (no contest).
--   * Ledger yields no clean, unflagged, connected winner -> disputed.
--   * disputed = no winner, no payout, deposits held.
--
-- Safe to run on an existing project (idempotent; create or replace).
-- ============================================================================

create or replace function public.finalize_match(p_match_id uuid, p_force boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status     text;
  v_maxp       smallint;
  v_started    timestamptz;
  v_deadline   timestamptz;
  v_ended      timestamptz;
  v_secs       numeric;
  v_unreported int;
  v_dmg_total  bigint;
  v_winner     uuid;
  v_forfeited  uuid[];
  v_live       uuid[];
  v_disputed   boolean := false;
  v_meta       jsonb;
  -- Physical ceilings (buffered over real weapon stats: sword ~40 dps,
  -- ~1.4 hits/s). These gate real payouts. Tune from shadow_meta data.
  c_max_dps      constant numeric := 50;   -- per attacker, total across all victims
  c_max_firerate constant numeric := 4;    -- hits per second, per attacker->victim pair
  c_dc_grace     constant interval := interval '15 seconds';
begin
  select status, started_at, max_players into v_status, v_started, v_maxp
  from matches where id = p_match_id for update;
  if v_status is null                     then raise exception 'match_not_found'; end if;
  if v_status in ('finished', 'disputed') then return; end if;

  v_deadline := coalesce(v_started, now()) + make_interval(secs => public.match_duration_seconds(v_maxp));

  -- Count players who still owe a report AND are still live (fresh heartbeat).
  -- A disconnected player never blocks settlement.
  select count(*) filter (where final_hp is null and last_seen >= now() - c_dc_grace)
    into v_unreported
  from match_players where match_id = p_match_id;

  -- Without force, hold the match open until every live player reports OR the
  -- match clock has elapsed past its settlement deadline.
  if not p_force and v_unreported > 0 and now() < v_deadline then
    return;
  end if;

  v_ended := now();
  v_secs  := greatest(5, extract(epoch from (v_ended - coalesce(v_started, v_ended))));

  select coalesce(sum(total_damage), 0) into v_dmg_total
  from match_damage where match_id = p_match_id;

  -- No combat recorded at all: a lone live player wins by walkover; otherwise
  -- there is no real contest, so nobody is crowned.
  if v_dmg_total = 0 then
    select coalesce(array_agg(user_id), '{}') into v_live
    from match_players
    where match_id = p_match_id
      and not (final_hp is null and last_seen < now() - c_dc_grace);

    if array_length(v_live, 1) = 1 then
      update matches
        set status = 'finished', winner_user_id = v_live[1], ended_at = v_ended,
            shadow_winner = v_live[1], forfeited_user_ids = '{}',
            shadow_meta = jsonb_build_object('reason', 'walkover', 'secs', v_secs)
        where id = p_match_id and status not in ('finished', 'disputed');
      if found then
        perform public.apply_match_result(p_match_id, v_live[1]);
      end if;
    else
      update matches
        set status = 'disputed', winner_user_id = NULL, ended_at = v_ended,
            shadow_winner = NULL,
            shadow_meta = jsonb_build_object('reason', 'no_combat', 'secs', v_secs)
        where id = p_match_id and status not in ('finished', 'disputed');
    end if;
    return;
  end if;

  with raw as (
    select attacker, victim, total_damage, hit_count,
           greatest(2, (last_t_ms - first_t_ms) / 1000.0) as win_secs
    from match_damage where match_id = p_match_id
  ),
  attacker_totals as (                       -- per-attacker TOTAL output over their active window
    select attacker,
           sum(total_damage) as out_total,
           greatest(2, (max(last_t_ms) - min(first_t_ms)) / 1000.0) as out_secs
    from match_damage where match_id = p_match_id
    group by attacker
  ),
  flagged as (                               -- attackers who dealt the physically impossible
    select attacker from attacker_totals
    where out_total > (c_max_dps * out_secs)
  ),
  valid as (                                 -- per-pair capped, fire-rate filtered
    select victim, least(total_damage, (c_max_dps * win_secs)::int) as dmg
    from raw
    where hit_count <= c_max_firerate * win_secs
  ),
  hp as (                                    -- HP = 100 - incoming (from OTHERS)
    select mp.user_id, mp.seat, mp.final_hp, mp.last_seen,
           greatest(0, 100 - coalesce(sum(v.dmg), 0))::int as hp
    from match_players mp
    left join valid v on v.victim = mp.user_id
    group by mp.user_id, mp.seat, mp.final_hp, mp.last_seen
  ),
  ranked as (                                -- flagged/disconnected sink to the bottom
    select h.user_id, h.hp, h.seat,
           (f.attacker is not null) as is_flagged,
           (h.final_hp is null and h.last_seen < now() - c_dc_grace) as is_dc,
           row_number() over (
             order by (f.attacker is not null
                       or (h.final_hp is null and h.last_seen < now() - c_dc_grace)) asc,
                      h.hp desc, h.seat asc
           ) as rn
    from hp h
    left join flagged f on f.attacker = h.user_id
  )
  select
    (select user_id from ranked where rn = 1 and not is_flagged and not is_dc),
    (select coalesce(array_agg(user_id), '{}') from ranked where is_flagged),
    jsonb_build_object(
      'secs',  v_secs,
      'caps',  jsonb_build_object('dps', c_max_dps, 'firerate', c_max_firerate),
      'hp',    (select jsonb_agg(jsonb_build_object('user_id', user_id, 'hp', hp, 'seat', seat, 'flagged', is_flagged, 'dc', is_dc)
                                 order by hp desc, seat asc) from ranked),
      'flagged',      (select coalesce(jsonb_agg(attacker), '[]'::jsonb) from flagged),
      'disconnected', (select coalesce(jsonb_agg(user_id), '[]'::jsonb) from ranked where is_dc),
      'attacker_out', (select jsonb_object_agg(attacker::text, out_total) from attacker_totals)
    )
    into v_winner, v_forfeited, v_meta;

  if v_winner is null then v_disputed := true; end if;

  if v_disputed then
    update matches
      set status = 'disputed', winner_user_id = NULL, ended_at = v_ended,
          shadow_winner = NULL, shadow_meta = v_meta, forfeited_user_ids = v_forfeited
      where id = p_match_id and status not in ('finished', 'disputed');
  else
    update matches
      set status = 'finished', winner_user_id = v_winner, ended_at = v_ended,
          shadow_winner = v_winner, shadow_meta = v_meta, forfeited_user_ids = v_forfeited
      where id = p_match_id and status not in ('finished', 'disputed');
    if found then
      perform public.apply_match_result(p_match_id, v_winner);
    end if;
  end if;
end;
$$;

grant execute on function public.finalize_match(uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- close_stale_matches — timeout backstop, routed through the canonical settler
-- using the per-lobby duration from match_config (single source of truth).
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
      and m.started_at < now() - make_interval(secs => public.match_duration_seconds(m.max_players))
    for update of m skip locked
  loop
    perform public.finalize_match(r.id, true);   -- force-settle from the ledger
    v_closed := v_closed + 1;
  end loop;

  return v_closed;
end;
$$;
