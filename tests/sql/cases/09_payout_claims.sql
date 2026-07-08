-- payout claims: claim_payout_slot is the gate in front of the treasurer's
-- on-chain transfer. Only the winner of a finished match can reserve it,
-- exactly one reservation can exist, a completed payout can never be paid
-- again, and a stale reservation (crashed treasurer) is recoverable.
begin;

do $$
declare
  r  record;
  m  public.matches%rowtype;
  t0 timestamptz;
begin
  -- Build a finished match with a real winner through the normal flow.
  select * into r from tests.make_active_1v1('pay') t;
  perform tests.deal_damage(r.match_id, r.u1, r.u2, 100, 40);
  perform tests.set_uid(r.u2);
  perform public.finish_match(r.match_id, 0);
  perform tests.set_uid(r.u1);
  perform public.finish_match(r.match_id, 100);
  perform tests.is((select status from public.matches where id = r.match_id),
    'finished', 'fixture match finished with u1 as winner');

  -- payout non-winner rejected: the loser cannot reserve the slot...
  perform tests.set_uid(r.u2);
  perform tests.is(public.claim_payout_slot(r.match_id), false,
    'non-winner cannot claim the payout');
  -- ...and an unauthenticated caller cannot either.
  perform tests.set_uid(null);
  perform tests.is(public.claim_payout_slot(r.match_id), false,
    'unauthenticated claim rejected');
  perform tests.ok(
    (select payout_tx from public.matches where id = r.match_id) is null,
    'rejected claims leave the slot untouched');

  -- payout winner: the winner reserves the slot.
  perform tests.set_uid(r.u1);
  perform tests.is(public.claim_payout_slot(r.match_id), true,
    'winner reserves the payout slot');
  select * into m from public.matches where id = r.match_id;
  perform tests.is(m.payout_tx, 'pending', 'slot marked pending');
  perform tests.ok(m.payout_claimed_at > now() - interval '1 minute',
    'reservation timestamped');

  -- double payout rejected (concurrent retry): while the reservation is
  -- fresh, nobody — not even the winner — can claim again.
  perform tests.is(public.claim_payout_slot(r.match_id), false,
    'winner cannot double-reserve a fresh slot');
  perform tests.set_uid(r.u2);
  perform tests.is(public.claim_payout_slot(r.match_id), false,
    'loser still rejected while pending');

  -- stale payout reservation recovery: the treasurer crashed before sending —
  -- after 10 minutes the winner's retry takes the slot over.
  update public.matches
  set payout_claimed_at = now() - interval '11 minutes'
  where id = r.match_id;
  t0 := (select payout_claimed_at from public.matches where id = r.match_id);
  perform tests.set_uid(r.u1);
  perform tests.is(public.claim_payout_slot(r.match_id), true,
    'stale pending reservation is recoverable by the winner');
  perform tests.ok(
    (select payout_claimed_at from public.matches where id = r.match_id) > t0,
    'recovered reservation re-timestamped');
  perform tests.set_uid(r.u2);
  update public.matches
  set payout_claimed_at = now() - interval '11 minutes'
  where id = r.match_id;
  perform tests.is(public.claim_payout_slot(r.match_id), false,
    'stale reservation is NOT claimable by a non-winner');

  -- treasurer failure path: tx never confirmed → slot released exactly as the
  -- edge function does it (guarded on payout_tx = 'pending'), winner retries.
  update public.matches
  set payout_tx = null, payout_claimed_at = null
  where id = r.match_id and payout_tx = 'pending';
  perform tests.set_uid(r.u1);
  perform tests.is(public.claim_payout_slot(r.match_id), true,
    'released slot claimable again by the winner');

  -- double payout rejected (completed): once a real signature is recorded the
  -- slot is closed forever — for everyone, stale timestamps included.
  update public.matches
  set payout_tx = 'sig_payout_done', payout_claimed_at = now() - interval '2 days'
  where id = r.match_id;
  perform tests.is(public.claim_payout_slot(r.match_id), false,
    'paid-out match can never be claimed again');
  perform tests.is(
    (select payout_tx from public.matches where id = r.match_id),
    'sig_payout_done', 'recorded payout signature is never overwritten');

  -- Slot only exists on FINISHED matches: an active match cannot be claimed
  -- even by a would-be winner.
  select * into r from tests.make_active_1v1('pay2') t;
  update public.matches set winner_user_id = r.u1 where id = r.match_id;
  perform tests.set_uid(r.u1);
  perform tests.is(public.claim_payout_slot(r.match_id), false,
    'active match has no claimable payout');
end;
$$;

rollback;
