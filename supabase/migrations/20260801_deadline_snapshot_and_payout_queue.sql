-- 20260801  Deadline-to-snapshot + payout status column & durable payout queue
-- ---------------------------------------------------------------------------
-- Two audit follow-ups from the payout/economics hardening review:
--
--  A. Settlement deadline reads the SNAPSHOT. #4 froze entry_fee/winner_share/
--     duration onto each match, but the settlement + anti-cheat window still
--     read match_duration_seconds() live, so an admin editing match_config
--     mid-match moved an in-flight match's deadline. finalize_match,
--     close_stale_matches, and the two combat-ledger write guards now use
--     coalesce(matches.duration_seconds, match_duration_seconds(max_players)),
--     falling back to live config only for pre-snapshot matches.
--
--  B. Explicit payout lifecycle + durable job queue. matches.payout_state is
--     derived from payout_tx by trigger (the edge-function write path is not
--     touched); payout_jobs is a durable work-list of finished matches that owe
--     a prize, so a payout no longer depends on the winner clicking "claim".
--     The reconciler (f10treasurer?reconcile=1) drains it and is OFF until a
--     RECONCILE_SECRET is set — see the function for enable steps.
--
-- Idempotent: re-running is safe (create-or-replace / if-not-exists / guarded
-- backfills).
-- ===========================================================================

-- ===========================================================================
-- Part A — settlement & anti-cheat deadline now prefer the per-match snapshot
-- ===========================================================================

create or replace function public.finalize_match(p_match_id uuid, p_force boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status     text;
  v_maxp       smallint;
  v_snap_dur   int;
  v_started    timestamptz;
  v_deadline   timestamptz;
  v_ended      timestamptz;
  v_secs       numeric;
  v_unreported int;
  v_live_n     int;
  v_dmg_total  bigint;
  v_winner     uuid;
  v_forfeited  uuid[];
  v_mismatch   uuid[];
  v_live       uuid[];
  v_disputed   boolean := false;
  v_meta       jsonb;
  -- Physical ceilings (buffer over real stats: sword ~40 dps, ~1.4 hits/s).
  c_max_dps      constant numeric := 50;   -- per attacker, total across all victims
  c_max_firerate constant numeric := 4;    -- hits per second, per attacker→victim pair
  -- A player is "disconnected" once its heartbeat lapses past this window.
  c_dc_grace     constant interval := interval '15 seconds';
  -- Self-report corroboration margin. Honest reports track the ledger closely
  -- (each client applies damage from the same attack events the attacker
  -- records); the slack absorbs grenade-splash variance and a dropped packet
  -- or two, while a fabricated lethal total overshoots it by design.
  c_hp_tolerance constant int := 25;
begin
  select status, started_at, max_players, duration_seconds
    into v_status, v_started, v_maxp, v_snap_dur
  from matches where id = p_match_id for update;
  if v_status is null                     then raise exception 'match_not_found'; end if;
  if v_status in ('finished', 'disputed') then return; end if;

  -- Hard cap from match_config (per lobby size). Before it, hold open until
  -- everyone reports; after it (or on force), settle from the ledger now.
  -- Pin the settlement window to the length SNAPSHOTTED onto the match at
  -- creation (join_pvp_match), falling back to live match_config only for
  -- pre-snapshot matches. An admin editing match_config mid-match can no longer
  -- move an in-flight match's deadline (audit follow-up to the economics snapshot).
  v_deadline := coalesce(v_started, now())
              + make_interval(secs => coalesce(v_snap_dur, public.match_duration_seconds(v_maxp)));

  -- Only WAIT on players who are still connected and haven't reported.
  -- Disconnected (stale heartbeat) players never block settlement — and neither
  -- does a NON-PARTICIPANT: a seat that has recorded no offense of its own yet
  -- has already absorbed a lethal total (>=100) was never in the fight. That is
  -- an away / never-loaded player being farmed. last_seen defaults to now() at
  -- join, so for the first 15s such a seat still looks "connected" even though
  -- its client never entered the match; waiting on it holds the decided match
  -- open just long enough for that player to reconnect, land a retaliatory kill
  -- on the winner, and turn a clean win into a corroboration 'disputed' (frozen
  -- pot). Excluding it settles the win immediately, before the corpse can
  -- reanimate. A cheater's victim who was actually fighting has recorded offense
  -- of its own, so this never lets a fabricated-lethal total early-settle a
  -- match and skip the self-report corroboration guard below.
  select count(*) filter (
    where mp.final_hp is null
      and mp.last_seen >= now() - c_dc_grace
      and not (
        coalesce(taken.dmg_in, 0) >= 100
        and not exists (
          select 1 from match_damage o
          where o.match_id = p_match_id and o.attacker = mp.user_id
        )
      )
  )
    into v_unreported
  from match_players mp
  left join (
    select victim, sum(total_damage) as dmg_in
    from match_damage where match_id = p_match_id
    group by victim
  ) taken on taken.victim = mp.user_id
  where mp.match_id = p_match_id;

  if not p_force and v_unreported > 0 and now() < v_deadline then
    return;
  end if;

  -- Early-report guard: before the deadline, everyone reporting is not by
  -- itself proof the match is over — a spoofed "match-over" broadcast can
  -- push every honest client to report seconds in. Only settle early when
  -- the ledger shows a lethal total against someone, or at most one player
  -- is still connected (walkover). Otherwise hold the match open; the
  -- deadline path settles it as usual.
  if not p_force and now() < v_deadline then
    select count(*) into v_live_n
    from match_players
    where match_id = p_match_id
      and not (final_hp is null and last_seen < now() - c_dc_grace);

    if v_live_n > 1 and not exists (
      select 1 from match_damage
      where match_id = p_match_id
      group by victim
      having sum(total_damage) >= 100
    ) then
      return;
    end if;
  end if;

  v_ended := now();
  v_secs  := greatest(5, extract(epoch from (v_ended - coalesce(v_started, v_ended))));

  select coalesce(sum(total_damage), 0) into v_dmg_total
  from match_damage where match_id = p_match_id;

  if v_dmg_total = 0 then
    -- No combat recorded. If everyone but one player has disconnected, that
    -- player wins by walkover (last one standing). Otherwise it's a genuine
    -- no-contest (e.g. nobody fought before the timer) → disputed.
    select coalesce(array_agg(user_id), '{}') into v_live
    from match_players
    where match_id = p_match_id
      and not (final_hp is null and last_seen < now() - c_dc_grace);

    if array_length(v_live, 1) = 1 then
      update matches
        set status = 'finished', winner_user_id = v_live[1], ended_at = v_ended,
            shadow_winner = v_live[1], forfeited_user_ids = '{}',
            shadow_meta = jsonb_build_object('reason', 'walkover', 'secs', v_secs)
        where id = p_match_id and status not in ('finished', 'disputed');
      if found then
        perform public.apply_match_result(p_match_id, v_live[1]);
      end if;
    else
      update matches
        set status = 'disputed', winner_user_id = NULL, ended_at = v_ended,
            shadow_winner = NULL,
            shadow_meta = jsonb_build_object('reason', 'no_combat', 'secs', v_secs)
        where id = p_match_id and status not in ('finished', 'disputed');
    end if;
    return;
  end if;

  with raw as (
    -- win_secs = how long this attacker→victim damage actually spanned, so the
    -- cap is a RATE. A match may run 5 min, but damage dealt in a 2s burst is
    -- still capped at 2s worth — this is what catches a burst insta-kill.
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
    -- The match_id filter here is essential: without it every player in every
    -- match is ranked, and a concurrent match's player could be crowned winner
    -- of THIS match (winner_user_id is who the treasurer pays).
    select mp.user_id, mp.seat, mp.final_hp, mp.last_seen,
           greatest(0, 100 - coalesce(sum(v.dmg), 0))::int as hp
    from match_players mp
    left join valid v on v.victim = mp.user_id
    where mp.match_id = p_match_id
    group by mp.user_id, mp.seat, mp.final_hp, mp.last_seen
  ),
  ranked as (
    select h.user_id, h.hp, h.seat, h.final_hp,
           (f.attacker is not null) as is_flagged,
           -- Disconnected AND never reported → eliminated (a player who reported
           -- before leaving keeps their standing).
           (h.final_hp is null and h.last_seen < now() - c_dc_grace) as is_dc,
           row_number() over (
             -- Clean, connected players rank first; among them, highest HP then seat.
             order by (f.attacker is not null
                       or (h.final_hp is null and h.last_seen < now() - c_dc_grace)) asc,
                      h.hp desc, h.seat asc
           ) as rn
    from hp h
    left join flagged f on f.attacker = h.user_id
  )
  select
    (select user_id from ranked where rn = 1 and not is_flagged and not is_dc),
    (select coalesce(array_agg(user_id), '{}') from ranked where is_flagged),
    -- Corroboration: clean, connected players whose SELF-reported HP sits far
    -- above their ledger-derived HP — the damage the ledger says killed them
    -- was never actually received on their client.
    (select coalesce(array_agg(user_id), '{}') from ranked
      where not is_flagged and not is_dc
        and final_hp is not null
        and final_hp > hp + c_hp_tolerance),
    jsonb_build_object(
      'secs',  v_secs,
      'caps',  jsonb_build_object('dps', c_max_dps, 'firerate', c_max_firerate),
      'hp',    (select jsonb_agg(jsonb_build_object('user_id', user_id, 'hp', hp, 'seat', seat, 'flagged', is_flagged, 'dc', is_dc)
                                 order by hp desc, seat asc) from ranked),
      'flagged',      (select coalesce(jsonb_agg(attacker), '[]'::jsonb) from flagged),
      'disconnected', (select coalesce(jsonb_agg(user_id), '[]'::jsonb) from ranked where is_dc),
      'attacker_out', (select jsonb_object_agg(attacker::text, out_total) from attacker_totals)
    )
    into v_winner, v_forfeited, v_mismatch, v_meta;

  -- Disputed if no clean player can win (e.g. everyone flagged)…
  if v_winner is null then v_disputed := true; end if;

  -- …or if a LOSER's self-report contradicts the ledger damage against them:
  -- the winner's margin may rest on fabricated offense that stayed under the
  -- rate caps, so no automatic payout — hold for admin review. The winner is
  -- excluded: fabricated damage against them could only have hurt them.
  v_mismatch := array_remove(coalesce(v_mismatch, '{}'), v_winner);
  if coalesce(array_length(v_mismatch, 1), 0) > 0 then
    v_disputed := true;
    v_meta := v_meta || jsonb_build_object(
      'reason',   'ledger_mismatch',
      'mismatch', to_jsonb(v_mismatch),
      'hp_tolerance', c_hp_tolerance
    );
  end if;

  if v_disputed then
    update matches
      set status = 'disputed', winner_user_id = NULL, ended_at = v_ended,
          shadow_winner = NULL, shadow_meta = v_meta, forfeited_user_ids = v_forfeited
      where id = p_match_id and status not in ('finished', 'disputed');
  else
    update matches
      set status = 'finished', winner_user_id = v_winner, ended_at = v_ended,
          shadow_winner = v_winner, shadow_meta = v_meta, forfeited_user_ids = v_forfeited
      where id = p_match_id and status not in ('finished', 'disputed');
    if found then
      perform public.apply_match_result(p_match_id, v_winner);
    end if;
  end if;
end;
$$;

create or replace function public.validate_match_damage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_dur_ms bigint;
  -- Generous single-hit ceiling; fine-grained DPS/fire-rate caps live in
  -- finalize_match. This only rejects blatantly impossible rows at write time.
  c_hard_per_hit constant int := 250;
begin
  select m.status, coalesce(m.duration_seconds, public.match_duration_seconds(m.max_players)) * 1000
    into v_status, v_dur_ms
  from public.matches m where m.id = new.match_id;

  if v_status is null      then raise exception 'stale: match_not_found';  end if;
  if v_status <> 'active'   then raise exception 'stale: match_not_active'; end if;
  if not exists (select 1 from public.match_players
                 where match_id = new.match_id and user_id = new.attacker) then
    raise exception 'cheat_detected: attacker_not_in_match';
  end if;
  if not exists (select 1 from public.match_players
                 where match_id = new.match_id and user_id = new.victim) then
    raise exception 'cheat_detected: victim_not_in_match';
  end if;
  if new.first_t_ms < 0
     or new.last_t_ms < new.first_t_ms
     or new.last_t_ms > v_dur_ms + 30000 then
    raise exception 'cheat_detected: bad_timestamps';
  end if;
  if new.total_damage > 0 and new.hit_count < 1 then
    raise exception 'cheat_detected: damage_without_hits';
  end if;
  if new.total_damage > new.hit_count * c_hard_per_hit then
    raise exception 'cheat_detected: damage_exceeds_hit_ceiling';
  end if;
  return new;
end;
$$;

create or replace function public.validate_match_kills()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_dur_ms bigint;
begin
  select m.status, coalesce(m.duration_seconds, public.match_duration_seconds(m.max_players)) * 1000
    into v_status, v_dur_ms
  from public.matches m where m.id = new.match_id;

  if v_status is null      then raise exception 'stale: match_not_found';  end if;
  if v_status <> 'active'   then raise exception 'stale: match_not_active'; end if;
  if not exists (select 1 from public.match_players
                 where match_id = new.match_id and user_id = new.attacker) then
    raise exception 'cheat_detected: attacker_not_in_match';
  end if;
  if not exists (select 1 from public.match_players
                 where match_id = new.match_id and user_id = new.victim) then
    raise exception 'cheat_detected: victim_not_in_match';
  end if;
  if new.t_ms < 0 or new.t_ms > v_dur_ms + 30000 then
    raise exception 'cheat_detected: bad_timestamp';
  end if;
  return new;
end;
$$;

create or replace function public.close_stale_matches()
returns int language plpgsql security definer set search_path = public as $$
declare v_closed int := 0; r record;
begin
  for r in
    select m.id from matches m
    where m.status = 'active' and m.started_at is not null
      and m.started_at < now() - make_interval(secs => coalesce(m.duration_seconds, public.match_duration_seconds(m.max_players)))
    for update of m skip locked
  loop
    perform public.finalize_match(r.id, true);
    v_closed := v_closed + 1;
  end loop;
  for r in
    select m.id from matches m
    where m.status = 'waiting' and m.created_at < now() - interval '15 minutes'
    for update of m skip locked
  loop
    if public.settle_abandoned_lobby(r.id) then v_closed := v_closed + 1; end if;
  end loop;
  return v_closed;
end;
$$;

-- ===========================================================================
-- Payout lifecycle: explicit status column + durable job queue + reconciler
-- support (audit follow-ups from the payout hardening review).
--
-- Design goal: ADDITIVE and backward-compatible. matches.payout_tx stays the
-- on-chain source of truth. payout_state is DERIVED from it by trigger (so the
-- already-tested edge-function write path is not touched), and payout_jobs is a
-- durable work-list of finished matches that still owe a prize — so a payout no
-- longer depends on the winner returning to click "claim".
-- ===========================================================================

-- --- Explicit payout lifecycle, derived from payout_tx so it can never drift --
-- unpaid    → no payout recorded yet
-- claimed   → a reservation is held (payout_tx = 'pending')
-- broadcast → a real signed signature is on record (payout_tx = <sig>)
-- confirmed → a payouts ledger row exists (settled from the app's view)
alter table public.matches
  add column if not exists payout_state text not null default 'unpaid'
    check (payout_state in ('unpaid','claimed','broadcast','confirmed'));

create or replace function public.derive_payout_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.payout_tx is null then
    new.payout_state := 'unpaid';
  elsif new.payout_tx = 'pending' then
    new.payout_state := 'claimed';
  else
    -- Keep 'confirmed' sticky once a payouts row has promoted it; otherwise a
    -- real signature is broadcast-but-not-yet-ledgered.
    if tg_op = 'UPDATE' and old.payout_state = 'confirmed'
       and old.payout_tx = new.payout_tx then
      new.payout_state := 'confirmed';
    else
      new.payout_state := 'broadcast';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_matches_derive_payout_state on public.matches;
create trigger trg_matches_derive_payout_state
  before insert or update of payout_tx on public.matches
  for each row execute function public.derive_payout_state();

-- Backfill existing rows (updates payout_state only, so the derive trigger above
-- — which fires on payout_tx — does not run and cannot fight this).
update public.matches m set payout_state =
  case
    when m.payout_tx is null      then 'unpaid'
    when m.payout_tx = 'pending'  then 'claimed'
    when exists (select 1 from public.payouts p where p.match_id = m.id) then 'confirmed'
    else 'broadcast'
  end
where m.payout_state is distinct from
  case
    when m.payout_tx is null      then 'unpaid'
    when m.payout_tx = 'pending'  then 'claimed'
    when exists (select 1 from public.payouts p where p.match_id = m.id) then 'confirmed'
    else 'broadcast'
  end;

-- --- Durable payout job queue ------------------------------------------------
-- One row per finished match that owes a prize. Enqueued when a match finishes
-- with a winner; drained by the reconciler (f10treasurer?reconcile=1) or closed
-- automatically when a payouts ledger row lands (winner-initiated flow).
create table if not exists public.payout_jobs (
  match_id        uuid primary key references public.matches(id) on delete cascade,
  state           text not null default 'queued'
                    check (state in ('queued','running','done','failed')),
  attempts        int  not null default 0,
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists payout_jobs_due_idx
  on public.payout_jobs (next_attempt_at)
  where state in ('queued','running');
alter table public.payout_jobs enable row level security;
-- RLS on with no policies → only service_role (which bypasses RLS) may read/write.

-- Enqueue a job whenever a match reaches finished+winner and isn't already paid.
create or replace function public.enqueue_payout_job()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'finished'
     and new.winner_user_id is not null
     and coalesce(new.payout_state, 'unpaid') <> 'confirmed' then
    insert into public.payout_jobs (match_id) values (new.id)
    on conflict (match_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_matches_enqueue_payout on public.matches;
create trigger trg_matches_enqueue_payout
  after insert or update of status, winner_user_id on public.matches
  for each row execute function public.enqueue_payout_job();

-- When a payout ledger row lands, mark the match confirmed and close its job.
create or replace function public.payout_recorded()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.matches
    set payout_state = 'confirmed'
    where id = new.match_id and payout_state <> 'confirmed';
  update public.payout_jobs
    set state = 'done', last_error = null, updated_at = now()
    where match_id = new.match_id and state <> 'done';
  return new;
end;
$$;

drop trigger if exists trg_payouts_recorded on public.payouts;
create trigger trg_payouts_recorded
  after insert or update on public.payouts
  for each row execute function public.payout_recorded();

-- Backfill: enqueue any already-finished, still-unpaid match so the queue is
-- authoritative from the first deploy.
insert into public.payout_jobs (match_id)
select m.id from public.matches m
where m.status = 'finished'
  and m.winner_user_id is not null
  and m.payout_state <> 'confirmed'
on conflict (match_id) do nothing;

-- --- Reconciler support RPCs (service_role only) -----------------------------

-- Atomically claim up to p_limit DUE jobs, marking them 'running'. FOR UPDATE
-- SKIP LOCKED so parallel workers never grab the same job. A 'running' row whose
-- worker crashed is reclaimed once it goes stale (self-healing).
create or replace function public.claim_payout_jobs(p_limit int default 5, p_stale_seconds int default 300)
returns setof public.payout_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with due as (
    select j.match_id
    from public.payout_jobs j
    where j.next_attempt_at <= now()
      and (
        j.state = 'queued'
        or (j.state = 'running' and j.updated_at < now() - make_interval(secs => greatest(30, p_stale_seconds)))
      )
    order by j.next_attempt_at
    limit greatest(1, p_limit)
    for update skip locked
  )
  update public.payout_jobs j
    set state = 'running', attempts = j.attempts + 1, updated_at = now()
    from due
    where j.match_id = due.match_id
    returning j.*;
end;
$$;

-- Record a job outcome. ok=true → done. ok=false → back to 'queued' with capped
-- exponential backoff, or 'failed' after too many attempts (needs a human).
create or replace function public.complete_payout_job(p_match_id uuid, p_ok boolean, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_ok then
    update public.payout_jobs
      set state = 'done', last_error = null, updated_at = now()
      where match_id = p_match_id;
  else
    -- Only requeue a job that is still 'running'. If a concurrent winner-initiated
    -- payment already wrote the payouts row (trigger → job 'done'), a late failure
    -- outcome from the reconciler must NOT resurrect it back to 'queued'.
    update public.payout_jobs j
      set state = case when j.attempts >= 8 then 'failed' else 'queued' end,
          last_error = left(coalesce(p_error, ''), 500),
          next_attempt_at = now() + make_interval(secs => least(3600, (power(2, least(j.attempts, 10))::int) * 15)),
          updated_at = now()
      where j.match_id = p_match_id and j.state = 'running';
  end if;
end;
$$;

-- Service-role payout-slot claim for the reconciler, which has no winner JWT
-- (claim_payout_slot keys on auth.uid()). Same atomic single-UPDATE + stale
-- 'pending' reclaim, but the winner is read from the match row.
create or replace function public.claim_payout_slot_service(p_match_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.matches
  set payout_tx = 'pending', payout_claimed_at = now()
  where id = p_match_id
    and status = 'finished'
    and winner_user_id is not null
    and (
      payout_tx is null
      or (payout_tx = 'pending' and payout_claimed_at < now() - interval '10 minutes')
    );
  return found;
end;
$$;

-- Read-only queue summary for the ops dashboard.
create or replace function public.payout_queue_stats()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'queued',     count(*) filter (where state = 'queued'),
    'running',    count(*) filter (where state = 'running'),
    'failed',     count(*) filter (where state = 'failed'),
    'due',        count(*) filter (where state in ('queued','running') and next_attempt_at <= now()),
    'total_open', count(*) filter (where state in ('queued','running','failed'))
  )
  from public.payout_jobs;
$$;

revoke all on function public.claim_payout_jobs(int, int)          from public, anon, authenticated;
revoke all on function public.complete_payout_job(uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.claim_payout_slot_service(uuid)      from public, anon, authenticated;
revoke all on function public.payout_queue_stats()                 from public, anon, authenticated;
grant execute on function public.claim_payout_jobs(int, int)          to service_role;
grant execute on function public.complete_payout_job(uuid, boolean, text) to service_role;
grant execute on function public.claim_payout_slot_service(uuid)      to service_role;
grant execute on function public.payout_queue_stats()                 to service_role;
