-- Track active trainer time independently from line completion.
-- A user can train, leave midway through a line, and still retain real activity.

CREATE TABLE IF NOT EXISTS public.training_activity_events (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    opening_slug TEXT NOT NULL CHECK (opening_slug ~ '^[a-z0-9-]+$'),
    mode TEXT NOT NULL DEFAULT 'learn' CHECK (mode IN ('learn', 'practice')),
    duration_ms INTEGER NOT NULL CHECK (duration_ms > 0 AND duration_ms <= 60000),
    activity_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_training_activity_events_user_date
    ON public.training_activity_events(user_id, activity_date DESC);

ALTER TABLE public.training_activity_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own training_activity_events" ON public.training_activity_events;
CREATE POLICY "Users can read own training_activity_events"
    ON public.training_activity_events FOR SELECT
    USING (auth.uid() = user_id);

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
            'drill', 0,
            'time', 0,
            'puzzle', 0
        )
    );
END;
$$;

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
    IF p_mode NOT IN ('learn', 'practice') THEN
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

REVOKE ALL ON FUNCTION public.get_training_activity_summary(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_training_activity(UUID, TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_training_activity_summary(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_training_activity(UUID, TEXT, TEXT, INTEGER, TEXT) TO authenticated;

