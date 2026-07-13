-- ============================================================================
-- Protect constant/config tables from wipes, and flag timed-out (under-filled)
-- lobbies for refund review.
--
--   A. Wipe guard: pvp_config / match_config / maintain / escrow_payout_lock
--      hold constant configuration or static locks — they must NEVER be wiped
--      (a wipe would reset the entry fee, durations, maintenance switch, etc.).
--      admin_truncate_table now refuses them and admin_truncate_all skips them.
--
--   B. Timed-out lobby refund review: when a waiting lobby never fills, the paid
--      player's entry is forfeited. Close the match (so the player CANNOT rejoin
--      it — a finished match is not returned by join_pvp_match's rejoin check,
--      and the deposit stays in consumed_deposits so it can't be reused) and
--      file a review note per paid seat so an operator can decide on a refund.
--
-- Safe to run (and re-run) on an existing database.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- A. Wipe guard
-- ---------------------------------------------------------------------------
create or replace function public.admin_is_protected_table(p_table text)
returns boolean
language sql
immutable
set search_path = public
as $$
  -- Constant configuration + static single-row locks: never wipeable.
  select p_table in ('pvp_config', 'match_config', 'maintain', 'escrow_payout_lock');
$$;

-- Refuse a single-table wipe of a protected table.
create or replace function public.admin_truncate_table(p_table text)
returns bigint
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_count bigint;
  v_refs  text;
begin
  perform public.admin_assert_public_table(p_table);

  if public.admin_is_protected_table(p_table) then
    raise exception 'protected_table: % holds constant configuration and cannot be wiped', p_table;
  end if;

  select string_agg(distinct c.conrelid::regclass::text, ', ' order by c.conrelid::regclass::text)
    into v_refs
  from pg_constraint c
  where c.contype = 'f'
    and c.confrelid = ('public.' || quote_ident(p_table))::regclass
    and c.conrelid <> c.confrelid;
  if v_refs is not null then
    raise exception 'has_references: % is referenced by: % — wipe those first, or use "Wipe ALL".', p_table, v_refs;
  end if;

  execute format('select count(*) from public.%I', p_table) into v_count;
  execute format('truncate table public.%I restart identity', p_table);
  return v_count;
end;
$$;

-- Wipe every table EXCEPT the protected config/static ones, which are preserved.
create or replace function public.admin_truncate_all()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_list   text;
  v_names  text[];
  v_total  bigint := 0;
  v_count  bigint;
begin
  select array_agg(table_name order by table_name)
    into v_names
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
    and not public.admin_is_protected_table(table_name);

  if v_names is null or array_length(v_names, 1) is null then
    return jsonb_build_object('tables', '[]'::jsonb, 'rows', 0, 'preserved', to_jsonb(array['pvp_config','match_config','maintain','escrow_payout_lock']));
  end if;

  foreach v_list in array v_names loop
    execute format('select count(*) from public.%I', v_list) into v_count;
    v_total := v_total + v_count;
  end loop;

  select string_agg(format('public.%I', table_name), ', ')
    into v_list
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
    and not public.admin_is_protected_table(table_name);
  execute 'truncate table ' || v_list || ' restart identity cascade';

  return jsonb_build_object(
    'tables', to_jsonb(v_names),
    'rows', v_total,
    'preserved', to_jsonb(array['pvp_config','match_config','maintain','escrow_payout_lock'])
  );
end;
$$;

revoke all on function public.admin_is_protected_table(text) from public, anon, authenticated;
grant execute on function public.admin_is_protected_table(text) to service_role;

-- ---------------------------------------------------------------------------
-- B. Timed-out lobby refund review
-- ---------------------------------------------------------------------------
-- settle_abandoned_lobby — close an under-filled WAITING lobby and file a
-- refund-review note per paid seat. Idempotent: only acts while the match is
-- still 'waiting', so a second call (or a concurrent sweep) is a no-op. Seats
-- are NOT deleted (the deposit tx/wallet must survive for the refund decision)
-- and the pot is left in escrow. Returns true iff it closed the lobby.
create or replace function public.settle_abandoned_lobby(p_match_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_maxp   smallint;
  v_filled int;
begin
  select status, max_players into v_status, v_maxp
  from public.matches where id = p_match_id
  for update;
  if not found or v_status <> 'waiting' then
    return false;
  end if;

  select count(*) into v_filled from public.match_players where match_id = p_match_id;

  -- One review note per PAID seat (subject_type 'waiting' is an allowed value;
  -- action 'lobby_timeout_refund' makes them easy to find/triage).
  insert into public.review_notes (subject_type, subject_id, note, action, author_id)
  select 'waiting', p_match_id::text,
         format('Lobby timed out under-filled (%s/%s seats). %s paid the entry fee (wallet %s, deposit %s) but the match never started — review for refund.',
                v_filled, v_maxp,
                coalesce(mp.display_name, 'player'),
                coalesce(mp.deposit_wallet, '?'),
                mp.deposit_tx),
         'lobby_timeout_refund', null
  from public.match_players mp
  where mp.match_id = p_match_id and mp.deposit_tx is not null;

  -- Close it so the player can't rejoin (join_pvp_match only rejoins
  -- waiting/active matches; the deposit is already in consumed_deposits).
  update public.matches
  set status = 'finished', ended_at = timezone('utc', now())
  where id = p_match_id and status = 'waiting';

  return true;
end;
$$;

-- abandon_stale_lobby — client-callable wrapper. A participant whose lobby has
-- timed out settles it. Guarded so a player can only close a lobby they're in,
-- and only once it is genuinely stale (open > 10 min), matching the client's
-- lobby poll timeout — this prevents closing a fresh lobby out from under a
-- co-waiter.
create or replace function public.abandon_stale_lobby(p_match_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid     uuid := auth.uid();
  v_created timestamptz;
  v_status  text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if not exists (select 1 from public.match_players where match_id = p_match_id and user_id = v_uid) then
    raise exception 'not_a_participant';
  end if;

  select created_at, status into v_created, v_status
  from public.matches where id = p_match_id;
  if not found or v_status <> 'waiting' then
    return false;  -- already settled/active; nothing to do
  end if;
  if v_created > now() - interval '10 minutes' then
    raise exception 'lobby_not_stale: lobby is not old enough to abandon';
  end if;

  return public.settle_abandoned_lobby(p_match_id);
end;
$$;

revoke all on function public.settle_abandoned_lobby(uuid) from public, anon, authenticated;
grant execute on function public.settle_abandoned_lobby(uuid) to service_role;
revoke all on function public.abandon_stale_lobby(uuid) from public, anon;
grant execute on function public.abandon_stale_lobby(uuid) to authenticated, service_role;

-- Extend the backstop sweeper to also close stale WAITING lobbies (open past
-- ~15 min) that never filled, flagging each paid seat for refund review — so
-- this happens even when no client is around to trigger abandon_stale_lobby.
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
  -- Active matches past their hard time cap → authoritative ledger settle.
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

  -- Under-filled waiting lobbies open too long → close + refund review.
  for r in
    select m.id
    from matches m
    where m.status = 'waiting'
      and m.created_at < now() - interval '15 minutes'
    for update of m skip locked
  loop
    if public.settle_abandoned_lobby(r.id) then
      v_closed := v_closed + 1;
    end if;
  end loop;

  return v_closed;
end;
$$;

commit;
