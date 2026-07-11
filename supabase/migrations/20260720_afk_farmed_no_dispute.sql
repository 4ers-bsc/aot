-- ============================================================================
-- finalize_match: don't let a farmed, never-present opponent re-contest a win.
-- ----------------------------------------------------------------------------
-- Reported scenario: two players join a PvP. Player 2 is away — their client
-- never actually loaded into the match. Player 1 farms the idle seat and, the
-- moment the ledger shows a lethal total (>=100) against Player 2, reports a
-- win. But the match does NOT settle: match_players.last_seen defaults to now()
-- at JOIN, so for the first 15s (c_dc_grace) the never-present seat still counts
-- as "connected and unreported" and blocks settlement (v_unreported > 0). While
-- Player 1 waits on the payout, Player 2's client finishes loading inside that
-- window, fights back, records its own lethal total against Player 1, and
-- reports. Now BOTH players carry a lethal total and each self-reports a win —
-- the corroboration guard (20260716) sees the loser's self-report contradict
-- the ledger and marks the match 'disputed', freezing the pot on a win Player 1
-- had already earned.
--
-- Fix: a seat that has recorded NO offense of its own yet has already absorbed a
-- lethal total was never in the fight — an away / never-loaded player being
-- farmed. Such a seat no longer blocks settlement, so Player 1's win settles
-- immediately (before the corpse can reconnect and retaliate); Player 2's later
-- combat writes then hit the settled match and are rejected as stale. This does
-- NOT weaken the fabricated-offense corroboration guard: a cheater's victim who
-- was actually fighting has recorded offense of its own and still blocks
-- settlement until it reports, so a fabricated lethal total can never early-
-- settle a match and skip corroboration.
--
-- CANONICAL DEFINITION of finalize_match (supersedes
-- 20260716_ledger_corroboration.sql). Kept byte-for-byte in sync with
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
  v_mismatch   uuid[];
  v_live       uuid[];
  v_disputed   boolean := false;
  v_meta       jsonb;
  -- Physical ceilings (buffer over real stats: sword ~40 dps, ~1.4 hits/s).
  c_max_dps      constant numeric := 50;   -- per attacker, total across all victims
  c_max_firerate constant numeric := 4;    -- hits per second, per attacker→victim pair
  -- A player is "disconnected" once its heartbeat lapses past this window.
  c_dc_grace     constant interval := interval '15 seconds';
  -- Self-report corroboration margin. Honest reports track the ledger closely
  -- (each client applies damage from the same attack events the attacker
  -- records); the slack absorbs grenade-splash variance and a dropped packet
  -- or two, while a fabricated lethal total overshoots it by design.
  c_hp_tolerance constant int := 25;
begin
  select status, started_at, max_players into v_status, v_started, v_maxp
  from matches where id = p_match_id for update;
  if v_status is null                     then raise exception 'match_not_found'; end if;
  if v_status in ('finished', 'disputed') then return; end if;

  -- Hard cap from match_config (per lobby size). Before it, hold open until
  -- everyone reports; after it (or on force), settle from the ledger now.
  v_deadline := coalesce(v_started, now()) + make_interval(secs => public.match_duration_seconds(v_maxp));

  -- Only WAIT on players who are still connected and haven't reported.
  -- Disconnected (stale heartbeat) players never block settlement — and neither
  -- does a NON-PARTICIPANT: a seat that has recorded no offense of its own yet
  -- has already absorbed a lethal total (>=100) was never in the fight. That is
  -- an away / never-loaded player being farmed. last_seen defaults to now() at
  -- join, so for the first 15s such a seat still looks "connected" even though
  -- its client never entered the match; waiting on it holds the decided match
  -- open just long enough for that player to reconnect, land a retaliatory kill
  -- on the winner, and turn a clean win into a corroboration 'disputed' (frozen
  -- pot). Excluding it settles the win immediately, before the corpse can
  -- reanimate. A cheater's victim who was actually fighting has recorded offense
  -- of its own, so this never lets a fabricated-lethal total early-settle a
  -- match and skip the self-report corroboration guard below.
  select count(*) filter (
    where mp.final_hp is null
      and mp.last_seen >= now() - c_dc_grace
      and not (
        coalesce(taken.dmg_in, 0) >= 100
        and not exists (
          select 1 from match_damage o
          where o.match_id = p_match_id and o.attacker = mp.user_id
        )
      )
  )
    into v_unreported
  from match_players mp
  left join (
    select victim, sum(total_damage) as dmg_in
    from match_damage where match_id = p_match_id
    group by victim
  ) taken on taken.victim = mp.user_id
  where mp.match_id = p_match_id;

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
    select h.user_id, h.hp, h.seat, h.final_hp,
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
    -- Corroboration: clean, connected players whose SELF-reported HP sits far
    -- above their ledger-derived HP — the damage the ledger says killed them
    -- was never actually received on their client.
    (select coalesce(array_agg(user_id), '{}') from ranked
      where not is_flagged and not is_dc
        and final_hp is not null
        and final_hp > hp + c_hp_tolerance),
    jsonb_build_object(
      'secs',  v_secs,
      'caps',  jsonb_build_object('dps', c_max_dps, 'firerate', c_max_firerate),
      'hp',    (select jsonb_agg(jsonb_build_object('user_id', user_id, 'hp', hp, 'seat', seat, 'flagged', is_flagged, 'dc', is_dc)
                                 order by hp desc, seat asc) from ranked),
      'flagged',      (select coalesce(jsonb_agg(attacker), '[]'::jsonb) from flagged),
      'disconnected', (select coalesce(jsonb_agg(user_id), '[]'::jsonb) from ranked where is_dc),
      'attacker_out', (select jsonb_object_agg(attacker::text, out_total) from attacker_totals)
    )
    into v_winner, v_forfeited, v_mismatch, v_meta;

  -- Disputed if no clean player can win (e.g. everyone flagged)…
  if v_winner is null then v_disputed := true; end if;

  -- …or if a LOSER's self-report contradicts the ledger damage against them:
  -- the winner's margin may rest on fabricated offense that stayed under the
  -- rate caps, so no automatic payout — hold for admin review. The winner is
  -- excluded: fabricated damage against them could only have hurt them.
  v_mismatch := array_remove(coalesce(v_mismatch, '{}'), v_winner);
  if coalesce(array_length(v_mismatch, 1), 0) > 0 then
    v_disputed := true;
    v_meta := v_meta || jsonb_build_object(
      'reason',   'ledger_mismatch',
      'mismatch', to_jsonb(v_mismatch),
      'hp_tolerance', c_hp_tolerance
    );
  end if;

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
