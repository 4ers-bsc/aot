-- join with valid deposit: a verified deposit takes a seat, consumes the
-- signature, grows the pot, and the match activates when the last seat fills.
begin;

do $$
declare
  u1      uuid := tests.create_player('solana:WalletJoinA', 'JoinerA');
  u2      uuid := tests.create_player('solana:WalletJoinB', 'JoinerB');
  res     jsonb;
  m       uuid;
  v_match public.matches%rowtype;
  v_seat  public.match_players%rowtype;
begin
  -- First player opens a waiting match
  res := tests.join(u1, 2, 'sig_join_a', 'solana:WalletJoinA', 'JoinerA');
  m := (res ->> 'match_id')::uuid;

  perform tests.is(res ->> 'status', 'waiting', 'first joiner waits for an opponent');
  perform tests.is((res ->> 'seat')::int, 1, 'first joiner takes seat 1');

  select * into v_seat from public.match_players where match_id = m and user_id = u1;
  perform tests.is(v_seat.deposit_tx, 'sig_join_a', 'deposit signature recorded on the seat');
  perform tests.is(v_seat.deposit_wallet, 'solana:WalletJoinA', 'deposit wallet recorded on the seat');

  perform tests.ok(
    exists (select 1 from public.consumed_deposits
            where deposit_tx = 'sig_join_a' and user_id = u1 and match_id = m),
    'deposit permanently recorded in consumed_deposits');

  select * into v_match from public.matches where id = m;
  perform tests.is(v_match.pot_tokens, tests.entry_fee(), 'pot holds one entry fee');
  perform tests.is(v_match.status, 'waiting', 'match still waiting with one seat');
  perform tests.ok(v_match.started_at is null, 'match not started yet');

  -- Login wallet captured onto the profile from auth.identities
  perform tests.is(
    (select wallet_address from public.profiles where user_id = u1),
    'solana:WalletJoinA', 'profile wallet_address synced from login identity');

  -- Second player fills the last seat → match activates
  res := tests.join(u2, 2, 'sig_join_b', 'solana:WalletJoinB', 'JoinerB');
  perform tests.is(res ->> 'match_id', m::text, 'second joiner lands in the same match');
  perform tests.is(res ->> 'status', 'active', 'match activates when full');
  perform tests.is((res ->> 'seat')::int, 2, 'second joiner takes seat 2');

  select * into v_match from public.matches where id = m;
  perform tests.is(v_match.status, 'active', 'match row is active');
  perform tests.is(v_match.pot_tokens, 2 * tests.entry_fee(), 'pot holds both entry fees');
  perform tests.ok(v_match.started_at is not null, 'started_at stamped on activation');

  -- Bad inputs are rejected before any money moves
  perform tests.throws(
    format('select public.join_pvp_match(%L::uuid, 2::smallint, null, null, %L)',
           u1, 'solana:WalletJoinA'),
    'deposit_tx_required%', 'join without a deposit tx is rejected');

  perform tests.throws(
    format('select public.join_pvp_match(%L::uuid, 2::smallint, %L, null, null)',
           u1, 'sig_join_x'),
    'deposit_wallet_required%', 'join without a deposit wallet is rejected');

  perform tests.throws(
    format('select tests.join(%L::uuid, 3, %L, %L)',
           tests.create_player('solana:WalletJoinC'), 'sig_join_c', 'solana:WalletJoinC'),
    'invalid_max_players%', 'unsupported lobby size is rejected');
end;
$$;

rollback;
