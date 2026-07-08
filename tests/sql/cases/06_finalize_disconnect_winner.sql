-- match finalize, disconnect winner: a player whose heartbeat lapsed and who
-- never reported is eliminated. The remaining player wins — via the ledger
-- when combat happened, via walkover when it didn't.
begin;

do $$
declare
  r record;
  m public.matches%rowtype;
begin
  -- Combat happened, then the opponent vanished. Even though the deserter
  -- took less damage (higher HP), the connected player wins.
  select * into r from tests.make_active_1v1('dc1') t;
  perform tests.deal_damage(r.match_id, r.u2, r.u1, 50, 20);  -- u1 down to 50hp
  perform tests.deal_damage(r.match_id, r.u1, r.u2, 20, 10);  -- u2 at 80hp
  perform tests.disconnect(r.match_id, r.u2);

  perform tests.set_uid(r.u1);
  perform public.finish_match(r.match_id, 50);

  select * into m from public.matches where id = r.match_id;
  perform tests.is(m.status, 'finished', 'disconnect does not block settlement');
  perform tests.is(m.winner_user_id, r.u1, 'connected player beats the higher-HP deserter');
  perform tests.ok(m.shadow_meta -> 'disconnected' @> to_jsonb(r.u2::text),
    'deserter recorded as disconnected in settlement meta');
  perform tests.is(m.stats_applied, true, 'stats applied on disconnect win');
  perform tests.is((select wins from public.profiles where user_id = r.u1), 1,
    'survivor credited with the win');
  perform tests.is((select losses from public.profiles where user_id = r.u2), 1,
    'deserter takes the loss');

  -- No combat at all: last player standing wins by walkover.
  select * into r from tests.make_active_1v1('dc2') t;
  perform tests.disconnect(r.match_id, r.u2);
  perform tests.set_uid(r.u1);
  perform public.finish_match(r.match_id, 100);

  select * into m from public.matches where id = r.match_id;
  perform tests.is(m.status, 'finished', 'walkover settles the match');
  perform tests.is(m.winner_user_id, r.u1, 'last player standing wins by walkover');
  perform tests.is(m.shadow_meta ->> 'reason', 'walkover', 'settlement reason recorded');
  perform tests.is(m.stats_applied, true, 'stats applied on walkover');

  -- A player who reported BEFORE disconnecting keeps their standing: u2 wins
  -- on damage, reports, then goes stale — the win is still theirs.
  select * into r from tests.make_active_1v1('dc3') t;
  perform tests.deal_damage(r.match_id, r.u2, r.u1, 100, 40);
  perform tests.set_uid(r.u2);
  perform public.finish_match(r.match_id, 100);
  perform tests.disconnect(r.match_id, r.u2);
  perform tests.set_uid(r.u1);
  perform public.finish_match(r.match_id, 0);

  select * into m from public.matches where id = r.match_id;
  perform tests.is(m.winner_user_id, r.u2,
    'reported-then-disconnected player keeps their earned win');
end;
$$;

rollback;
