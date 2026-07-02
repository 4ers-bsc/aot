-- ============================================================================
-- finalize_match: an early all-reported settlement must be CONCLUSIVE.
-- ----------------------------------------------------------------------------
-- The "match-over" Realtime broadcast is unauthenticated — any client in the
-- channel can send it. Every honest client that received it reported "done"
-- via finish_match, and finalize_match settled as soon as v_unreported hit 0.
-- A hacked client broadcasting "match-over" seconds into the match therefore
-- voided it: no combat recorded → 'disputed' → every deposit held. The griefer
-- lost one entry fee but burned up to nine other players' deposits per match.
--
-- Fix: before the hard deadline (and when not forced), an all-reported
-- settlement is only honoured when the outcome is conclusive:
--   • some victim's recorded damage reaches lethal total (>= 100), or
--   • at most one player is still connected (walkover).
-- Otherwise finalize_match returns and the match stays active — honest
-- clients keep playing (they also now verify the broadcast against the
-- ledger before reporting), and the timer/deadline path settles as before.
-- The lethal-total check uses raw sums on purpose: a cheater who fakes a
-- lethal row to force an early settle still goes through the capped/flagged
-- ranking below, gets forfeited, and hands the win to a clean player.
--
-- CANONICAL DEFINITION of finalize_match. Kept byte-for-byte in sync with
-- supabase/fresh_setup.sql section 8b — edit both together.
-- Safe to run on an existing project (idempotent).
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
  v_live_n     int;
  v_dmg_total  bigint;
  v_winner     uuid;
  v_forfeited  uuid[];
  v_live       uuid[];
  v_disputed   boolean := false;
  v_meta       jsonb;
  -- Physical ceilings (buffer over real stats: sword ~40 dps, ~1.4 hits/s).
  c_max_dps      constant numeric := 50;   -- per attacker, total across all victims
  c_max_firerate constant numeric := 4;    -- hits per second, per attacker→victim pair
  -- A player is "disconnected" once its heartbeat lapses past this window.
  c_dc_grace     constant interval := interval '15 seconds';
begin
  select status, started_at, max_players into v_status, v_started, v_maxp
  from matches where id = p_match_id for update;
  if v_status is null                     then raise exception 'match_not_found'; end if;
  if v_status in ('finished', 'disputed') then return; end if;

  -- Hard cap from match_config (per lobby size). Before it, hold open until
  -- everyone reports; after it (or on force), settle from the ledger now.
  v_deadline := coalesce(v_started, now()) + make_interval(secs => public.match_duration_seconds(v_maxp));

  -- Only WAIT on players who are still connected and haven't reported.
  -- Disconnected (stale heartbeat) players never block settlement.
  select count(*) filter (where final_hp is null and last_seen >= now() - c_dc_grace)
    into v_unreported
  from match_players where match_id = p_match_id;

  if not p_force and v_unreported > 0 and now() < v_deadline then
    return;
  end if;

  -- Early-report guard: before the deadline, everyone reporting is not by
  -- itself proof the match is over — a spoofed "match-over" broadcast can
  -- push every honest client to report seconds in. Only settle early when
  -- the ledger shows a lethal total against someone, or at most one player
  -- is still connected (walkover). Otherwise hold the match open; the
  -- deadline path settles it as usual.
  if not p_force and now() < v_deadline then
    select count(*) into v_live_n
    from match_players
    where match_id = p_match_id
      and not (final_hp is null and last_seen < now() - c_dc_grace);

    if v_live_n > 1 and not exists (
      select 1 from match_damage
      where match_id = p_match_id
      group by victim
      having sum(total_damage) >= 100
    ) then
      return;
    end if;
  end if;

  v_ended := now();
  v_secs  := greatest(5, extract(epoch from (v_ended - coalesce(v_started, v_ended))));

  select coalesce(sum(total_damage), 0) into v_dmg_total
  from match_damage where match_id = p_match_id;

  if v_dmg_total = 0 then
    -- No combat recorded. If everyone but one player has disconnected, that
    -- player wins by walkover (last one standing). Otherwise it's a genuine
    -- no-contest (e.g. nobody fought before the timer) → disputed.
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
    -- win_secs = how long this attacker→victim damage actually spanned, so the
    -- cap is a RATE. A match may run 5 min, but damage dealt in a 2s burst is
    -- still capped at 2s worth — this is what catches a burst insta-kill.
    select attacker, victim, total_damage, hit_count,
           greatest(2, (last_t_ms - first_t_ms) / 1000.0) as win_secs
    from match_damage where match_id = p_match_id
  ),
  attacker_totals as (
    select attacker,
           sum(total_damage) as out_total,
           greatest(2, (max(last_t_ms) - min(first_t_ms)) / 1000.0) as out_secs
    from match_damage where match_id = p_match_id
    group by attacker
  ),
  flagged as (
    select attacker from attacker_totals
    where out_total > (c_max_dps * out_secs)
  ),
  valid as (
    select victim, least(total_damage, (c_max_dps * win_secs)::int) as dmg
    from raw
    where hit_count <= c_max_firerate * win_secs
  ),
  hp as (
    -- The match_id filter here is essential: without it every player in every
    -- match is ranked, and a concurrent match's player could be crowned winner
    -- of THIS match (winner_user_id is who the treasurer pays).
    select mp.user_id, mp.seat, mp.final_hp, mp.last_seen,
           greatest(0, 100 - coalesce(sum(v.dmg), 0))::int as hp
    from match_players mp
    left join valid v on v.victim = mp.user_id
    where mp.match_id = p_match_id
    group by mp.user_id, mp.seat, mp.final_hp, mp.last_seen
  ),
  ranked as (
    select h.user_id, h.hp, h.seat,
           (f.attacker is not null) as is_flagged,
           -- Disconnected AND never reported → eliminated (a player who reported
           -- before leaving keeps their standing).
           (h.final_hp is null and h.last_seen < now() - c_dc_grace) as is_dc,
           row_number() over (
             -- Clean, connected players rank first; among them, highest HP then seat.
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

  -- Disputed only if no clean player can win (e.g. everyone flagged).
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
