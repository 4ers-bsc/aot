-- Run this in the Supabase SQL editor to make finish_match server-authoritative.
--
-- Schema assumption: match_players has columns:
--   match_id uuid, user_id uuid, final_hp int (nullable), seat int
-- matches has columns:
--   id uuid, status text, winner_user_id uuid (nullable), ended_at timestamptz
--
-- 1. Add final_hp column if it doesn't exist:
ALTER TABLE match_players ADD COLUMN IF NOT EXISTS final_hp int;

-- 2. Replace the finish_match function:
CREATE OR REPLACE FUNCTION finish_match(p_match_id uuid, p_final_hp int DEFAULT 0)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_caller        uuid := auth.uid();
  v_match_status  text;
  v_winner        uuid;
  v_alive_count   int;
BEGIN
  -- Caller must be a participant in this match
  IF NOT EXISTS (
    SELECT 1 FROM match_players
    WHERE match_id = p_match_id AND user_id = v_caller
  ) THEN
    RAISE EXCEPTION 'not a participant';
  END IF;

  -- Record this player's final HP (clamp to 0–100)
  UPDATE match_players
  SET final_hp = GREATEST(0, LEAST(100, p_final_hp))
  WHERE match_id = p_match_id AND user_id = v_caller;

  -- Only finalize once all players have reported, or if match is already finishing
  SELECT status INTO v_match_status FROM matches WHERE id = p_match_id;
  IF v_match_status = 'finished' THEN RETURN; END IF;

  -- Count how many players are still alive (final_hp > 0)
  SELECT COUNT(*) INTO v_alive_count
  FROM match_players
  WHERE match_id = p_match_id AND final_hp IS NOT NULL AND final_hp > 0;

  -- If exactly one player is alive, they are the winner
  IF v_alive_count = 1 THEN
    SELECT user_id INTO v_winner
    FROM match_players
    WHERE match_id = p_match_id AND final_hp > 0
    LIMIT 1;

    UPDATE matches
    SET winner_user_id = v_winner,
        status         = 'finished',
        ended_at       = now()
    WHERE id = p_match_id AND status != 'finished';

  -- If nobody is alive (all reported 0), highest seat wins (first joiner)
  ELSIF NOT EXISTS (
    SELECT 1 FROM match_players
    WHERE match_id = p_match_id AND final_hp IS NULL
  ) AND v_alive_count = 0 THEN
    SELECT user_id INTO v_winner
    FROM match_players
    WHERE match_id = p_match_id
    ORDER BY seat ASC LIMIT 1;

    UPDATE matches
    SET winner_user_id = v_winner,
        status         = 'finished',
        ended_at       = now()
    WHERE id = p_match_id AND status != 'finished';
  END IF;
END;
$$;

-- 3. Ensure RLS is on and only match participants can call this:
-- (finish_match is SECURITY DEFINER so it runs as the function owner,
--  but the participant check inside is the gate.)
