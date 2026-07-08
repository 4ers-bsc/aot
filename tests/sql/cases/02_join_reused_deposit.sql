-- join with reused deposit: a deposit signature buys exactly one seat, ever.
-- Reuse is rejected while the original seat exists AND after it was released
-- (leaving a waiting lobby deletes the seat row, but consumed_deposits is
-- permanent).
begin;

do $$
declare
  u1  uuid := tests.create_player('solana:WalletDupA');
  u2  uuid := tests.create_player('solana:WalletDupB');
  u3  uuid := tests.create_player('solana:WalletDupC');
  res jsonb;
  m   uuid;
begin
  res := tests.join(u1, 2, 'sig_dup_1', 'solana:WalletDupA');
  m := (res ->> 'match_id')::uuid;

  -- Another wallet replaying the same signature while the seat exists
  perform tests.throws(
    format('select tests.join(%L::uuid, 2, %L, %L)', u2, 'sig_dup_1', 'solana:WalletDupB'),
    'deposit_already_used%', 'live seat: replayed deposit is rejected');

  -- Owner leaves the waiting lobby: seat row (and its unique deposit_tx) gone
  perform tests.set_uid(u1);
  perform public.leave_my_matches();
  perform tests.ok(
    not exists (select 1 from public.match_players where match_id = m and user_id = u1),
    'seat released after leaving the waiting lobby');

  -- ...but the signature stays consumed forever
  perform tests.throws(
    format('select tests.join(%L::uuid, 2, %L, %L)', u2, 'sig_dup_1', 'solana:WalletDupB'),
    'deposit_already_used%', 'released seat: replayed deposit still rejected');

  -- Even the original depositor cannot spend it twice
  perform tests.throws(
    format('select tests.join(%L::uuid, 2, %L, %L)', u1, 'sig_dup_1', 'solana:WalletDupA'),
    'deposit_already_used%', 'original owner cannot reuse own deposit');

  -- Retry after a lost response: a seated player joining again gets their
  -- existing seat back (rejoining=true) and the retry deposit is NOT consumed.
  res := tests.join(u3, 2, 'sig_dup_2', 'solana:WalletDupC');
  m := (res ->> 'match_id')::uuid;
  res := tests.join(u3, 2, 'sig_dup_3', 'solana:WalletDupC');
  perform tests.is((res ->> 'rejoining')::boolean, true, 'seated player is told they are rejoining');
  perform tests.is(res ->> 'match_id', m::text, 'rejoin returns the existing seat''s match');
  perform tests.ok(
    not exists (select 1 from public.consumed_deposits where deposit_tx = 'sig_dup_3'),
    'rejoin retry does not burn the second deposit signature');
end;
$$;

rollback;
