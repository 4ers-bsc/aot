-- ============================================================================
-- match_config — single source of truth for per-lobby match duration.
-- ----------------------------------------------------------------------------
-- One row per lobby size. The server (finalize_match deadline + the stale
-- backstop) and the client (visible countdown) both read duration from here,
-- so match length lives in ONE place and can be changed per lobby with a single
-- UPDATE — no more hardcoded literals scattered across JS and SQL.
--
-- Safe to run on an existing project (idempotent).
-- ============================================================================

create table if not exists public.match_config (
  max_players      smallint primary key check (max_players in (2, 5, 10)),
  duration_seconds int not null check (duration_seconds between 30 and 3600)
);

-- Defaults: larger lobbies get longer to resolve. Edit these rows to retune.
insert into public.match_config (max_players, duration_seconds) values
  (2,  300),   -- 5 min
  (5,  420),   -- 7 min
  (10, 600)    -- 10 min
on conflict (max_players) do nothing;

-- Readable by everyone (non-sensitive config the client needs to set its timer).
alter table public.match_config enable row level security;
drop policy if exists "match_config_select_all" on public.match_config;
create policy "match_config_select_all"
  on public.match_config for select to authenticated, anon using (true);
grant select on public.match_config to authenticated, anon;

-- Server-side lookup with a safe fallback if a row is somehow missing.
create or replace function public.match_duration_seconds(p_max_players smallint)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select duration_seconds from public.match_config where max_players = p_max_players),
    300
  );
$$;
grant execute on function public.match_duration_seconds(smallint) to authenticated, service_role, anon;

-- ---------------------------------------------------------------------------
-- finalize_match — deadline now comes from match_config (per lobby size).
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
  v_disputed   boolean := false;
  v_meta       jsonb;
  c_max_dps      constant numeric := 50;
  c_max_firerate constant numeric := 4;
begin
  select status, started_at, max_players into v_status, v_started, v_maxp
  from matches where id = p_match_id for update;
  if v_status is null                     then raise exception 'match_not_found'; end if;
  if v_status in ('finished', 'disputed') then return; end if;

  -- Hard cap from config (per lobby size). Before it, hold open until everyone
  -- reports; after it (or on force), settle now from whatever the ledger holds.
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
    select user_id, hp, seat,
           row_number() over (order by hp desc, seat asc) as rn
    from hp
  )
  select
    (select user_id from ranked where rn = 1),
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
-- close_stale_matches — backstop now uses the per-lobby duration from config.
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
    perform public.finalize_match(r.id, true);
    v_closed := v_closed + 1;
  end loop;

  return v_closed;
end;
$$;
