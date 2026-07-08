-- match finalize, impossible DPS attacker: an attacker whose total output
-- exceeds the physical ceiling (50 dps) is forfeited and banned; the honest
-- opponent wins even at 0hp, and the cheater's deposit stays in the pot for
-- the winner. Blatantly impossible rows are already rejected at write time.
begin;

do $$
declare
  r record;
  m public.matches%rowtype;
begin
  select * into r from tests.make_active_1v1('dps') t;

  -- Write-time hard ceiling: damage a single sword swing cannot do.
  perform tests.throws(
    format('select tests.deal_damage(%L::uuid, %L::uuid, %L::uuid, 1000, 1, 1000, 3000)',
           r.match_id, r.u2, r.u1),
    'cheat_detected:%', 'single-hit damage above the hard ceiling rejected at insert');

  -- Sneakier cheat: 1000 damage in a 2s window across 4 "hits" — passes the
  -- per-hit write check but is 500 dps, 10x the 50 dps settlement cap.
  perform tests.deal_damage(r.match_id, r.u2, r.u1, 1000, 4, 1000, 3000);
  -- Honest player lands 30 damage meanwhile.
  perform tests.deal_damage(r.match_id, r.u1, r.u2, 30, 15, 1000, 31000);

  perform tests.set_uid(r.u2);
  perform public.finish_match(r.match_id, 100);  -- cheater claims full HP
  perform tests.set_uid(r.u1);
  perform public.finish_match(r.match_id, 0);

  select * into m from public.matches where id = r.match_id;
  perform tests.is(m.status, 'finished', 'match settles despite the cheat');
  perform tests.is(m.winner_user_id, r.u1, 'honest player wins even at 0hp');
  perform tests.ok(m.forfeited_user_ids @> array[r.u2], 'cheater forfeited');
  perform tests.ok(not (m.forfeited_user_ids @> array[r.u1]), 'honest player not forfeited');
  perform tests.is(m.pot_tokens, 2 * tests.entry_fee(),
    'cheater''s deposit stays in the pot for the winner');

  -- Forfeit triggers an automatic ban...
  perform tests.ok(
    exists (select 1 from public.banned_users
            where user_id = r.u2 and reason = 'impossible_combat_output'),
    'cheater auto-banned by the forfeit trigger');
  perform tests.is(public.is_banned(r.u2), true, 'is_banned reports the ban');

  -- ...and a banned wallet can never buy another seat.
  perform tests.throws(
    format('select tests.join(%L::uuid, 2, %L, %L)', r.u2, 'sig_dps_retry', 'solana:W2_dps'),
    'banned:%', 'banned cheater cannot rejoin');

  -- Winner still gets stats; the cheater eats a loss.
  perform tests.is((select wins from public.profiles where user_id = r.u1), 1,
    'honest winner credited');
  perform tests.is((select losses from public.profiles where user_id = r.u2), 1,
    'cheater takes the loss');

  -- Everyone-flagged edge: two cheaters, no clean winner → disputed, pot frozen.
  select * into r from tests.make_active_1v1('dps2') t;
  perform tests.deal_damage(r.match_id, r.u2, r.u1, 1000, 4, 1000, 3000);
  perform tests.deal_damage(r.match_id, r.u1, r.u2, 1000, 4, 1000, 3000);
  perform tests.set_uid(r.u1);
  perform public.finish_match(r.match_id, 100);
  perform tests.set_uid(r.u2);
  perform public.finish_match(r.match_id, 100);

  select * into m from public.matches where id = r.match_id;
  perform tests.is(m.status, 'disputed', 'all-cheater match is disputed');
  perform tests.ok(m.winner_user_id is null, 'no winner among cheaters');
  perform tests.ok(m.forfeited_user_ids @> array[r.u1, r.u2], 'both cheaters forfeited');
  perform tests.set_uid(r.u1);
  perform tests.is(public.claim_payout_slot(r.match_id), false,
    'no payout slot on the disputed all-cheater match');
end;
$$;

rollback;
