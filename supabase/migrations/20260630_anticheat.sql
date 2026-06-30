-- ============================================================================
-- Anti-manipulation hardening.
--
-- The only durable defence for a real-money game is the server refusing illegal
-- input — the client and its console are untrusted. This migration adds:
--
--  1. Write-time validation triggers on the combat ledger (match_damage,
--     match_kills): impossible or out-of-context rows are REJECTED at insert,
--     so a tampered request fails immediately instead of being settled later.
--  2. Per-user rate limiting (rate_limits + enforce_rate_limit) to throttle
--     anyone hammering the authoritative RPCs / edge functions.
--  3. finalize_match now FORFEITS the cheater instead of voiding the match:
--     flagged attackers are excluded from winner selection and the best clean
--     player wins, so an honest opponent is no longer punished for someone
--     else's cheating (and the cheater loses their deposit to the winner).
--  4. integrity_signals + report_integrity_signal: soft telemetry the client
--     can post (e.g. devtools opened) for review. Telemetry only — it never
--     auto-forfeits, to avoid robbing honest players on a false positive.
--
-- Safe to run on an existing project (idempotent).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Track forfeited (flagged) players on the match
-- ---------------------------------------------------------------------------
alter table public.matches
  add column if not exists forfeited_user_ids uuid[] not null default '{}';

-- ---------------------------------------------------------------------------
-- 2. Per-user rate limiting
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limits (
  user_id      uuid        not null references auth.users(id) on delete cascade,
  action       text        not null,
  window_start timestamptz not null default now(),
  count        int         not null default 0,
  primary key (user_id, action)
);
alter table public.rate_limits enable row level security;
-- No policies on purpose: only the SECURITY DEFINER function below touches it.

create or replace function public.enforce_rate_limit(
  p_action text,
  p_max    int,
  p_window interval
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_count int;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  insert into public.rate_limits as rl (user_id, action, window_start, count)
  values (v_uid, p_action, now(), 1)
  on conflict (user_id, action) do update
    set count = case when rl.window_start < now() - p_window then 1
                     else rl.count + 1 end,
        window_start = case when rl.window_start < now() - p_window then now()
                            else rl.window_start end
  returning count into v_count;

  if v_count > p_max then
    raise exception 'rate_limited: too many % requests', p_action;
  end if;
end;
$$;

grant execute on function public.enforce_rate_limit(text, int, interval)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Combat-ledger write validation (BEFORE INSERT triggers)
--    Rejects impossible / out-of-context rows. Errors prefixed 'cheat_detected:'
--    signal tampering (client should kick); 'stale:' signals a benign late write
--    (match already settled) the client can ignore.
-- ---------------------------------------------------------------------------
create or replace function public.validate_match_damage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_dur_ms bigint;
  -- Generous single-hit ceiling. The fine-grained DPS/fire-rate caps live in
  -- finalize_match; this only rejects blatantly impossible rows at write time.
  c_hard_per_hit constant int := 250;
begin
  select m.status, public.match_duration_seconds(m.max_players) * 1000
    into v_status, v_dur_ms
  from public.matches m
  where m.id = new.match_id;

  if v_status is null then
    raise exception 'stale: match_not_found';
  end if;
  -- Damage can only be recorded while the match is live.
  if v_status <> 'active' then
    raise exception 'stale: match_not_active';
  end if;
  -- Both parties must actually be in this match.
  if not exists (select 1 from public.match_players
                 where match_id = new.match_id and user_id = new.attacker) then
    raise exception 'cheat_detected: attacker_not_in_match';
  end if;
  if not exists (select 1 from public.match_players
                 where match_id = new.match_id and user_id = new.victim) then
    raise exception 'cheat_detected: victim_not_in_match';
  end if;
  -- Timestamp sanity (allow 30s grace past the hard deadline for clock skew).
  if new.first_t_ms < 0
     or new.last_t_ms < new.first_t_ms
     or new.last_t_ms > v_dur_ms + 30000 then
    raise exception 'cheat_detected: bad_timestamps';
  end if;
  -- Damage requires hits, and cannot exceed hits × the single-hit ceiling.
  if new.total_damage > 0 and new.hit_count < 1 then
    raise exception 'cheat_detected: damage_without_hits';
  end if;
  if new.total_damage > new.hit_count * c_hard_per_hit then
    raise exception 'cheat_detected: damage_exceeds_hit_ceiling';
  end if;

  return new;
end;
$$;

create or replace function public.validate_match_kills()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_dur_ms bigint;
begin
  select m.status, public.match_duration_seconds(m.max_players) * 1000
    into v_status, v_dur_ms
  from public.matches m
  where m.id = new.match_id;

  if v_status is null then
    raise exception 'stale: match_not_found';
  end if;
  if v_status <> 'active' then
    raise exception 'stale: match_not_active';
  end if;
  if not exists (select 1 from public.match_players
                 where match_id = new.match_id and user_id = new.attacker) then
    raise exception 'cheat_detected: attacker_not_in_match';
  end if;
  if not exists (select 1 from public.match_players
                 where match_id = new.match_id and user_id = new.victim) then
    raise exception 'cheat_detected: victim_not_in_match';
  end if;
  if new.t_ms < 0 or new.t_ms > v_dur_ms + 30000 then
    raise exception 'cheat_detected: bad_timestamp';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_match_damage on public.match_damage;
create trigger trg_validate_match_damage
  before insert on public.match_damage
  for each row execute function public.validate_match_damage();

drop trigger if exists trg_validate_match_kills on public.match_kills;
create trigger trg_validate_match_kills
  before insert on public.match_kills
  for each row execute function public.validate_match_kills();

-- ---------------------------------------------------------------------------
-- 4. finish_match — rate-limit the authoritative report (1/match normally;
--    30/min is a generous abuse ceiling).
-- ---------------------------------------------------------------------------
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

  perform public.enforce_rate_limit('finish_match', 30, interval '1 minute');

  if not exists (
    select 1 from match_players
    where match_id = p_match_id and user_id = v_caller
  ) then
    raise exception 'not_a_participant';
  end if;

  update match_players
  set final_hp = greatest(0, least(100, p_final_hp))
  where match_id = p_match_id and user_id = v_caller;

  perform public.finalize_match(p_match_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. finalize_match — forfeit the cheater, award the best CLEAN player.
--    Flagged attackers (impossible total output) are removed from winner
--    eligibility instead of voiding the whole match. Only disputes if no clean
--    winner remains (everyone flagged) or no combat happened.
-- ---------------------------------------------------------------------------
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
  v_disputed   boolean := false;
  v_meta       jsonb;
  c_max_dps      constant numeric := 50;   -- per attacker, total across all victims
  c_max_firerate constant numeric := 4;    -- hits per second, per attacker→victim pair
begin
  select status, started_at, max_players into v_status, v_started, v_maxp
  from matches where id = p_match_id for update;
  if v_status is null                     then raise exception 'match_not_found'; end if;
  if v_status in ('finished', 'disputed') then return; end if;

  v_deadline := coalesce(v_started, now()) + make_interval(secs => public.match_duration_seconds(v_maxp));

  select count(*) filter (where final_hp is null) into v_unreported
  from match_players where match_id = p_match_id;

  if not p_force and v_unreported > 0 and now() < v_deadline then
    return;
  end if;

  v_ended := now();
  v_secs  := greatest(5, extract(epoch from (v_ended - coalesce(v_started, v_ended))));

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
    -- A player whose TOTAL output exceeds the physical ceiling is cheating.
    select attacker from attacker_totals
    where out_total > (c_max_dps * out_secs)
  ),
  valid as (
    select victim, least(total_damage, (c_max_dps * win_secs)::int) as dmg
    from raw
    where hit_count <= c_max_firerate * win_secs
  ),
  hp as (
    select mp.user_id, mp.seat,
           greatest(0, 100 - coalesce(sum(v.dmg), 0))::int as hp
    from match_players mp
    left join valid v on v.victim = mp.user_id
    group by mp.user_id, mp.seat
  ),
  ranked as (
    select h.user_id, h.hp, h.seat,
           (f.attacker is not null) as is_flagged,
           row_number() over (
             -- Clean players rank first; among them, highest HP then lowest seat.
             order by (f.attacker is not null) asc, h.hp desc, h.seat asc
           ) as rn
    from hp h
    left join flagged f on f.attacker = h.user_id
  )
  select
    (select user_id from ranked where rn = 1 and not is_flagged),
    (select coalesce(array_agg(user_id), '{}') from ranked where is_flagged),
    jsonb_build_object(
      'secs',  v_secs,
      'caps',  jsonb_build_object('dps', c_max_dps, 'firerate', c_max_firerate),
      'hp',    (select jsonb_agg(jsonb_build_object('user_id', user_id, 'hp', hp, 'seat', seat, 'flagged', is_flagged)
                                 order by hp desc, seat asc) from ranked),
      'flagged',      (select coalesce(jsonb_agg(attacker), '[]'::jsonb) from flagged),
      'attacker_out', (select jsonb_object_agg(attacker::text, out_total) from attacker_totals)
    )
    into v_winner, v_forfeited, v_meta;

  -- Disputed only if no clean player can win (e.g. everyone flagged).
  if v_winner is null then v_disputed := true; end if;

  if v_disputed then
    update matches
      set status = 'disputed', winner_user_id = NULL, ended_at = v_ended,
          shadow_winner = NULL,
          shadow_meta = v_meta, forfeited_user_ids = v_forfeited
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

-- ---------------------------------------------------------------------------
-- 6. integrity_signals — soft client telemetry (e.g. devtools opened). Recorded
--    for review only; never auto-forfeits to avoid false-positive bans.
-- ---------------------------------------------------------------------------
create table if not exists public.integrity_signals (
  id         bigint generated always as identity primary key,
  user_id    uuid references auth.users(id) on delete set null,
  match_id   uuid references public.matches(id) on delete set null,
  kind       text not null,
  detail     jsonb,
  created_at timestamptz not null default now()
);
alter table public.integrity_signals enable row level security;
-- No policies: writes go through the SECURITY DEFINER function below; reads are
-- for admins via the service role only.

create or replace function public.report_integrity_signal(
  p_match_id uuid,
  p_kind     text,
  p_detail   jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return; end if;
  perform public.enforce_rate_limit('integrity_signal', 20, interval '1 minute');
  insert into public.integrity_signals (user_id, match_id, kind, detail)
  values (v_uid, p_match_id, left(coalesce(p_kind, 'unknown'), 40), p_detail);
end;
$$;

grant execute on function public.report_integrity_signal(uuid, text, jsonb) to authenticated;
