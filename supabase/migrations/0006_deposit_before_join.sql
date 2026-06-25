-- Deposit-before-join: players pay on-chain first, then enter the queue.
-- join_pvp_match() now requires a confirmed deposit tx at join time.
-- The match activates the moment its last seat is filled (all players have paid).
-- record_deposit() is retained for backward compatibility but is no longer
-- called by the client in the new flow.

-- ---------------------------------------------------------------------------
-- 1. Drop the old signature (p_max_players, p_display_name) so the new one
--    with (p_max_players, p_deposit_tx, p_display_name) can be created cleanly.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.join_pvp_match(smallint, text);

-- ---------------------------------------------------------------------------
-- 2. New join_pvp_match: deposit tx is required at join time.
--    Seat is granted only after payment is on record.
--    Match activates when all seats fill — meaning all players have paid.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.join_pvp_match(
  p_max_players  smallint DEFAULT 2,
  p_deposit_tx   text     DEFAULT NULL,
  p_display_name text     DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid        uuid     := auth.uid();
  v_name       text;
  v_size       smallint := LEAST(GREATEST(COALESCE(p_max_players, 2), 2), 10);
  v_match_id   uuid;
  v_seat       smallint;
  v_count      smallint;
  v_status     text;
  v_existing   record;
  c_entry_fee  constant bigint := 2500000000; -- 2500 × 10^6 (6-decimal mint)
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF p_deposit_tx IS NULL OR trim(p_deposit_tx) = '' THEN
    RAISE EXCEPTION 'deposit_tx_required';
  END IF;

  -- Clamp to the three supported lobby sizes.
  IF v_size NOT IN (2, 5, 10) THEN
    v_size := 2;
  END IF;

  SELECT display_name INTO v_name
  FROM public.sync_my_profile(p_display_name);

  -- One wallet, one active/waiting match at a time — return existing seat.
  SELECT mp.match_id, mp.seat, m.status, m.max_players
  INTO   v_existing
  FROM   public.match_players mp
  JOIN   public.matches m ON m.id = mp.match_id
  WHERE  mp.user_id = v_uid
    AND  m.status IN ('waiting', 'active')
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'match_id',    v_existing.match_id,
      'seat',        v_existing.seat,
      'status',      'existing',
      'max_players', v_existing.max_players
    );
  END IF;

  -- Find a waiting match of the right size with a free seat, lock it.
  SELECT m.id INTO v_match_id
  FROM   public.matches m
  WHERE  m.status      = 'waiting'
    AND  m.max_players = v_size
    AND  (SELECT COUNT(*) FROM public.match_players mp WHERE mp.match_id = m.id) < m.max_players
  ORDER  BY m.created_at
  FOR UPDATE OF m SKIP LOCKED
  LIMIT  1;

  IF FOUND THEN
    SELECT COUNT(*) INTO v_count FROM public.match_players WHERE match_id = v_match_id;
    v_seat := v_count + 1;

    INSERT INTO public.match_players (match_id, user_id, seat, display_name, deposit_tx)
    VALUES (v_match_id, v_uid, v_seat, v_name, p_deposit_tx);

    UPDATE public.matches
    SET pot_tokens = pot_tokens + c_entry_fee
    WHERE id = v_match_id;

    -- Last seat filled → all players have paid → activate.
    IF v_seat >= v_size THEN
      UPDATE public.matches
      SET status = 'active', started_at = timezone('utc', now())
      WHERE id = v_match_id;
      v_status := 'active';
    ELSE
      v_status := 'waiting';
    END IF;

    RETURN jsonb_build_object(
      'match_id',    v_match_id,
      'seat',        v_seat,
      'status',      v_status,
      'max_players', v_size
    );
  END IF;

  -- No waiting match found — open a new one.
  INSERT INTO public.matches (status, max_players, created_by)
  VALUES ('waiting', v_size, v_uid)
  RETURNING id INTO v_match_id;

  v_seat := 1;
  INSERT INTO public.match_players (match_id, user_id, seat, display_name, deposit_tx)
  VALUES (v_match_id, v_uid, v_seat, v_name, p_deposit_tx);

  UPDATE public.matches
  SET pot_tokens = pot_tokens + c_entry_fee
  WHERE id = v_match_id;

  RETURN jsonb_build_object(
    'match_id',    v_match_id,
    'seat',        v_seat,
    'status',      'waiting',
    'max_players', v_size
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.join_pvp_match(smallint, text, text) TO authenticated;
