-- 0006_rooms.sql
-- Pre-seeded fixed rooms (40×2p, 10×5p, 2×10p).
-- Adds join_room() and quick_join() RPCs.
-- Triggers keep room state in sync automatically.

-- ---------------------------------------------------------------------------
-- 1. Rooms table
-- ---------------------------------------------------------------------------
CREATE TABLE public.rooms (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL,
  match_size   smallint    NOT NULL CHECK (match_size IN (2, 5, 10)),
  status       text        NOT NULL DEFAULT 'open'
                             CHECK (status IN ('open', 'waiting', 'in_progress')),
  player_count smallint    NOT NULL DEFAULT 0,
  match_id     uuid        REFERENCES public.matches(id) ON DELETE SET NULL
);

CREATE INDEX rooms_match_size_status_idx ON public.rooms (match_size, status);
CREATE INDEX rooms_match_id_idx          ON public.rooms (match_id) WHERE match_id IS NOT NULL;

-- Everyone can read room state; only server-side functions may write.
ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rooms_read_all" ON public.rooms FOR SELECT USING (true);

-- ---------------------------------------------------------------------------
-- 2. Seed 52 rooms
-- ---------------------------------------------------------------------------
INSERT INTO public.rooms (name, match_size)
  SELECT 'Room ' || n, 2  FROM generate_series(1,  40) n
  UNION ALL
  SELECT 'Room ' || n, 5  FROM generate_series(41, 50) n
  UNION ALL
  SELECT 'Room ' || n, 10 FROM generate_series(51, 52) n;

-- ---------------------------------------------------------------------------
-- 3. join_room(p_room_id) → jsonb { match_id, seat, status, max_players }
--    Idempotent: returns existing seat if caller is already in this room.
--    Raises already_in_match if caller is in a different active/waiting match.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.join_room(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        uuid    := auth.uid();
  v_name       text;
  v_room       rooms%ROWTYPE;
  v_match_id   uuid;
  v_seat       smallint;
  v_count      smallint;
  v_status     text;
  v_existing   record;
  v_mstatus    text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT display_name INTO v_name FROM public.sync_my_profile(null);

  -- Lock the target room row for the duration of this transaction.
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'room_not_found'; END IF;

  -- If the room's linked match is stale (already finished), reset it now.
  IF v_room.match_id IS NOT NULL THEN
    SELECT status INTO v_mstatus FROM public.matches WHERE id = v_room.match_id;
    IF v_mstatus IS NULL OR v_mstatus = 'finished' THEN
      UPDATE public.rooms
      SET status = 'open', player_count = 0, match_id = NULL
      WHERE id = p_room_id;
      v_room.match_id    := NULL;
      v_room.status      := 'open';
      v_room.player_count := 0;
    END IF;
  END IF;

  IF v_room.status = 'in_progress' THEN RAISE EXCEPTION 'room_in_progress'; END IF;

  -- Check whether the caller already has a seat in this room's match.
  IF v_room.match_id IS NOT NULL THEN
    SELECT mp.match_id, mp.seat, m.status, m.max_players INTO v_existing
    FROM public.match_players mp
    JOIN public.matches m ON m.id = mp.match_id
    WHERE mp.match_id = v_room.match_id AND mp.user_id = v_uid;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'match_id',   v_existing.match_id,
        'seat',       v_existing.seat,
        'status',     v_existing.status,
        'max_players', v_existing.max_players
      );
    END IF;
  END IF;

  -- Block caller from joining if they are already in any other active/waiting match.
  SELECT mp.match_id INTO v_match_id
  FROM public.match_players mp
  JOIN public.matches m ON m.id = mp.match_id
  WHERE mp.user_id = v_uid AND m.status IN ('waiting', 'active')
  LIMIT 1;

  IF FOUND THEN RAISE EXCEPTION 'already_in_match'; END IF;

  -- Create a fresh match for this room if none exists yet.
  IF v_room.match_id IS NULL THEN
    INSERT INTO public.matches (status, max_players, created_by)
    VALUES ('waiting', v_room.match_size, v_uid)
    RETURNING id INTO v_match_id;

    UPDATE public.rooms
    SET match_id = v_match_id, status = 'waiting', player_count = 0
    WHERE id = p_room_id;

    v_room.match_id := v_match_id;
  ELSE
    v_match_id := v_room.match_id;
  END IF;

  -- Assign next seat.
  SELECT COUNT(*) INTO v_count FROM public.match_players WHERE match_id = v_match_id;
  v_seat := v_count + 1;

  INSERT INTO public.match_players (match_id, user_id, seat, display_name)
  VALUES (v_match_id, v_uid, v_seat, v_name);

  UPDATE public.rooms SET player_count = v_seat WHERE id = p_room_id;

  -- Start match if room is now full.
  IF v_seat >= v_room.match_size THEN
    UPDATE public.matches
    SET status = 'active', started_at = now()
    WHERE id = v_match_id;

    UPDATE public.rooms SET status = 'in_progress' WHERE id = p_room_id;
    v_status := 'active';
  ELSE
    v_status := 'waiting';
  END IF;

  RETURN jsonb_build_object(
    'match_id',   v_match_id,
    'seat',       v_seat,
    'status',     v_status,
    'max_players', v_room.match_size
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.join_room(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. quick_join(p_size) → jsonb
--    Picks the most-populated non-full room of the requested size, then
--    delegates to join_room(). Falls back to any open room.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.quick_join(p_size int)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room_id uuid;
BEGIN
  -- Prefer rooms already filling up (highest player_count first).
  SELECT id INTO v_room_id
  FROM public.rooms
  WHERE match_size = p_size
    AND status IN ('open', 'waiting')
  ORDER BY player_count DESC, id ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no_rooms_available';
  END IF;

  RETURN public.join_room(v_room_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.quick_join(int) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Trigger: reset room when its linked match finishes
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.on_match_finished()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'finished' AND OLD.status <> 'finished' THEN
    UPDATE public.rooms
    SET status = 'open', player_count = 0, match_id = NULL
    WHERE match_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_match_finished
AFTER UPDATE ON public.matches
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'finished')
EXECUTE FUNCTION public.on_match_finished();

-- ---------------------------------------------------------------------------
-- 6. Trigger: decrement room player_count when a player leaves a waiting room
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.on_match_player_removed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.rooms
  SET player_count = GREATEST(0, player_count - 1)
  WHERE match_id = OLD.match_id AND status = 'waiting';
  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_match_player_removed
AFTER DELETE ON public.match_players
FOR EACH ROW
EXECUTE FUNCTION public.on_match_player_removed();
