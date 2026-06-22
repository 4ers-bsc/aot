do $$
begin
  create type public.item_kind as enum ('weapon', 'consumable', 'cosmetic');
exception
  when duplicate_object then null;
end $$;

alter table public.profiles
  add column if not exists wallet_public_key text unique,
  add column if not exists wallet_chain text,
  add column if not exists auth_provider text,
  add column if not exists can_compete boolean not null default false,
  add column if not exists mmr integer not null default 1000,
  add column if not exists xp integer not null default 0,
  add column if not exists level integer not null default 1,
  add column if not exists total_matches integer not null default 0,
  add column if not exists total_wins integer not null default 0,
  add column if not exists total_losses integer not null default 0,
  add column if not exists last_login_at timestamptz;

create table if not exists public.item_catalog (
  item_id text primary key,
  name text not null,
  item_kind public.item_kind not null,
  slot_key text,
  emoji text not null default '🎒',
  description text not null default '',
  weapon_stats jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.player_inventory (
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id text not null references public.item_catalog(item_id) on delete cascade,
  quantity integer not null default 1 check (quantity >= 0),
  acquired_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, item_id)
);

create table if not exists public.player_loadouts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  primary_item_id text references public.item_catalog(item_id),
  secondary_item_id text references public.item_catalog(item_id),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.pvp_match_events (
  id bigint generated always as identity primary key,
  match_id uuid not null references public.matches(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_pvp_match_events_match on public.pvp_match_events(match_id, created_at desc);

insert into public.item_catalog (item_id, name, item_kind, slot_key, emoji, description, weapon_stats)
values
  ('sword', 'Trench Sword', 'weapon', 'primary', '⚔', 'Reliable melee weapon for close engagements.', '{"range":9,"damage":22,"cooldown":650}'::jsonb),
  ('pistol', 'Officer Pistol', 'weapon', 'secondary', '🔫', 'Short sidearm with decent reach.', '{"range":25,"damage":12,"cooldown":460}'::jsonb)
on conflict (item_id) do update
set name = excluded.name,
    item_kind = excluded.item_kind,
    slot_key = excluded.slot_key,
    emoji = excluded.emoji,
    description = excluded.description,
    weapon_stats = excluded.weapon_stats;

update public.profiles
set gold_balance = 0
where can_compete = false
  and wallet_public_key is null;

create or replace function public.protect_profile_server_fields()
returns trigger
language plpgsql
as $$
begin
  -- Only block direct client tampering. SECURITY DEFINER RPCs run as the table
  -- owner (e.g. postgres) and must be allowed to update server-managed fields,
  -- so gate on the effective role rather than auth.uid() (which is still the
  -- user's id even inside a definer function).
  if current_user in ('authenticated', 'anon') and (
    new.gold_balance <> old.gold_balance or
    coalesce(new.wallet_public_key, '') <> coalesce(old.wallet_public_key, '') or
    coalesce(new.wallet_chain, '') <> coalesce(old.wallet_chain, '') or
    coalesce(new.auth_provider, '') <> coalesce(old.auth_provider, '') or
    new.can_compete <> old.can_compete or
    new.mmr <> old.mmr or
    new.xp <> old.xp or
    new.level <> old.level or
    new.total_matches <> old.total_matches or
    new.total_wins <> old.total_wins or
    new.total_losses <> old.total_losses
  ) then
    raise exception 'server managed profile fields cannot be changed from the client';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_protect_balance on public.profiles;
drop trigger if exists profiles_protect_server_fields on public.profiles;
create trigger profiles_protect_server_fields
before update on public.profiles
for each row execute function public.protect_profile_server_fields();

create or replace function public.seed_player_inventory(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.player_inventory (user_id, item_id, quantity)
  values
    (p_user_id, 'sword', 1),
    (p_user_id, 'pistol', 1)
  on conflict (user_id, item_id) do update
  set quantity = greatest(public.player_inventory.quantity, excluded.quantity);

  insert into public.player_loadouts (user_id, primary_item_id, secondary_item_id)
  values (p_user_id, 'sword', 'pistol')
  on conflict (user_id) do update
  set primary_item_id = coalesce(public.player_loadouts.primary_item_id, excluded.primary_item_id),
      secondary_item_id = coalesce(public.player_loadouts.secondary_item_id, excluded.secondary_item_id),
      updated_at = timezone('utc', now());
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, display_name, gold_balance, can_compete, mmr, xp, level)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', 'Spectator'),
    0,
    false,
    1000,
    0,
    1
  )
  on conflict (user_id) do nothing;

  insert into public.player_loadouts (user_id, primary_item_id, secondary_item_id)
  values (new.id, null, null)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

create or replace function public.log_match_event(
  p_match_id uuid,
  p_actor_user_id uuid,
  p_event_type text,
  p_payload jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.pvp_match_events (match_id, actor_user_id, event_type, payload)
  values (p_match_id, p_actor_user_id, p_event_type, p_payload);
$$;

create or replace function public.sync_my_player_identity(p_display_name text default null)
returns public.profiles
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_identity record;
  v_profile public.profiles%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select provider, provider_id, identity_data
  into v_identity
  from auth.identities
  where user_id = v_uid
  order by coalesce(last_sign_in_at, created_at) desc
  limit 1;

  if not found then
    raise exception 'wallet_identity_not_found';
  end if;

  -- Upsert so wallet sign-in works even if no profile row exists yet (e.g. the
  -- on_auth_user_created trigger did not fire for this user, or the account
  -- predates it). A plain UPDATE would match 0 rows and leave the client with
  -- no profile to read.
  insert into public.profiles as p (
    user_id, display_name, gold_balance, can_compete,
    wallet_public_key, wallet_chain, auth_provider,
    mmr, xp, level, last_login_at
  )
  values (
    v_uid,
    coalesce(nullif(trim(p_display_name), ''), 'Trench Rookie'),
    10,
    true,
    v_identity.provider_id,
    coalesce(v_identity.identity_data ->> 'chain', 'solana'),
    v_identity.provider,
    1000, 0, 1,
    timezone('utc', now())
  )
  on conflict (user_id) do update
  set display_name = coalesce(nullif(trim(p_display_name), ''), p.display_name),
      wallet_public_key = excluded.wallet_public_key,
      wallet_chain = excluded.wallet_chain,
      auth_provider = excluded.auth_provider,
      can_compete = true,
      gold_balance = case when p.can_compete then p.gold_balance else 10 end,
      last_login_at = excluded.last_login_at
  where p.user_id = v_uid
  returning * into v_profile;

  perform public.seed_player_inventory(v_uid);

  select *
  into v_profile
  from public.profiles
  where user_id = v_uid;

  return v_profile;
end;
$$;

create or replace function public.save_my_loadout(
  p_primary_item_id text,
  p_secondary_item_id text
)
returns public.player_loadouts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.player_loadouts%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if p_primary_item_id = p_secondary_item_id then
    raise exception 'primary and secondary loadout items must differ';
  end if;

  if not exists (
    select 1 from public.player_inventory
    where user_id = v_uid and item_id = p_primary_item_id and quantity > 0
  ) then
    raise exception 'primary item not owned';
  end if;

  if not exists (
    select 1 from public.player_inventory
    where user_id = v_uid and item_id = p_secondary_item_id and quantity > 0
  ) then
    raise exception 'secondary item not owned';
  end if;

  update public.player_loadouts
  set primary_item_id = p_primary_item_id,
      secondary_item_id = p_secondary_item_id,
      updated_at = timezone('utc', now())
  where user_id = v_uid
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.topic_match_id(p_topic text, p_prefix text)
returns uuid
language plpgsql
stable
as $$
begin
  if p_topic like p_prefix || '%' then
    return substring(p_topic from char_length(p_prefix) + 1)::uuid;
  end if;
  return null;
exception
  when others then
    return null;
end;
$$;

create or replace function public.is_active_match(p_match_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.matches
    where id = p_match_id and status = 'active'
  );
$$;

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

  select mp.user_id into v_loser_user_id
  from public.match_players mp
  where mp.match_id = p_match_id
    and mp.user_id <> p_winner_user_id
  limit 1;

  update public.profiles
  set gold_balance = gold_balance + v_match.pot,
      total_matches = total_matches + 1,
      total_wins = total_wins + 1,
      xp = xp + 25,
      level = greatest(1, floor((xp + 25) / 100) + 1),
      mmr = mmr + 18
  where user_id = p_winner_user_id;

  update public.profiles
  set total_matches = total_matches + 1,
      total_losses = total_losses + 1,
      xp = xp + 10,
      level = greatest(1, floor((xp + 10) / 100) + 1),
      mmr = greatest(0, mmr - 12)
  where user_id = v_loser_user_id;

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

  perform public.log_match_event(
    p_match_id,
    p_winner_user_id,
    'match_finalized',
    jsonb_build_object('winner_user_id', p_winner_user_id, 'reason', p_reason, 'pot', v_match.pot)
  );

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
begin
  select *
  into v_profile
  from public.profiles
  where user_id = p_user_id
  for update;

  if not found then
    raise exception 'profile_not_found';
  end if;

  if not v_profile.can_compete or v_profile.wallet_public_key is null then
    raise exception 'wallet_sign_in_required_for_queue';
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
    values (v_match_id, p_user_id, 2, v_profile.display_name);

    update public.matches
    set status = 'active',
        pot = pot + 10,
        started_at = timezone('utc', now())
    where id = v_match_id;

    perform public.log_match_event(v_match_id, p_user_id, 'match_joined', jsonb_build_object('seat', 2));
    perform public.log_match_event(v_match_id, p_user_id, 'match_started', jsonb_build_object('pot', v_waiting_match.pot + 10));
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
    values (v_match_id, p_user_id, 1, v_profile.display_name);

    perform public.log_match_event(v_match_id, p_user_id, 'match_queued', jsonb_build_object('seat', 1));
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

  perform public.log_match_event(v_match.id, p_user_id, 'queue_cancelled', '{}'::jsonb);

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

  perform public.log_match_event(
    p_match_id,
    p_user_id,
    'result_claimed',
    jsonb_build_object('winner_user_id', p_winner_user_id)
  );

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

  perform public.log_match_event(p_match_id, p_user_id, 'match_forfeited', '{}'::jsonb);

  return public.finalize_match_internal(p_match_id, v_winner_user_id, 'Opponent forfeited');
end;
$$;

insert into public.player_inventory (user_id, item_id, quantity)
select p.user_id, 'sword', 1
from public.profiles p
where p.can_compete = true
on conflict (user_id, item_id) do nothing;

insert into public.player_inventory (user_id, item_id, quantity)
select p.user_id, 'pistol', 1
from public.profiles p
where p.can_compete = true
on conflict (user_id, item_id) do nothing;

update public.player_loadouts pl
set primary_item_id = coalesce(primary_item_id, 'sword'),
    secondary_item_id = coalesce(secondary_item_id, 'pistol'),
    updated_at = timezone('utc', now())
from public.profiles p
where p.user_id = pl.user_id
  and p.can_compete = true;

alter table public.item_catalog enable row level security;
alter table public.player_inventory enable row level security;
alter table public.player_loadouts enable row level security;
alter table public.pvp_match_events enable row level security;

grant select on public.item_catalog to authenticated;
grant select on public.player_inventory to authenticated;
grant select on public.player_loadouts to authenticated;
grant select on public.pvp_match_events to authenticated;
grant execute on function public.sync_my_player_identity(text) to authenticated;
grant execute on function public.save_my_loadout(text, text) to authenticated;

create policy "item_catalog_select_authenticated"
on public.item_catalog
for select
to authenticated
using (true);

create policy "inventory_select_own"
on public.player_inventory
for select
to authenticated
using (auth.uid() = user_id);

create policy "loadouts_select_own"
on public.player_loadouts
for select
to authenticated
using (auth.uid() = user_id);

create policy "pvp_events_select_active_or_member"
on public.pvp_match_events
for select
to authenticated
using (
  public.is_match_member(match_id)
  or public.is_active_match(match_id)
);

drop policy if exists "matches_select_members" on public.matches;
create policy "matches_select_active_or_members"
on public.matches
for select
to authenticated
using (
  public.is_match_member(id)
  or status = 'active'
);

drop policy if exists "match_players_select_members" on public.match_players;
create policy "match_players_select_active_or_members"
on public.match_players
for select
to authenticated
using (
  public.is_match_member(match_id)
  or public.is_active_match(match_id)
);

drop policy if exists "realtime_match_read" on realtime.messages;
drop policy if exists "realtime_match_write" on realtime.messages;

create policy "realtime_match_read"
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension in ('broadcast', 'presence')
  and (
    (
      realtime.topic() like 'match-room-%'
      and public.is_match_member(public.topic_match_id(realtime.topic(), 'match-room-'))
    )
    or (
      realtime.topic() like 'spectate-room-%'
      and public.is_active_match(public.topic_match_id(realtime.topic(), 'spectate-room-'))
    )
  )
);

create policy "realtime_match_write"
on realtime.messages
for insert
to authenticated
with check (
  realtime.messages.extension in ('broadcast', 'presence')
  and (
    (
      realtime.topic() like 'match-room-%'
      and public.is_match_member(public.topic_match_id(realtime.topic(), 'match-room-'))
    )
    or (
      realtime.topic() like 'spectate-room-%'
      and public.is_match_member(public.topic_match_id(realtime.topic(), 'spectate-room-'))
    )
  )
);
