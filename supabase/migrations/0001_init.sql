-- Age of Trenches — minimal schema
-- Flow: sign in with a Solana wallet (Supabase Web3 auth) -> a profile is
-- created. Demo matches run vs the computer (client only). PvP pairs you with
-- another player via join_pvp_match(); finish_match() records the winner and
-- updates win/loss tallies when someone reaches 0 HP.

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Trench Rookie'
    check (char_length(display_name) between 3 and 24),
  wallet_address text,
  wins integer not null default 0,
  losses integer not null default 0,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'waiting'
    check (status in ('waiting', 'active', 'finished')),
  max_players smallint not null default 2
    check (max_players between 2 and 10),
  created_by uuid references auth.users(id) on delete set null,
  winner_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  ended_at timestamptz
);

create table if not exists public.match_players (
  match_id uuid not null references public.matches(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  seat smallint not null check (seat between 1 and 10),
  display_name text not null,
  joined_at timestamptz not null default timezone('utc', now()),
  primary key (match_id, user_id),
  unique (match_id, seat)
);

create index if not exists idx_matches_waiting on public.matches(status, created_at);
create index if not exists idx_match_players_user on public.match_players(user_id, joined_at desc);

-- ----------------------------------------------------------------------------
-- Auto-create a profile for every new auth user
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', 'Trench Rookie'))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- Helpers
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER so it bypasses RLS and avoids recursive policy evaluation.
create or replace function public.is_match_member(p_match_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.match_players
    where match_id = p_match_id and user_id = auth.uid()
  );
$$;

-- Upsert the caller's profile from their wallet identity. Self-heals if the
-- on_auth_user_created trigger never ran for this user.
create or replace function public.sync_my_profile(p_display_name text default null)
returns public.profiles
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_wallet text;
  v_profile public.profiles%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select provider_id
  into v_wallet
  from auth.identities
  where user_id = v_uid
  order by coalesce(last_sign_in_at, created_at) desc
  limit 1;

  insert into public.profiles as p (user_id, display_name, wallet_address)
  values (v_uid, coalesce(nullif(trim(p_display_name), ''), 'Trench Rookie'), v_wallet)
  on conflict (user_id) do update
  set display_name = coalesce(nullif(trim(p_display_name), ''), p.display_name),
      wallet_address = coalesce(excluded.wallet_address, p.wallet_address)
  where p.user_id = v_uid
  returning * into v_profile;

  return v_profile;
end;
$$;

-- Join an open PvP match of the requested size, or open a new one. A wallet
-- can only ever be in one unfinished match at a time. A match flips to
-- 'active' the moment its seats are all filled.
create or replace function public.join_pvp_match(p_max_players smallint default 2, p_display_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_size smallint := least(greatest(coalesce(p_max_players, 2), 2), 10);
  v_match_id uuid;
  v_seat smallint;
  v_count smallint;
  v_status text;
  v_existing record;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  -- Make sure the profile exists / is up to date, and grab the display name.
  select display_name into v_name
  from public.sync_my_profile(p_display_name);

  -- One wallet, one match: if already in an unfinished match, return it.
  select mp.match_id, mp.seat, m.status, m.max_players into v_existing
  from public.match_players mp
  join public.matches m on m.id = mp.match_id
  where mp.user_id = v_uid and m.status in ('waiting', 'active')
  limit 1;

  if found then
    return jsonb_build_object(
      'match_id', v_existing.match_id, 'seat', v_existing.seat,
      'status', 'existing', 'max_players', v_existing.max_players
    );
  end if;

  -- Find a waiting match of the same size with a free seat, lock it.
  select m.id into v_match_id
  from public.matches m
  where m.status = 'waiting'
    and m.max_players = v_size
    and (select count(*) from public.match_players mp where mp.match_id = m.id) < m.max_players
  order by m.created_at
  for update of m skip locked
  limit 1;

  if found then
    select count(*) into v_count from public.match_players where match_id = v_match_id;
    v_seat := v_count + 1;
    insert into public.match_players (match_id, user_id, seat, display_name)
    values (v_match_id, v_uid, v_seat, v_name);

    -- Full now? Kick it off.
    if v_seat >= v_size then
      update public.matches
      set status = 'active', started_at = timezone('utc', now())
      where id = v_match_id;
      v_status := 'active';
    else
      v_status := 'waiting';
    end if;

    return jsonb_build_object('match_id', v_match_id, 'seat', v_seat, 'status', v_status, 'max_players', v_size);
  end if;

  -- Otherwise open a new waiting match of the requested size.
  insert into public.matches (status, max_players, created_by)
  values ('waiting', v_size, v_uid)
  returning id into v_match_id;

  v_seat := 1;
  insert into public.match_players (match_id, user_id, seat, display_name)
  values (v_match_id, v_uid, v_seat, v_name);

  -- A size-1 match would be degenerate; minimum is 2 so this always waits.
  return jsonb_build_object('match_id', v_match_id, 'seat', v_seat, 'status', 'waiting', 'max_players', v_size);
end;
$$;

-- Leave the caller's unfinished matches. Waiting matches: drop the seat and
-- finish the match only if it empties. Active matches are left for finish_match
-- (the surviving players settle the result).
create or replace function public.leave_my_matches()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  r record;
  v_remaining integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  for r in
    select m.id, m.status
    from public.matches m
    join public.match_players mp on mp.match_id = m.id
    where mp.user_id = v_uid and m.status in ('waiting', 'active')
  loop
    if r.status = 'waiting' then
      delete from public.match_players where match_id = r.id and user_id = v_uid;
      select count(*) into v_remaining from public.match_players where match_id = r.id;
      if v_remaining = 0 then
        update public.matches set status = 'finished', ended_at = timezone('utc', now()) where id = r.id;
      end if;
    end if;
  end loop;
end;
$$;

-- Finish an active PvP match (free-for-all, last one standing): record the
-- winner, +1 win for them, +1 loss for every other player in the match.
-- Idempotent — only the first call (while the match is still active) settles it.
create or replace function public.finish_match(p_match_id uuid, p_winner_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if not exists (select 1 from public.match_players where match_id = p_match_id and user_id = v_uid) then
    raise exception 'not_in_match';
  end if;

  select status into v_status from public.matches where id = p_match_id for update;
  if v_status is null then
    raise exception 'match_not_found';
  end if;
  if v_status <> 'active' then
    return; -- already settled
  end if;

  if not exists (select 1 from public.match_players where match_id = p_match_id and user_id = p_winner_user_id) then
    raise exception 'winner_not_in_match';
  end if;

  update public.matches
  set status = 'finished', winner_user_id = p_winner_user_id, ended_at = timezone('utc', now())
  where id = p_match_id;

  update public.profiles set wins = wins + 1 where user_id = p_winner_user_id;
  update public.profiles set losses = losses + 1
  where user_id in (
    select user_id from public.match_players
    where match_id = p_match_id and user_id <> p_winner_user_id
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- Row level security
-- ----------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.matches enable row level security;
alter table public.match_players enable row level security;

grant select, update(display_name) on public.profiles to authenticated;
grant select on public.matches to authenticated;
grant select on public.match_players to authenticated;
grant execute on function public.sync_my_profile(text) to authenticated;
grant execute on function public.join_pvp_match(smallint, text) to authenticated;
grant execute on function public.leave_my_matches() to authenticated;
grant execute on function public.finish_match(uuid, uuid) to authenticated;

create policy "profiles_select_own"
on public.profiles for select to authenticated
using (auth.uid() = user_id);

create policy "profiles_update_own_name"
on public.profiles for update to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "matches_select_member_or_active"
on public.matches for select to authenticated
using (status = 'active' or public.is_match_member(id));

create policy "match_players_select_member_or_active"
on public.match_players for select to authenticated
using (
  public.is_match_member(match_id)
  or exists (select 1 from public.matches m where m.id = match_id and m.status = 'active')
);
