-- ============================================================================
-- Set the PvP entry fee to 10,000 $FIGHT10 per player (was 2,500).
--
-- Touches every place the fee is a constant/default/fallback:
--   • pvp_config.entry_fee_tokens — column default + the live row (the guard
--     trigger is briefly disabled to pin the constant regardless of board state)
--   • pvp_settings() fallback
--   • join_pvp_match / leave_my_matches pot bookkeeping constant + new-match
--     snapshot fallback
-- The edge functions (f10join / f10treasurer / f10admin) fallback literals are
-- updated in their own files. matches created before this migration keep their
-- snapshotted entry_fee_tokens, so their payouts are unaffected.
--
-- Safe to run (and re-run) on an existing database.
-- ============================================================================

begin;

-- Column default + live row. Disable the guard so the constant pins even if
-- matches are live (this is a fixed constant, not a mid-flight change).
alter table public.pvp_config alter column entry_fee_tokens set default 10000;
alter table public.pvp_config disable trigger pvp_config_guard;
update public.pvp_config set entry_fee_tokens = 10000 where id;
alter table public.pvp_config enable trigger pvp_config_guard;

-- pvp_settings() fallback → 10000.
create or replace function public.pvp_settings()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'player_cap',       public.pvp_capacity_cap(),
    'entry_fee_tokens', coalesce((select entry_fee_tokens from public.pvp_config where id), 10000),
    'winner_share_bps', coalesce((select winner_share_bps from public.pvp_config where id), 9000)
  );
$$;
grant execute on function public.pvp_settings() to authenticated, anon;

-- join_pvp_match — identical to 20260726_join_pvp_match_hardening.sql except the
-- pot-bookkeeping constant and the new-match fee fallback are now 10000.
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
  v_requested    text;
  v_login_wallet text;
  v_size         smallint := coalesce(p_max_players, 2);
  v_match_id     uuid;
  v_seat         smallint;
  v_count        smallint;
  v_status       text;
  v_existing     record;
  v_deposit_tx   text;
  v_fee          int;
  v_share        int;
  v_dur          int;
  c_entry_fee    constant bigint := 10000;
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

  v_deposit_tx := lower(trim(p_deposit_tx));

  perform pg_advisory_xact_lock(hashtext('fight10_join_user:' || v_uid::text));

  v_requested := nullif(trim(p_display_name), '');
  if v_requested is not null and exists (
       select 1 from public.profiles
       where lower(display_name) = lower(v_requested) and user_id <> v_uid
     ) then
    v_requested := null;
  end if;

  begin
    insert into public.profiles as p (user_id, display_name, wallet_address)
    values (
      v_uid,
      coalesce(v_requested, public.generate_unique_username()),
      (select provider_id from auth.identities
         where user_id = v_uid
         order by coalesce(last_sign_in_at, created_at) desc
         limit 1)
    )
    on conflict (user_id) do update
    set display_name   = coalesce(v_requested, p.display_name),
        wallet_address = coalesce(excluded.wallet_address, p.wallet_address)
    where p.user_id = v_uid
    returning display_name, wallet_address into v_name, v_login_wallet;
  exception when unique_violation then
    insert into public.profiles as p (user_id, display_name, wallet_address)
    values (
      v_uid,
      public.generate_unique_username(),
      (select provider_id from auth.identities
         where user_id = v_uid
         order by coalesce(last_sign_in_at, created_at) desc
         limit 1)
    )
    on conflict (user_id) do update
    set wallet_address = coalesce(excluded.wallet_address, p.wallet_address)
    where p.user_id = v_uid
    returning display_name, wallet_address into v_name, v_login_wallet;
  end;

  if v_login_wallet is null
     or lower(regexp_replace(trim(v_login_wallet),  '^.*:', ''))
      <> lower(regexp_replace(trim(p_deposit_wallet), '^.*:', '')) then
    raise exception 'deposit_wallet_mismatch: deposit must come from your signed-in wallet';
  end if;

  select mp.match_id, mp.seat, m.status, m.max_players, m.started_at
  into   v_existing
  from   public.match_players mp
  join   public.matches m on m.id = mp.match_id
  where  mp.user_id = v_uid
    and  m.status in ('waiting', 'active')
  limit 1;

  if found and v_existing.status = 'active' then
    perform public.finalize_match(
      v_existing.match_id,
      v_existing.started_at is not null
        and now() >= v_existing.started_at
                     + make_interval(secs => public.match_duration_seconds(v_existing.max_players))
    );

    select mp.match_id, mp.seat, m.status, m.max_players, m.started_at
    into   v_existing
    from   public.match_players mp
    join   public.matches m on m.id = mp.match_id
    where  mp.user_id = v_uid
      and  m.status in ('waiting', 'active')
    limit 1;
  end if;

  if found then
    return jsonb_build_object(
      'match_id',    v_existing.match_id,
      'seat',        v_existing.seat,
      'status',      v_existing.status,
      'max_players', v_existing.max_players,
      'rejoining',   true
    );
  end if;

  if exists (select 1 from public.consumed_deposits where lower(deposit_tx) = v_deposit_tx) then
    raise exception 'deposit_already_used: this deposit was already spent on a match entry';
  end if;

  perform pg_advisory_xact_lock(hashtext('fight10_pvp_capacity'));
  if (select count(*) from public.match_players mp
      join public.matches m on m.id = mp.match_id
      where m.status in ('waiting', 'active')) >= public.pvp_capacity_cap() then
    raise exception 'servers_full: % player cap reached, try again shortly', public.pvp_capacity_cap();
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
    values (v_match_id, v_uid, v_seat, v_name, v_deposit_tx, trim(p_deposit_wallet));

    insert into public.consumed_deposits (deposit_tx, user_id, match_id)
    values (v_deposit_tx, v_uid, v_match_id);

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

  select entry_fee_tokens, winner_share_bps into v_fee, v_share
  from public.pvp_config limit 1;
  select duration_seconds into v_dur
  from public.match_config where max_players = v_size;

  insert into public.matches (
    status, max_players, created_by,
    entry_fee_tokens, winner_share_bps, duration_seconds
  )
  values (
    'waiting', v_size, v_uid,
    coalesce(v_fee, 10000), coalesce(v_share, 9000), v_dur
  )
  returning id into v_match_id;

  v_seat := 1;
  insert into public.match_players (match_id, user_id, seat, display_name, deposit_tx, deposit_wallet)
  values (v_match_id, v_uid, v_seat, v_name, v_deposit_tx, trim(p_deposit_wallet));

  insert into public.consumed_deposits (deposit_tx, user_id, match_id)
  values (v_deposit_tx, v_uid, v_match_id);

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

-- leave_my_matches — pot refund bookkeeping constant → 10000.
create or replace function public.leave_my_matches()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid         uuid := auth.uid();
  r             record;
  v_remaining   integer;
  v_had_deposit boolean;
  c_entry_fee   constant bigint := 10000; -- whole tokens; see join_pvp_match
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
      select (deposit_tx is not null) into v_had_deposit
      from public.match_players
      where match_id = r.id and user_id = v_uid;

      delete from public.match_players where match_id = r.id and user_id = v_uid;

      if v_had_deposit then
        update public.matches
        set pot_tokens = greatest(0, pot_tokens - c_entry_fee)
        where id = r.id;
      end if;

      select count(*) into v_remaining from public.match_players where match_id = r.id;
      if v_remaining = 0 then
        update public.matches set status = 'finished', ended_at = timezone('utc', now()) where id = r.id;
      end if;
    end if;
  end loop;
end;
$$;
grant execute on function public.leave_my_matches() to authenticated;

commit;
