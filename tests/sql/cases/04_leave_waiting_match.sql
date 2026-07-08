-- leave waiting match: leaving a waiting lobby frees the seat, refunds the
-- pot accounting, and closes the match when it empties. Leaving does NOT
-- touch active matches (no mid-fight exit with the pot).
begin;

do $$
declare
  u1  uuid := tests.create_player('solana:WalletLeaveA');
  u2  uuid := tests.create_player('solana:WalletLeaveB');
  u3  uuid := tests.create_player('solana:WalletLeaveC');
  res jsonb;
  m5  uuid;
  r   record;
begin
  -- Two players in a 5-player lobby; one leaves → seat freed, pot decremented,
  -- match stays open for the remaining player.
  res := tests.join(u1, 5, 'sig_leave_1', 'solana:WalletLeaveA');
  m5 := (res ->> 'match_id')::uuid;
  perform tests.join(u2, 5, 'sig_leave_2', 'solana:WalletLeaveB');

  perform tests.set_uid(u1);
  perform public.leave_my_matches();

  perform tests.ok(
    not exists (select 1 from public.match_players where match_id = m5 and user_id = u1),
    'leaver''s seat row deleted');
  select status, pot_tokens into r from public.matches where id = m5;
  perform tests.is(r.status, 'waiting', 'lobby stays open for the remaining player');
  perform tests.is(r.pot_tokens, tests.entry_fee(), 'pot decremented by the leaver''s entry fee');

  -- Last player leaves → empty lobby is closed out
  perform tests.set_uid(u2);
  perform public.leave_my_matches();
  select status, pot_tokens, ended_at into r from public.matches where id = m5;
  perform tests.is(r.status, 'finished', 'emptied lobby is finished');
  perform tests.is(r.pot_tokens, 0::bigint, 'emptied lobby pot back to zero');
  perform tests.ok(r.ended_at is not null, 'emptied lobby stamped ended_at');

  -- A freed middle seat is reusable: in a 5-lobby with seats 1..3 taken,
  -- seat 2's owner leaves and the next joiner is assigned the gap (seat 2).
  res := tests.join(u3, 5, 'sig_leave_3', 'solana:WalletLeaveC');
  m5 := (res ->> 'match_id')::uuid;
  perform tests.join(tests.create_player('solana:WalletLeaveD'), 5, 'sig_leave_4', 'solana:WalletLeaveD');
  perform tests.join(tests.create_player('solana:WalletLeaveE'), 5, 'sig_leave_5', 'solana:WalletLeaveE');
  perform tests.set_uid((select user_id from public.match_players where match_id = m5 and seat = 2));
  perform public.leave_my_matches();
  res := tests.join(tests.create_player('solana:WalletLeaveF'), 5, 'sig_leave_6', 'solana:WalletLeaveF');
  perform tests.is(res ->> 'match_id', m5::text, 'next joiner fills the same lobby');
  perform tests.is((res ->> 'seat')::int, 2, 'freed middle seat is handed to the next joiner');

  -- Leaving an ACTIVE match is a no-op: the deposit is committed to the fight
  perform tests.set_uid(null);
  select t.match_id, t.u1, t.u2 into r from tests.make_active_1v1('leave_active') t;
  perform tests.set_uid(r.u1);
  perform public.leave_my_matches();
  perform tests.ok(
    exists (select 1 from public.match_players where match_id = r.match_id and user_id = r.u1),
    'active match seat survives leave_my_matches');
  perform tests.is(
    (select status from public.matches where id = r.match_id),
    'active', 'active match unaffected by leave');
  perform tests.is(
    (select pot_tokens from public.matches where id = r.match_id),
    2 * tests.entry_fee(), 'active match pot unaffected by leave');

  -- Unauthenticated caller is rejected
  perform tests.set_uid(null);
  perform tests.throws('select public.leave_my_matches()',
    'not_authenticated%', 'leave requires authentication');
end;
$$;

rollback;
