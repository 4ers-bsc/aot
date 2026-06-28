-- ---------------------------------------------------------------------------
-- Migration: cheat ban-list.
--
-- finalize_match already flags any attacker whose recorded damage exceeds the
-- physical caps (the `flagged` set). Until now a flagged WINNER only forced the
-- match into 'disputed'; the cheater themselves faced no consequence. This
-- migration:
--
--   1. Adds public.blacklist — one row per banned wallet, with a
--      `resolution_raised` flag the player can set to appeal their ban.
--   2. Makes finalize_match ban every flagged attacker (not just the winner) by
--      inserting their deposit wallet into the blacklist.
--   3. Makes join_pvp_match reject a blacklisted wallet BEFORE the player pays
--      and takes a seat, so a banned wallet can never enter the queue again.
--   4. Adds my_ban_status() / raise_resolution() so the client can show a
--      "Resolve" button and let the player raise a resolution request.
--
-- Safe to run on an existing database. Run in the Supabase SQL editor.
-- ---------------------------------------------------------------------------

-- 1. Ban-list table -----------------------------------------------------------
create table if not exists public.blacklist (
  -- Normalised pubkey (the trailing segment after any "chain:" prefix), so it
  -- matches exactly what join_pvp_match compares against.
  wallet_address    text primary key,
  user_id           uuid references auth.users(id) on delete set null,
  reason            text,
  match_id          uuid references public.matches(id) on delete set null,
  -- The player has raised a resolution / appeal request for this ban.
  resolution_raised boolean not null default false,
  created_at        timestamptz not null default timezone('utc', now())
);

create index if not exists idx_blacklist_user on public.blacklist(user_id);

alter table public.blacklist enable row level security;

drop policy if exists "blacklist_select_own" on public.blacklist;
create policy "blacklist_select_own"
on public.blacklist for select to authenticated
using (user_id = auth.uid());

grant select on public.blacklist to authenticated;

-- 2. my_ban_status — returns the caller's ban row as jsonb, or null -----------
create or replace function public.my_ban_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_uid    uuid := auth.uid();
  v_wallet text;
  v_json   jsonb;
begin
  if v_uid is null then
    return null;
  end if;

  select provider_id into v_wallet
  from auth.identities
  where user_id = v_uid
  order by coalesce(last_sign_in_at, created_at) desc
  limit 1;

  select to_jsonb(b.*) into v_json
  from public.blacklist b
  where b.user_id = v_uid
     or b.wallet_address = regexp_replace(trim(coalesce(v_wallet, '')), '^.*:', '')
  limit 1;

  return v_json; -- null when the wallet is not banned
end;
$$;

-- 3. raise_resolution — the banned player raises a resolution request ---------
create or replace function public.raise_resolution()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid    uuid := auth.uid();
  v_wallet text;
  v_json   jsonb;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select provider_id into v_wallet
  from auth.identities
  where user_id = v_uid
  order by coalesce(last_sign_in_at, created_at) desc
  limit 1;

  update public.blacklist b
  set resolution_raised = true
  where b.user_id = v_uid
     or b.wallet_address = regexp_replace(trim(coalesce(v_wallet, '')), '^.*:', '')
  returning to_jsonb(b.*) into v_json;

  if v_json is null then
    raise exception 'not_blacklisted';
  end if;

  return v_json;
end;
$$;

grant execute on function public.my_ban_status()    to authenticated;
grant execute on function public.raise_resolution() to authenticated;

-- 4. finalize_match — ban every flagged attacker -----------------------------
--    Identical to the prior settler, with one added step: after the verdict is
--    computed, every flagged attacker's deposit wallet is added to the
--    blacklist so a confirmed cheater can never queue again.
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
  -- Physical ceilings (buffer over real stats: sword ~40 dps, ~1.4 hits/s).
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

  -- Ban every confirmed cheater (flagged attacker), not only the winner. Their
  -- deposit wallet (normalised to the trailing pubkey) goes on the blacklist so
  -- join_pvp_match rejects them on their next attempt to queue.
  insert into public.blacklist (wallet_address, user_id, reason, match_id)
  select distinct regexp_replace(trim(mp.deposit_wallet), '^.*:', ''),
         mp.user_id, 'cheat_detected', p_match_id
  from public.match_players mp
  where mp.match_id = p_match_id
    and mp.deposit_wallet is not null
    and trim(mp.deposit_wallet) <> ''
    and mp.user_id in (
      select (jsonb_array_elements_text(v_meta->'flagged'))::uuid
    )
  on conflict (wallet_address) do nothing;

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

-- 5. join_pvp_match — reject blacklisted wallets before payment/seat ----------
drop function if exists public.join_pvp_match(smallint, text, text, text);

create or replace function public.join_pvp_match(
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
  v_uid          uuid     := auth.uid();
  v_name         text;
  v_login_wallet text;
  v_size         smallint := coalesce(p_max_players, 2);
  v_match_id     uuid;
  v_seat         smallint;
  v_count        smallint;
  v_status       text;
  v_existing     record;
  c_entry_fee    constant bigint := 2500000000; -- 2500 × 10^6 (6-decimal mint)
begin
  if v_uid is null then
    raise exception 'not_authenticated';
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

  select display_name, wallet_address into v_name, v_login_wallet
  from public.sync_my_profile(p_display_name);

  -- One wallet per player: the deposit must come from the signed-in wallet.
  if v_login_wallet is null
     or regexp_replace(trim(v_login_wallet),  '^.*:', '')
      <> regexp_replace(trim(p_deposit_wallet), '^.*:', '') then
    raise exception 'deposit_wallet_mismatch: deposit must come from your signed-in wallet';
  end if;

  -- Ban gate: a blacklisted wallet may never enter the queue. Checked before
  -- any seat is taken (the on-chain deposit is also blocked client-side).
  if exists (
    select 1 from public.blacklist
    where wallet_address = regexp_replace(trim(v_login_wallet), '^.*:', '')
  ) then
    raise exception 'wallet_blacklisted: this wallet is banned for cheating';
  end if;

  -- One wallet, one unfinished match at a time — return existing seat
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
    select count(*) into v_count from public.match_players where match_id = v_match_id;
    v_seat := v_count + 1;

    insert into public.match_players (match_id, user_id, seat, display_name, deposit_tx, deposit_wallet)
    values (v_match_id, v_uid, v_seat, v_name, p_deposit_tx, trim(p_deposit_wallet));

    update public.matches
    set pot_tokens = pot_tokens + c_entry_fee
    where id = v_match_id;

    if v_seat >= v_size then
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

grant execute on function public.join_pvp_match(smallint, text, text, text) to authenticated;
