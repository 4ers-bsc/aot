-- ============================================================================
-- Test helpers. Runs AFTER supabase/fresh_setup.sql.
-- Assertions raise an exception on failure; the runner (run.sh) executes each
-- case file with ON_ERROR_STOP so any raised assertion fails that file.
-- ============================================================================

create schema if not exists tests;

-- Impersonate a player: auth.uid() (shimmed in 00_auth_shim.sql) returns this
-- value until changed. Pass null to become unauthenticated.
create or replace function tests.set_uid(p_uid uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('test.auth_uid', coalesce(p_uid::text, ''), false);
end;
$$;

create or replace function tests.ok(p_cond boolean, p_what text)
returns void
language plpgsql
as $$
begin
  if p_cond is distinct from true then
    raise exception 'ASSERT FAILED: %', p_what;
  end if;
end;
$$;

create or replace function tests.is(p_actual anycompatible, p_expected anycompatible, p_what text)
returns void
language plpgsql
as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'ASSERT FAILED: % — got %, expected %',
      p_what, coalesce(p_actual::text, 'NULL'), coalesce(p_expected::text, 'NULL');
  end if;
end;
$$;

-- Assert that executing p_sql raises an error whose message matches p_pattern
-- (LIKE pattern). Fails when no error is raised or a different one is.
create or replace function tests.throws(p_sql text, p_pattern text, p_what text)
returns void
language plpgsql
as $$
declare
  v_err text;
begin
  begin
    execute p_sql;
  exception when others then
    v_err := sqlerrm;
    if v_err like p_pattern then
      return;
    end if;
    raise exception 'ASSERT FAILED: % — raised "%", expected message like "%"',
      p_what, v_err, p_pattern;
  end;
  raise exception 'ASSERT FAILED: % — no error raised, expected message like "%"',
    p_what, p_pattern;
end;
$$;

-- Create an auth user (+ optional signed-in wallet identity). The
-- on_auth_user_created trigger provisions the profile, exactly as in
-- production sign-up.
create or replace function tests.create_player(p_wallet text default null, p_name text default null)
returns uuid
language plpgsql
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, raw_user_meta_data)
  values (v_id, case when p_name is null then '{}'::jsonb
                     else jsonb_build_object('display_name', p_name) end);

  if p_wallet is not null then
    insert into auth.identities (user_id, provider, provider_id, last_sign_in_at)
    values (v_id, 'web3', p_wallet, now());
  end if;

  return v_id;
end;
$$;

-- Thin wrapper over the service-role join RPC so case files read cleanly.
create or replace function tests.join(
  p_user   uuid,
  p_size   int,
  p_tx     text,
  p_wallet text,
  p_name   text default null
)
returns jsonb
language sql
as $$
  select public.join_pvp_match(p_user, p_size::smallint, p_tx, p_name, p_wallet);
$$;

-- The entry fee constant used by join_pvp_match / leave_my_matches
-- (2500 tokens on a 6-decimal mint).
create or replace function tests.entry_fee()
returns bigint
language sql
immutable
as $$
  select 2500000000::bigint;
$$;

-- Record damage in the combat ledger (as the attacker's client would).
create or replace function tests.deal_damage(
  p_match    uuid,
  p_attacker uuid,
  p_victim   uuid,
  p_total    int,
  p_hits     int,
  p_first_ms bigint default 1000,
  p_last_ms  bigint default 61000
)
returns void
language plpgsql
as $$
begin
  insert into public.match_damage
    (match_id, attacker, victim, total_damage, hit_count, first_t_ms, last_t_ms)
  values
    (p_match, p_attacker, p_victim, p_total, p_hits, p_first_ms, p_last_ms);
end;
$$;

-- Simulate a disconnect: lapse the player's heartbeat past finalize_match's
-- 15-second grace window.
create or replace function tests.disconnect(p_match uuid, p_user uuid)
returns void
language plpgsql
as $$
begin
  update public.match_players
  set last_seen = now() - interval '60 seconds'
  where match_id = p_match and user_id = p_user;
end;
$$;

-- Build a full 1v1 match: both players join with valid deposits, match goes
-- active. Returns (match_id, u1, u2); u1/u2 hold seats 1/2.
create or replace function tests.make_active_1v1(p_tag text)
returns table (match_id uuid, u1 uuid, u2 uuid)
language plpgsql
as $$
declare
  v_u1   uuid := tests.create_player('solana:W1_' || p_tag);
  v_u2   uuid := tests.create_player('solana:W2_' || p_tag);
  v_res1 jsonb;
  v_res2 jsonb;
begin
  v_res1 := tests.join(v_u1, 2, 'sig1_' || p_tag, 'solana:W1_' || p_tag);
  v_res2 := tests.join(v_u2, 2, 'sig2_' || p_tag, 'solana:W2_' || p_tag);
  perform tests.is(v_res2 ->> 'match_id', v_res1 ->> 'match_id',
                   'make_active_1v1: both players must land in the same match');
  perform tests.is(v_res2 ->> 'status', 'active', 'make_active_1v1: match must be active');
  return query select (v_res2 ->> 'match_id')::uuid, v_u1, v_u2;
end;
$$;
