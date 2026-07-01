-- ============================================================================
-- Wallet / account bans.
--
-- A banned account cannot join or play. Bans are applied automatically when:
--   • the settlement forfeits a player for impossible combat output, and
--   • a privileged caller (the edge functions) detects a non-browser / direct
--     (curl-style) request and bans the offending wallet.
-- ban_user() also removes the offender from any open match immediately, which —
-- combined with the existing RLS (combat writes require match membership) —
-- neutralises them even mid-match.
--
-- Safe to run on an existing project (idempotent).
-- ============================================================================

create table if not exists public.banned_users (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  wallet     text,
  reason     text,
  created_at timestamptz not null default now()
);

alter table public.banned_users enable row level security;

-- A player may check their own ban status; the list itself is not world-readable.
drop policy if exists "banned_select_own" on public.banned_users;
create policy "banned_select_own"
on public.banned_users for select to authenticated
using (user_id = auth.uid());

grant select on public.banned_users to authenticated;

-- is_banned — true if the account is banned. SECURITY DEFINER so it works from
-- both client-scoped and service-role calls.
create or replace function public.is_banned(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.banned_users where user_id = p_user_id);
$$;

-- ban_user — record the ban (capturing the wallet) and eject the account from any
-- waiting/active match so it cannot keep playing.
create or replace function public.ban_user(p_user_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null then return; end if;

  insert into public.banned_users (user_id, wallet, reason)
  values (
    p_user_id,
    (select wallet_address from public.profiles where user_id = p_user_id),
    left(coalesce(p_reason, 'violation'), 200)
  )
  on conflict (user_id) do nothing;

  delete from public.match_players mp
  using public.matches m
  where mp.user_id = p_user_id
    and mp.match_id = m.id
    and m.status in ('waiting', 'active');
end;
$$;

grant execute on function public.is_banned(uuid) to authenticated, service_role;
grant execute on function public.ban_user(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Auto-ban forfeited cheaters. finalize_match records impossible-output players
-- in matches.forfeited_user_ids; this trigger bans them once the row settles.
-- (Done in a trigger, not inside finalize_match, so it commits with the
-- settlement instead of being rolled back by any later error.)
-- ---------------------------------------------------------------------------
create or replace function public.ban_forfeited()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  u uuid;
begin
  foreach u in array new.forfeited_user_ids loop
    perform public.ban_user(u, 'impossible_combat_output');
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_ban_forfeited on public.matches;
create trigger trg_ban_forfeited
  after update of forfeited_user_ids on public.matches
  for each row
  when (new.forfeited_user_ids is distinct from old.forfeited_user_ids
        and coalesce(array_length(new.forfeited_user_ids, 1), 0) > 0)
  execute function public.ban_forfeited();

-- ---------------------------------------------------------------------------
-- Block banned accounts at admission. Re-defines join_pvp_match to reject a
-- banned user up front (it is service-role only; the f10join edge function and
-- client also check, but this is the authoritative guard).
-- ---------------------------------------------------------------------------
create or replace function public.join_pvp_match(
  p_user_id        uuid,
  p_max_players    smallint default 2,
  p_deposit_tx     text     default null,
  p_display_name   text     default null,
  p_deposit_wallet text     default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid          uuid     := p_user_id;
  v_name         text;
  v_login_wallet text;
  v_size         smallint := coalesce(p_max_players, 2);
  v_match_id     uuid;
  v_seat         smallint;
  v_count        smallint;
  v_status       text;
  v_existing     record;
  c_entry_fee    constant bigint := 2500000000;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if public.is_banned(v_uid) then
    raise exception 'banned: this account is banned from play';
  end if;

  if p_deposit_tx is null or trim(p_deposit_tx) = '' then
    raise exception 'deposit_tx_required';
  end if;

  if p_deposit_wallet is null or trim(p_deposit_wallet) = '' then
    raise exception 'deposit_wallet_required';
  end if;

  if v_size not in (2, 5, 10) then
    raise exception 'invalid_max_players: must be 2, 5, or 10';
  end if;

  insert into public.profiles as p (user_id, display_name, wallet_address)
  values (
    v_uid,
    coalesce(nullif(trim(p_display_name), ''), 'Trench Rookie'),
    (select provider_id from auth.identities
       where user_id = v_uid
       order by coalesce(last_sign_in_at, created_at) desc
       limit 1)
  )
  on conflict (user_id) do update
  set display_name   = coalesce(nullif(trim(p_display_name), ''), p.display_name),
      wallet_address = coalesce(excluded.wallet_address, p.wallet_address)
  where p.user_id = v_uid
  returning display_name, wallet_address into v_name, v_login_wallet;

  if v_login_wallet is null
     or regexp_replace(trim(v_login_wallet),  '^.*:', '')
      <> regexp_replace(trim(p_deposit_wallet), '^.*:', '') then
    raise exception 'deposit_wallet_mismatch: deposit must come from your signed-in wallet';
  end if;

  select mp.match_id, mp.seat, m.status, m.max_players
  into   v_existing
  from   public.match_players mp
  join   public.matches m on m.id = mp.match_id
  where  mp.user_id = v_uid
    and  m.status in ('waiting', 'active')
  limit 1;

  if found then
    return jsonb_build_object(
      'match_id',    v_existing.match_id,
      'seat',        v_existing.seat,
      'status',      v_existing.status,
      'max_players', v_existing.max_players,
      'rejoining',   true
    );
  end if;

  select m.id into v_match_id
  from   public.matches m
  where  m.status      = 'waiting'
    and  m.max_players = v_size
    and  (select count(*) from public.match_players mp where mp.match_id = m.id) < m.max_players
  order  by m.created_at
  for update of m skip locked
  limit  1;

  if found then
    select min(s) into v_seat
    from   generate_series(1, v_size) s
    where  s not in (select seat from public.match_players where match_id = v_match_id);

    insert into public.match_players (match_id, user_id, seat, display_name, deposit_tx, deposit_wallet)
    values (v_match_id, v_uid, v_seat, v_name, p_deposit_tx, trim(p_deposit_wallet));

    update public.matches
    set pot_tokens = pot_tokens + c_entry_fee
    where id = v_match_id;

    select count(*) into v_count from public.match_players where match_id = v_match_id;
    if v_count >= v_size then
      update public.matches
      set status = 'active', started_at = timezone('utc', now())
      where id = v_match_id;
      v_status := 'active';
    else
      v_status := 'waiting';
    end if;

    return jsonb_build_object(
      'match_id',    v_match_id,
      'seat',        v_seat,
      'status',      v_status,
      'max_players', v_size
    );
  end if;

  insert into public.matches (status, max_players, created_by)
  values ('waiting', v_size, v_uid)
  returning id into v_match_id;

  v_seat := 1;
  insert into public.match_players (match_id, user_id, seat, display_name, deposit_tx, deposit_wallet)
  values (v_match_id, v_uid, v_seat, v_name, p_deposit_tx, trim(p_deposit_wallet));

  update public.matches
  set pot_tokens = pot_tokens + c_entry_fee
  where id = v_match_id;

  return jsonb_build_object(
    'match_id',    v_match_id,
    'seat',        v_seat,
    'status',      'waiting',
    'max_players', v_size
  );
end;
$$;

revoke all on function public.join_pvp_match(uuid, smallint, text, text, text) from public, anon, authenticated;
grant execute on function public.join_pvp_match(uuid, smallint, text, text, text) to service_role;
