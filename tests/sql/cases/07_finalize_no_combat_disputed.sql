-- match finalize, no combat → disputed: when the timer expires with an empty
-- damage ledger and more than one player still standing, nobody is paid —
-- the match is marked disputed with no winner, and the payout slot can never
-- be claimed for it.
begin;

do $$
declare
  r record;
  m public.matches%rowtype;
begin
  -- Both players idle out the whole match, then report at the deadline.
  select * into r from tests.make_active_1v1('noc1') t;
  update public.matches set started_at = now() - interval '10 minutes'
  where id = r.match_id;  -- push past the 5-minute cap for 2-player lobbies

  perform tests.set_uid(r.u1);
  perform public.finish_match(r.match_id, 100);

  select * into m from public.matches where id = r.match_id;
  perform tests.is(m.status, 'disputed', 'no-combat match is disputed, not won');
  perform tests.ok(m.winner_user_id is null, 'no winner recorded');
  perform tests.is(m.shadow_meta ->> 'reason', 'no_combat', 'dispute reason recorded');
  perform tests.is(m.stats_applied, false, 'no stats handed out');
  perform tests.ok(m.ended_at is not null, 'ended_at stamped');

  -- Nobody can claim the pot of a disputed match.
  perform tests.set_uid(r.u1);
  perform tests.is(public.claim_payout_slot(r.match_id), false,
    'payout slot unclaimable on a disputed match');
  perform tests.set_uid(r.u2);
  perform tests.is(public.claim_payout_slot(r.match_id), false,
    'payout slot unclaimable for the other player too');

  -- Backstop sweeper: an abandoned no-combat match (nobody ever reported,
  -- every client gone) is swept into the same disputed state.
  select * into r from tests.make_active_1v1('noc2') t;
  update public.matches set started_at = now() - interval '10 minutes'
  where id = r.match_id;
  perform tests.is(public.close_stale_matches() >= 1, true,
    'sweeper picks up the stale match');

  select * into m from public.matches where id = r.match_id;
  perform tests.is(m.status, 'disputed', 'swept no-combat match is disputed');
  perform tests.ok(m.winner_user_id is null, 'swept match has no winner');

  -- Before the deadline, everyone reporting with a silent ledger does NOT
  -- settle (anti spoofed-"match-over" guard): the match holds open.
  select * into r from tests.make_active_1v1('noc3') t;
  perform tests.set_uid(r.u1);
  perform public.finish_match(r.match_id, 100);
  perform tests.set_uid(r.u2);
  perform public.finish_match(r.match_id, 100);
  perform tests.is(
    (select status from public.matches where id = r.match_id),
    'active', 'early no-combat reports leave the match open until the deadline');
end;
$$;

rollback;
