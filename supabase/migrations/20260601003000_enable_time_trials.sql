-- Enable Time Trials tracking and persist per-opening high scores.

ALTER TABLE public.training_activity_events
    DROP CONSTRAINT IF EXISTS training_activity_events_mode_check;

ALTER TABLE public.training_activity_events
    ADD CONSTRAINT training_activity_events_mode_check
    CHECK (mode IN ('learn', 'practice', 'drill', 'time'));

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
    IF p_mode NOT IN ('learn', 'practice', 'drill', 'time') THEN
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
            'puzzle', 0
        )
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.save_time_high_score(
    p_opening_slug TEXT,
    p_score INTEGER
)
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
    IF p_opening_slug IS NULL OR p_opening_slug !~ '^[a-z0-9-]+$' THEN
        RAISE EXCEPTION 'Invalid opening slug';
    END IF;
    IF p_score < 0 OR p_score > 1000000 THEN
        RAISE EXCEPTION 'Invalid Time Trials score';
    END IF;

    INSERT INTO public.opening_progress (user_id, opening_slug, time_high_score, updated_at)
    VALUES (user_uuid, p_opening_slug, p_score, NOW())
    ON CONFLICT (user_id, opening_slug) DO UPDATE SET
        time_high_score = GREATEST(public.opening_progress.time_high_score, EXCLUDED.time_high_score),
        updated_at = NOW();

    RETURN public.get_user_progress(user_uuid, 'UTC');
END;
$$;

REVOKE ALL ON FUNCTION public.save_time_high_score(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_time_high_score(TEXT, INTEGER) TO authenticated;
