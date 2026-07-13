-- ============================================================================
-- Security / reliability hardening — addresses several audit findings in one
-- upgrade migration. Idempotent (create or replace / drop-create), safe to run
-- on an already-provisioned database. The from-scratch equivalents live in
-- supabase/fresh_setup.sql and are kept behaviourally in sync — edit both
-- together.
--
--   1. finish_match — reject reports for matches that are not ACTIVE + started.
--      A 'waiting' player could previously lock in a final HP before combat
--      began; now only an in-progress match accepts the authoritative report.
--
--   2. admin_resolve_dispute — award a disputed match to a participant AND
--      apply their stats inside ONE transaction. The edge function previously
--      did the status flip and apply_match_result() as two separate writes, so
--      a failure between them left the match 'finished' with no stats applied.
--
--   3. RLS — matches / match_players are no longer world-readable for every
--      active/waiting match. A row is visible only to its participants. Lobby
--      "N waiting" badges now come from the SECURITY DEFINER aggregate RPC
--      pvp_waiting_counts(), which exposes counts only, never rows.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. finish_match — require an ACTIVE, started match.
-- ---------------------------------------------------------------------------
create or replace function public.finish_match(p_match_id uuid, p_final_hp int default 0)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller  uuid := auth.uid();
  v_status  text;
  v_started timestamptz;
begin
  if v_caller is null then
    raise exception 'not_authenticated';
  end if;

  perform public.enforce_rate_limit('finish_match', 30, interval '1 minute');

  if not exists (
    select 1 from match_players
    where match_id = p_match_id and user_id = v_caller
  ) then
    raise exception 'not_a_participant';
  end if;

  -- Only an in-progress match can receive a final HP report. A 'waiting' match
  -- (not yet started) or an already-settled one is rejected so a player cannot
  -- lock in a final HP before combat has begun (or overwrite one afterwards).
  select status, started_at into v_status, v_started
  from matches where id = p_match_id for update;
  if v_status is null then
    raise exception 'match_not_found';
  end if;
  if v_status <> 'active' or v_started is null then
    raise exception 'match_not_active';
  end if;

  update match_players
  set final_hp = greatest(0, least(100, p_final_hp))
  where match_id = p_match_id and user_id = v_caller;

  perform public.finalize_match(p_match_id);
end;
$$;

grant execute on function public.finish_match(uuid, int) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. admin_resolve_dispute — atomic dispute resolution.
--    Flip 'disputed' -> 'finished' with a chosen winner and apply their stats
--    in a single transaction. Called by the f10admin edge function so the two
--    writes can never land half-applied.
-- ---------------------------------------------------------------------------
create or replace function public.admin_resolve_dispute(p_match_id uuid, p_winner_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status from matches where id = p_match_id for update;
  if v_status is null then
    raise exception 'match_not_found';
  end if;
  if v_status <> 'disputed' then
    raise exception 'not_disputed:%', v_status;
  end if;
  if not exists (
    select 1 from match_players where match_id = p_match_id and user_id = p_winner_id
  ) then
    raise exception 'winner_not_participant';
  end if;

  update matches
  set status = 'finished', winner_user_id = p_winner_id,
      shadow_winner = p_winner_id, ended_at = now()
  where id = p_match_id and status = 'disputed';

  -- Runs in the same transaction; if it raises, the status flip rolls back too.
  perform public.apply_match_result(p_match_id, p_winner_id);
end;
$$;

grant execute on function public.admin_resolve_dispute(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3. pvp_waiting_counts — lobby "N waiting" badges without exposing rows.
--    Returns seat counts per lobby size for matches still in 'waiting'. Runs as
--    SECURITY DEFINER so the matches / match_players SELECT policies can be
--    tightened to participants only (below) while the lobby UI keeps working.
-- ---------------------------------------------------------------------------
create or replace function public.pvp_waiting_counts()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    jsonb_object_agg(sz::text, cnt),
    '{}'::jsonb
  )
  from (
    select m.max_players as sz, count(mp.user_id) as cnt
    from public.matches m
    join public.match_players mp on mp.match_id = m.id
    where m.status = 'waiting'
    group by m.max_players
  ) s;
$$;

grant execute on function public.pvp_waiting_counts() to authenticated, anon;

-- ---------------------------------------------------------------------------
-- 3b. Tighten SELECT policies to participants only. A logged-in user can no
--     longer enumerate every active/waiting match and its roster; they see only
--     matches they are actually in. Server-side helpers (join_pvp_match,
--     finalize_match, pvp_waiting_counts, pvp_capacity) remain SECURITY DEFINER
--     and are unaffected.
-- ---------------------------------------------------------------------------
drop policy if exists "matches_select_member_or_active" on public.matches;
create policy "matches_select_member"
on public.matches for select to authenticated
using (public.is_match_member(id));

drop policy if exists "match_players_select_member_or_active" on public.match_players;
create policy "match_players_select_member"
on public.match_players for select to authenticated
using (public.is_match_member(match_id));
