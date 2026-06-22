create extension if not exists pgcrypto;

create type public.match_status as enum ('waiting', 'active', 'finished', 'cancelled');
create type public.player_result as enum ('alive', 'won', 'lost', 'forfeited');
create type public.ledger_kind as enum ('seed', 'entry_lock', 'refund', 'payout');

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Trench Rookie'
    check (char_length(display_name) between 3 and 24),
  gold_balance integer not null default 10 check (gold_balance >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  room_topic text not null unique,
  status public.match_status not null default 'waiting',
  entry_fee integer not null default 10 check (entry_fee = 10),
  pot integer not null default 0 check (pot >= 0),
  winner_user_id uuid references auth.users(id),
  created_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  ended_at timestamptz,
  settled_at timestamptz
);

create table if not exists public.match_players (
  match_id uuid not null references public.matches(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  seat smallint not null check (seat between 1 and 2),
  display_name text not null,
  result public.player_result not null default 'alive',
  joined_at timestamptz not null default timezone('utc', now()),
  primary key (match_id, user_id),
  unique (match_id, seat)
);

create table if not exists public.wallet_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  match_id uuid references public.matches(id) on delete set null,
  delta integer not null,
  kind public.ledger_kind not null,
  note text,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.match_result_claims (
  match_id uuid not null references public.matches(id) on delete cascade,
  claimant_user_id uuid not null references auth.users(id) on delete cascade,
  winner_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (match_id, claimant_user_id)
);

create index if not exists idx_matches_waiting on public.matches(status, created_at);
create index if not exists idx_match_players_user on public.match_players(user_id, joined_at desc);
create index if not exists idx_wallet_ledger_user on public.wallet_ledger(user_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, display_name, gold_balance)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', 'Trench Rookie'),
    10
  )
  on conflict (user_id) do nothing;

  insert into public.wallet_ledger (user_id, delta, kind, note)
  values (new.id, 10, 'seed', 'Initial duel bankroll')
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_match_member(p_match_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.match_players mp
    where mp.match_id = p_match_id
      and mp.user_id = auth.uid()
  );
$$;

create or replace function public.is_topic_member(p_topic text)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.matches m
    join public.match_players mp on mp.match_id = m.id
    where m.room_topic = p_topic
      and mp.user_id = auth.uid()
  );
$$;

create or replace function public.protect_profile_balance()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() = old.user_id and new.gold_balance <> old.gold_balance then
    raise exception 'gold_balance is server managed';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_protect_balance on public.profiles;
create trigger profiles_protect_balance
before update on public.profiles
for each row execute function public.protect_profile_balance();

create or replace function public.finalize_match_internal(
  p_match_id uuid,
  p_winner_user_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match public.matches%rowtype;
  v_loser_user_id uuid;
begin
  select *
  into v_match
  from public.matches
  where id = p_match_id
  for update;

  if not found then
    raise exception 'match_not_found';
  end if;

  if v_match.status <> 'active' then
    return jsonb_build_object('match_id', v_match.id, 'status', v_match.status);
  end if;

  if not exists (
    select 1 from public.match_players
    where match_id = p_match_id and user_id = p_winner_user_id
  ) then
    raise exception 'winner_not_in_match';
  end if;

  select mp.user_id into v_loser_user_id
  from public.match_players mp
  where mp.match_id = p_match_id
    and mp.user_id <> p_winner_user_id
  limit 1;

  update public.profiles
  set gold_balance = gold_balance + v_match.pot
  where user_id = p_winner_user_id;

  insert into public.wallet_ledger (user_id, match_id, delta, kind, note)
  values (p_winner_user_id, p_match_id, v_match.pot, 'payout', p_reason);

  update public.matches
  set status = 'finished',
      winner_user_id = p_winner_user_id,
      ended_at = timezone('utc', now()),
      settled_at = timezone('utc', now())
  where id = p_match_id;

  update public.match_players
  set result = case
    when user_id = p_winner_user_id then 'won'
    when user_id = v_loser_user_id then 'lost'
    else result
  end
  where match_id = p_match_id;

  return jsonb_build_object(
    'match_id', p_match_id,
    'winner_user_id', p_winner_user_id,
    'pot', v_match.pot
  );
end;
$$;

create or replace function public.admin_queue_match(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_match_id uuid;
  v_waiting_match public.matches%rowtype;
  v_profile public.profiles%rowtype;
  v_match_id uuid;
  v_display_name text;
begin
  select *
  into v_profile
  from public.profiles
  where user_id = p_user_id
  for update;

  if not found then
    raise exception 'profile_not_found';
  end if;

  select mp.match_id
  into v_existing_match_id
  from public.match_players mp
  join public.matches m on m.id = mp.match_id
  where mp.user_id = p_user_id
    and m.status in ('waiting', 'active')
  limit 1;

  if v_existing_match_id is not null then
    return jsonb_build_object('match_id', v_existing_match_id, 'status', 'existing');
  end if;

  if v_profile.gold_balance < 10 then
    raise exception 'insufficient_gold';
  end if;

  update public.profiles
  set gold_balance = gold_balance - 10
  where user_id = p_user_id;

  insert into public.wallet_ledger (user_id, delta, kind, note)
  values (p_user_id, -10, 'entry_lock', 'Escrow locked for duel');

  v_display_name := v_profile.display_name;

  select *
  into v_waiting_match
  from public.matches
  where status = 'waiting'
    and created_by <> p_user_id
  order by created_at
  for update skip locked
  limit 1;

  if found then
    v_match_id := v_waiting_match.id;
    insert into public.match_players (match_id, user_id, seat, display_name)
    values (v_match_id, p_user_id, 2, v_display_name);

    update public.matches
    set status = 'active',
        pot = pot + 10,
        started_at = timezone('utc', now())
    where id = v_match_id;
  else
    insert into public.matches (created_by, room_topic, status, pot)
    values (
      p_user_id,
      'match:' || encode(gen_random_bytes(8), 'hex'),
      'waiting',
      10
    )
    returning id into v_match_id;

    insert into public.match_players (match_id, user_id, seat, display_name)
    values (v_match_id, p_user_id, 1, v_display_name);
  end if;

  return jsonb_build_object('match_id', v_match_id, 'status', 'queued');
end;
$$;

create or replace function public.admin_cancel_waiting_match(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match public.matches%rowtype;
begin
  select m.*
  into v_match
  from public.matches m
  join public.match_players mp on mp.match_id = m.id
  where mp.user_id = p_user_id
    and m.status = 'waiting'
  for update;

  if not found then
    raise exception 'waiting_match_not_found';
  end if;

  if (select count(*) from public.match_players where match_id = v_match.id) <> 1 then
    raise exception 'cannot_cancel_joined_match';
  end if;

  update public.profiles
  set gold_balance = gold_balance + 10
  where user_id = p_user_id;

  insert into public.wallet_ledger (user_id, match_id, delta, kind, note)
  values (p_user_id, v_match.id, 10, 'refund', 'Queue cancelled before opponent joined');

  update public.matches
  set status = 'cancelled',
      ended_at = timezone('utc', now()),
      settled_at = timezone('utc', now())
  where id = v_match.id;

  update public.match_players
  set result = 'forfeited'
  where match_id = v_match.id;

  return jsonb_build_object('match_id', v_match.id, 'status', 'cancelled');
end;
$$;

create or replace function public.admin_claim_match_result(
  p_user_id uuid,
  p_match_id uuid,
  p_winner_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim_count integer;
begin
  if not exists (
    select 1 from public.match_players where match_id = p_match_id and user_id = p_user_id
  ) then
    raise exception 'not_in_match';
  end if;

  insert into public.match_result_claims (match_id, claimant_user_id, winner_user_id)
  values (p_match_id, p_user_id, p_winner_user_id)
  on conflict (match_id, claimant_user_id)
  do update set winner_user_id = excluded.winner_user_id, created_at = timezone('utc', now());

  select count(*)
  into v_claim_count
  from public.match_result_claims
  where match_id = p_match_id
    and winner_user_id = p_winner_user_id;

  if v_claim_count >= 2 then
    return public.finalize_match_internal(p_match_id, p_winner_user_id, 'Both players confirmed the same winner');
  end if;

  return jsonb_build_object('match_id', p_match_id, 'status', 'pending_confirmation');
end;
$$;

create or replace function public.admin_forfeit_match(
  p_user_id uuid,
  p_match_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_winner_user_id uuid;
begin
  select user_id into v_winner_user_id
  from public.match_players
  where match_id = p_match_id
    and user_id <> p_user_id
  limit 1;

  if v_winner_user_id is null then
    raise exception 'opponent_not_found';
  end if;

  update public.match_players
  set result = 'forfeited'
  where match_id = p_match_id
    and user_id = p_user_id;

  return public.finalize_match_internal(p_match_id, v_winner_user_id, 'Opponent forfeited');
end;
$$;

alter table public.profiles enable row level security;
alter table public.matches enable row level security;
alter table public.match_players enable row level security;
alter table public.wallet_ledger enable row level security;
alter table public.match_result_claims enable row level security;

grant select, update(display_name) on public.profiles to authenticated;
grant select on public.matches to authenticated;
grant select on public.match_players to authenticated;
grant select on public.wallet_ledger to authenticated;
grant select on public.match_result_claims to authenticated;

create policy "profiles_select_own"
on public.profiles
for select
to authenticated
using (auth.uid() = user_id);

create policy "profiles_update_own_name"
on public.profiles
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "matches_select_members"
on public.matches
for select
to authenticated
using (public.is_match_member(id));

create policy "match_players_select_members"
on public.match_players
for select
to authenticated
using (public.is_match_member(match_id));

create policy "wallet_ledger_select_own"
on public.wallet_ledger
for select
to authenticated
using (auth.uid() = user_id);

create policy "claims_select_members"
on public.match_result_claims
for select
to authenticated
using (public.is_match_member(match_id));

revoke all on function public.finalize_match_internal(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_queue_match(uuid) from public, anon, authenticated;
revoke all on function public.admin_cancel_waiting_match(uuid) from public, anon, authenticated;
revoke all on function public.admin_claim_match_result(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_forfeit_match(uuid, uuid) from public, anon, authenticated;

create policy "realtime_match_read"
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension in ('broadcast', 'presence')
  and public.is_topic_member(realtime.topic())
);

create policy "realtime_match_write"
on realtime.messages
for insert
to authenticated
with check (
  realtime.messages.extension in ('broadcast', 'presence')
  and public.is_topic_member(realtime.topic())
);
