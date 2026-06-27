-- ============================================================================
-- Option A — cross-validated combat ledger (Phase 0: SHADOW MODE)
-- ----------------------------------------------------------------------------
-- Players record the damage THEY dealt (RLS forces attacker = auth.uid(), so a
-- player can never write their own incoming HP or edit anyone else's row). At
-- settlement, finalize_match derives each player's HP from the damage *others*
-- reported and stores the resulting winner in matches.shadow_winner.
--
-- SHADOW MODE: the derived winner is recorded for comparison ONLY. The live
-- winner (winner_user_id) and the payout are still decided by the existing
-- self-reported-HP logic. Compare the two columns over real matches, tune the
-- caps below, then cut over in a later phase.
--
-- Safe to run on an existing project (idempotent).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Offense ledger tables
-- ---------------------------------------------------------------------------

-- One row per (attacker, victim) pair: the total damage that attacker dealt
-- that victim over the match. Written at match end.
create table if not exists public.match_damage (
  match_id     uuid   not null references public.matches(id) on delete cascade,
  attacker     uuid   not null references auth.users(id) on delete cascade,
  victim       uuid   not null references auth.users(id) on delete cascade,
  total_damage int    not null check (total_damage between 0 and 100000),
  hit_count    int    not null check (hit_count >= 0),
  first_t_ms   bigint not null default 0,
  last_t_ms    bigint not null default 0,
  created_at   timestamptz not null default now(),
  primary key (match_id, attacker, victim),
  check (attacker <> victim)            -- no self-damage rows, ever
);

-- Discrete kill events: who landed the killing blow on whom. A player can die
-- at most once, so the primary key dedupes competing kill claims (first wins).
create table if not exists public.match_kills (
  match_id   uuid   not null references public.matches(id) on delete cascade,
  attacker   uuid   not null references auth.users(id) on delete cascade,
  victim     uuid   not null references auth.users(id) on delete cascade,
  t_ms       bigint not null default 0,
  created_at timestamptz not null default now(),
  primary key (match_id, victim),
  check (attacker <> victim)
);

create index if not exists idx_match_damage_match on public.match_damage(match_id);
create index if not exists idx_match_kills_match  on public.match_kills(match_id);

-- ---------------------------------------------------------------------------
-- 2. Shadow-result columns on matches
-- ---------------------------------------------------------------------------
alter table public.matches add column if not exists shadow_winner uuid
  references auth.users(id) on delete set null;
alter table public.matches add column if not exists shadow_meta jsonb;

-- ---------------------------------------------------------------------------
-- 3. Row-level security — you may only report YOUR OWN offense
-- ---------------------------------------------------------------------------
alter table public.match_damage enable row level security;
alter table public.match_kills  enable row level security;

drop policy if exists "match_damage_insert_own" on public.match_damage;
create policy "match_damage_insert_own"
on public.match_damage for insert to authenticated
with check (attacker = auth.uid() and public.is_match_member(match_id));

-- Members may read the ledger of matches they were in (for debugging / future UI).
drop policy if exists "match_damage_select_member" on public.match_damage;
create policy "match_damage_select_member"
on public.match_damage for select to authenticated
using (public.is_match_member(match_id));

drop policy if exists "match_kills_insert_own" on public.match_kills;
create policy "match_kills_insert_own"
on public.match_kills for insert to authenticated
with check (attacker = auth.uid() and public.is_match_member(match_id));

drop policy if exists "match_kills_select_member" on public.match_kills;
create policy "match_kills_select_member"
on public.match_kills for select to authenticated
using (public.is_match_member(match_id));

grant select, insert on public.match_damage to authenticated;
grant select, insert on public.match_kills  to authenticated;

-- ---------------------------------------------------------------------------
-- 4. compute_shadow_winner — derive HP from the ledger and record the result
-- ---------------------------------------------------------------------------
-- Internal helper, called from finalize_match. Plausibility caps reject the
-- "I deleted everyone instantly" and fire-rate cheats; tune them from real data
-- during shadow mode before relying on the output.
create or replace function public.compute_shadow_winner(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_started timestamptz;
  v_ended   timestamptz;
  v_secs    numeric;
  v_winner  uuid;
  v_meta    jsonb;
  -- Generous caps (raw weapon ceilings); tighten once shadow data is in.
  c_max_dps      constant numeric := 60;   -- max damage one attacker can deal per second
  c_max_firerate constant numeric := 12;   -- max hits per second
begin
  select started_at, coalesce(ended_at, now())
    into v_started, v_ended
  from public.matches where id = p_match_id;

  v_secs := greatest(5, extract(epoch from (v_ended - coalesce(v_started, v_ended))));

  with valid as (
    -- Cap each reported damage total at the physical maximum for the match length,
    -- and drop rows whose hit count is impossible for the weapon fire rate.
    select victim, least(total_damage, (c_max_dps * v_secs)::int) as dmg
    from public.match_damage
    where match_id = p_match_id
      and hit_count <= c_max_firerate * v_secs
  ),
  hp as (
    -- HP = 100 - (validated incoming damage reported by OTHERS).
    select mp.user_id, mp.seat,
           greatest(0, 100 - coalesce(sum(v.dmg), 0))::int as hp
    from public.match_players mp
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
    jsonb_build_object(
      'secs',  v_secs,
      'alive', (select count(*) from ranked where hp > 0),
      'hp',    (select jsonb_agg(jsonb_build_object('user_id', user_id, 'hp', hp, 'seat', seat)
                                 order by hp desc, seat asc) from ranked),
      'kills', (select jsonb_agg(jsonb_build_object('attacker', attacker, 'victim', victim, 't_ms', t_ms))
                from public.match_kills where match_id = p_match_id)
    )
    into v_winner, v_meta;

  update public.matches
  set shadow_winner = v_winner, shadow_meta = v_meta
  where id = p_match_id;
end;
$$;

grant execute on function public.compute_shadow_winner(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. finalize_match — unchanged winner logic, plus a shadow comparison call
-- ---------------------------------------------------------------------------
-- Identical to the existing definition except for the compute_shadow_winner()
-- call at the end. The live winner is still chosen exactly as before.
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
    select user_id into v_winner
    from match_players
    where match_id = p_match_id and final_hp > 0
    limit 1;
  elsif v_unreported = 0 then
    select user_id into v_winner
    from match_players
    where match_id = p_match_id
    order by final_hp desc, seat asc
    limit 1;
  else
    return;
  end if;

  update matches
  set winner_user_id = v_winner, status = 'finished', ended_at = now()
  where id = p_match_id and status != 'finished';

  perform public.apply_match_result(p_match_id, v_winner);

  -- Phase 0 shadow: record the ledger-derived winner alongside the live one.
  -- Comparison only — does NOT change winner_user_id or the payout.
  perform public.compute_shadow_winner(p_match_id);
end;
$$;
