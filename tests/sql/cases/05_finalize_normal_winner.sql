-- match finalize, normal winner: the winner comes from the damage LEDGER
-- (100 − validated damage others dealt you), not from self-reported HP.
-- Settlement is idempotent and stats apply exactly once.
begin;

do $$
declare
  r     record;
  m     public.matches%rowtype;
  pts_w int;
begin
  select * into r from tests.make_active_1v1('norm') t;

  -- u1 kills u2 (100 dmg over ~60s); u2 lands 30 on u1.
  perform tests.deal_damage(r.match_id, r.u1, r.u2, 100, 40);
  perform tests.deal_damage(r.match_id, r.u2, r.u1, 30, 15);

  -- First report alone does not settle: the opponent is still connected and
  -- unreported, and the deadline is far away.
  perform tests.set_uid(r.u2);
  perform public.finish_match(r.match_id, 0);
  perform tests.is(
    (select status from public.matches where id = r.match_id),
    'active', 'match stays active until the last connected player reports');

  -- Last report settles (ledger shows a lethal total against u2).
  perform tests.set_uid(r.u1);
  perform public.finish_match(r.match_id, 70);

  select * into m from public.matches where id = r.match_id;
  perform tests.is(m.status, 'finished', 'match settles when everyone reported');
  perform tests.is(m.winner_user_id, r.u1, 'ledger-derived winner (70hp vs 0hp)');
  perform tests.is(m.shadow_winner, r.u1, 'shadow winner agrees');
  perform tests.ok(m.ended_at is not null, 'ended_at stamped');
  perform tests.is(m.stats_applied, true, 'stats applied');
  perform tests.is(coalesce(array_length(m.forfeited_user_ids, 1), 0), 0, 'nobody forfeited');
  perform tests.is(m.pot_tokens, 2 * tests.entry_fee(), 'pot intact for payout');

  -- Stats: winner +1 win / 60 pts / streak 1; loser +1 loss / 10 pts.
  perform tests.is(
    (select (wins, losses, games_played, points, win_streak)::text
       from public.profiles where user_id = r.u1),
    '(1,0,1,60,1)', 'winner stats applied once');
  perform tests.is(
    (select (wins, losses, games_played, points, win_streak)::text
       from public.profiles where user_id = r.u2),
    '(0,1,1,10,0)', 'loser stats applied once');

  -- Settlement is idempotent: repeat calls change nothing.
  perform public.finalize_match(r.match_id);
  perform public.finalize_match(r.match_id, true);
  perform public.apply_match_result(r.match_id, r.u2);  -- guarded by stats_applied
  perform tests.is(
    (select winner_user_id from public.matches where id = r.match_id),
    r.u1, 'winner unchanged by repeat finalize');
  perform tests.is(
    (select points from public.profiles where user_id = r.u1),
    60, 'no double stats from repeat finalize');

  -- Late ledger writes are rejected once the match is settled.
  perform tests.throws(
    format('select tests.deal_damage(%L::uuid, %L::uuid, %L::uuid, 10, 5)',
           r.match_id, r.u2, r.u1),
    'stale:%', 'damage writes rejected after settlement');

  -- Self-reported HP cannot beat the ledger: u1 kills u2 (100 dmg) and takes
  -- 90 himself, then BOTH players report a full 100hp. The ledger decides:
  -- u1 survives on 10hp, u2 is dead.
  select * into r from tests.make_active_1v1('norm2') t;
  perform tests.deal_damage(r.match_id, r.u2, r.u1, 90, 40);
  perform tests.deal_damage(r.match_id, r.u1, r.u2, 100, 40);
  perform tests.set_uid(r.u2);
  perform public.finish_match(r.match_id, 100);
  perform tests.set_uid(r.u1);
  perform public.finish_match(r.match_id, 100);
  perform tests.is(
    (select winner_user_id from public.matches where id = r.match_id),
    r.u1, 'ledger overrides self-reported HP (10hp survivor beats 0hp)');
end;
$$;

rollback;
