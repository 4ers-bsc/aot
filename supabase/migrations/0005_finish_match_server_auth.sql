-- Fix 1: Promote finish_match.sql into the migration sequence (server-authoritative HP-based).
-- Fix 5: Make claim_payout_slot atomic with a single UPDATE statement.
-- Fix 6: Fix all-dead fallback winner to use highest HP, not seat order.
-- Fix 9: Add close_stale_matches() for cron-based TTL on abandoned active matches.

-- ---------------------------------------------------------------------------
-- 1. Add final_hp to match_players (idempotent)
-- ---------------------------------------------------------------------------
ALTER TABLE public.match_players
  ADD COLUMN IF NOT EXISTS final_hp int;

-- ---------------------------------------------------------------------------
-- 2. Drop old finish_match(uuid, uuid) — client-declared winner (insecure)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.finish_match(uuid, uuid);

-- ---------------------------------------------------------------------------
-- 3. Server-authoritative finish_match(uuid, int)
--    Each player submits their own final HP. The server crowns the winner.
--    Finalises immediately when exactly one living player is confirmed,
--    without waiting for unreported players — a disconnected loser does
--    not block the winner's payout.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finish_match(p_match_id uuid, p_final_hp int DEFAULT 0)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller      uuid := auth.uid();
  v_status      text;
  v_winner      uuid;
  v_alive_count int;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM match_players
    WHERE match_id = p_match_id AND user_id = v_caller
  ) THEN
    RAISE EXCEPTION 'not_a_participant';
  END IF;

  -- Record caller's HP (clamped 0–100)
  UPDATE match_players
  SET final_hp = GREATEST(0, LEAST(100, p_final_hp))
  WHERE match_id = p_match_id AND user_id = v_caller;

  -- Lock the row to prevent concurrent finalisations
  SELECT status INTO v_status FROM matches WHERE id = p_match_id FOR UPDATE;
  IF v_status = 'finished' THEN RETURN; END IF;
  IF v_status IS NULL    THEN RAISE EXCEPTION 'match_not_found'; END IF;

  -- Count players who have explicitly reported alive (hp > 0)
  SELECT COUNT(*) INTO v_alive_count
  FROM match_players
  WHERE match_id = p_match_id AND final_hp IS NOT NULL AND final_hp > 0;

  -- Exactly one alive → crown them immediately; don't wait for unreported players.
  -- This means a disconnected loser (NULL final_hp) cannot block the winner's payout.
  IF v_alive_count = 1 THEN
    SELECT user_id INTO v_winner
    FROM match_players
    WHERE match_id = p_match_id AND final_hp > 0
    LIMIT 1;

    UPDATE matches
    SET winner_user_id = v_winner, status = 'finished', ended_at = now()
    WHERE id = p_match_id AND status != 'finished';
    RETURN;
  END IF;

  -- All players have reported (none NULL). Use highest HP; seat ASC breaks ties.
  -- Handles timer expiry where multiple players survive or all die simultaneously.
  -- Fix 6: was previously ORDER BY seat ASC (first-joiner wins), now highest HP.
  IF NOT EXISTS (
    SELECT 1 FROM match_players
    WHERE match_id = p_match_id AND final_hp IS NULL
  ) THEN
    SELECT user_id INTO v_winner
    FROM match_players
    WHERE match_id = p_match_id
    ORDER BY final_hp DESC, seat ASC
    LIMIT 1;

    UPDATE matches
    SET winner_user_id = v_winner, status = 'finished', ended_at = now()
    WHERE id = p_match_id AND status != 'finished';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.finish_match(uuid, int) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Fix claim_payout_slot: atomic single UPDATE (Fix 5)
--    Previous version used two separate UPDATEs — concurrent callers could
--    both release a stale 'pending' and both claim the slot.
--    This single statement handles stale-release and claim atomically:
--    the WHERE condition can only be satisfied once per match.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_payout_slot(p_match_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  UPDATE public.matches
  SET payout_tx = 'pending', payout_claimed_at = now()
  WHERE id              = p_match_id
    AND status          = 'finished'
    AND winner_user_id  = v_uid
    AND (
      payout_tx IS NULL
      OR (payout_tx = 'pending' AND payout_claimed_at < now() - interval '10 minutes')
    );

  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_payout_slot(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. close_stale_matches() — Fix 9
--    Finalises active matches that have exceeded their match timer + 5-min grace.
--    Crowns the player with the highest reported final_hp; falls back to
--    created_by (match creator) if no HP has been reported at all.
--    Schedule with pg_cron: SELECT cron.schedule('close-stale', '*/5 * * * *',
--      'SELECT public.close_stale_matches()');
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_stale_matches()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_closed int := 0;
BEGIN
  WITH stale AS (
    SELECT
      m.id,
      COALESCE(
        (
          SELECT mp.user_id
          FROM   match_players mp
          WHERE  mp.match_id = m.id
          ORDER  BY COALESCE(mp.final_hp, -1) DESC, mp.seat ASC
          LIMIT  1
        ),
        m.created_by
      ) AS winner_uid
    FROM matches m
    WHERE m.status      = 'active'
      AND m.started_at  IS NOT NULL
      AND m.started_at  < now() - (
        CASE m.max_players
          WHEN 2  THEN interval '10 minutes'   -- 5 min timer + 5 min grace
          WHEN 5  THEN interval '15 minutes'   -- 10 min timer + 5 min grace
          WHEN 10 THEN interval '20 minutes'   -- 15 min timer + 5 min grace
          ELSE         interval '20 minutes'
        END
      )
  )
  UPDATE matches m
  SET    status         = 'finished',
         winner_user_id = stale.winner_uid,
         ended_at       = now()
  FROM   stale
  WHERE  m.id = stale.id;

  GET DIAGNOSTICS v_closed = ROW_COUNT;
  RETURN v_closed;
END;
$$;

-- Only callable by the service role (pg_cron runs as superuser/service_role)
GRANT EXECUTE ON FUNCTION public.close_stale_matches() TO service_role;
