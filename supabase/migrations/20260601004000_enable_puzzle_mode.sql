-- Enable Puzzle activity tracking and persist Puzzle ELO and streak atomically.

ALTER TABLE public.puzzle_ratings
    ADD COLUMN IF NOT EXISTS puzzle_streak INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.training_activity_events
    DROP CONSTRAINT IF EXISTS training_activity_events_mode_check;

ALTER TABLE public.training_activity_events
    ADD CONSTRAINT training_activity_events_mode_check
    CHECK (mode IN ('learn', 'practice', 'drill', 'time', 'puzzle'));

CREATE OR REPLACE FUNCTION public.record_training_activity(
    p_event_id UUID,
    p_opening_slug TEXT,
    p_mode TEXT DEFAULT 'learn',
    p_duration_ms INTEGER DEFAULT 0,
    p_timezone TEXT DEFAULT 'UTC'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    user_uuid UUID := auth.uid();
BEGIN
    IF user_uuid IS NULL THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;
    IF p_opening_slug IS NULL OR p_opening_slug !~ '^[a-z0-9-]+$' THEN
        RAISE EXCEPTION 'Invalid opening slug';
    END IF;
    IF p_mode NOT IN ('learn', 'practice', 'drill', 'time', 'puzzle') THEN
        RAISE EXCEPTION 'Invalid training mode';
    END IF;
    IF p_duration_ms <= 0 OR p_duration_ms > 60000 THEN
        RAISE EXCEPTION 'Invalid training duration';
    END IF;

    INSERT INTO public.training_activity_events (
        id, user_id, opening_slug, mode, duration_ms, activity_date
    )
    VALUES (
        p_event_id, user_uuid, p_opening_slug, p_mode, p_duration_ms,
        (NOW() AT TIME ZONE p_timezone)::DATE
    )
    ON CONFLICT (id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_training_activity_summary(
    p_user_id UUID,
    p_timezone TEXT DEFAULT 'UTC'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    activity_dates JSONB := '{}'::JSONB;
    activity_row RECORD;
    expected_date DATE := NULL;
    streak_count INTEGER := 0;
    last_active_date DATE := NULL;
    current_local_date DATE;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    current_local_date := (NOW() AT TIME ZONE p_timezone)::DATE;

    FOR activity_row IN
        SELECT activity_date, GREATEST(1, CEIL(SUM(duration_ms) / 60000.0))::INTEGER AS active_minutes
        FROM public.training_activity_events
        WHERE user_id = p_user_id
        GROUP BY activity_date
        ORDER BY activity_date DESC
    LOOP
        activity_dates := activity_dates || jsonb_build_object(activity_row.activity_date::TEXT, activity_row.active_minutes);
        IF last_active_date IS NULL THEN
            last_active_date := activity_row.activity_date;
            IF activity_row.activity_date < current_local_date - 1 THEN
                CONTINUE;
            END IF;
            expected_date := activity_row.activity_date;
        END IF;
        IF expected_date IS NOT NULL AND activity_row.activity_date = expected_date THEN
            streak_count := streak_count + 1;
            expected_date := expected_date - 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'dailyStreak', jsonb_build_object(
            'count', streak_count,
            'lastActiveDate', CASE WHEN last_active_date IS NULL THEN NULL ELSE last_active_date::TEXT END,
            'activityDates', activity_dates
        ),
        'trainingTime', jsonb_build_object(
            'learn', COALESCE((SELECT SUM(duration_ms) FROM public.training_activity_events WHERE user_id = p_user_id AND mode = 'learn'), 0),
            'practice', COALESCE((SELECT SUM(duration_ms) FROM public.training_activity_events WHERE user_id = p_user_id AND mode = 'practice'), 0),
            'drill', COALESCE((SELECT SUM(duration_ms) FROM public.training_activity_events WHERE user_id = p_user_id AND mode = 'drill'), 0),
            'time', COALESCE((SELECT SUM(duration_ms) FROM public.training_activity_events WHERE user_id = p_user_id AND mode = 'time'), 0),
            'puzzle', COALESCE((SELECT SUM(duration_ms) FROM public.training_activity_events WHERE user_id = p_user_id AND mode = 'puzzle'), 0)
        )
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_puzzle_progress()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    user_uuid UUID := auth.uid();
BEGIN
    IF user_uuid IS NULL THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    RETURN COALESCE(
        (SELECT jsonb_build_object(
            'puzzleELO', puzzle_elo,
            'puzzleStreak', puzzle_streak
        )
        FROM public.puzzle_ratings
        WHERE user_id = user_uuid),
        jsonb_build_object('puzzleELO', 1500, 'puzzleStreak', 0)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_puzzle_result(
    p_puzzle_rating INTEGER,
    p_solved BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    user_uuid UUID := auth.uid();
    current_elo INTEGER := 1500;
    current_streak INTEGER := 0;
    expected_score NUMERIC;
    rating_change INTEGER;
    next_elo INTEGER;
    next_streak INTEGER;
BEGIN
    IF user_uuid IS NULL THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;
    IF p_puzzle_rating < 400 OR p_puzzle_rating > 5000 THEN
        RAISE EXCEPTION 'Invalid puzzle rating';
    END IF;

    SELECT puzzle_elo, puzzle_streak
    INTO current_elo, current_streak
    FROM public.puzzle_ratings
    WHERE user_id = user_uuid
    FOR UPDATE;

    current_elo := COALESCE(current_elo, 1500);
    current_streak := COALESCE(current_streak, 0);
    expected_score := 1.0 / (1.0 + POWER(10.0, (p_puzzle_rating - current_elo) / 400.0));
    rating_change := ROUND(32 * ((CASE WHEN p_solved THEN 1 ELSE 0 END) - expected_score));
    next_elo := GREATEST(400, current_elo + rating_change);
    next_streak := CASE WHEN p_solved THEN current_streak + 1 ELSE 0 END;

    INSERT INTO public.puzzle_ratings (user_id, puzzle_elo, puzzle_streak, updated_at)
    VALUES (user_uuid, next_elo, next_streak, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
        puzzle_elo = EXCLUDED.puzzle_elo,
        puzzle_streak = EXCLUDED.puzzle_streak,
        updated_at = NOW();

    RETURN jsonb_build_object(
        'puzzleELO', next_elo,
        'puzzleStreak', next_streak,
        'ratingChange', rating_change
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_puzzle_progress() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_puzzle_result(INTEGER, BOOLEAN) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_puzzle_progress() TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_puzzle_result(INTEGER, BOOLEAN) TO authenticated;
