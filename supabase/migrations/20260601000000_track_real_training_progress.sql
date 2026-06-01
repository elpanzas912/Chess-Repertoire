-- Track completed training sessions and expose a server-built profile snapshot.
-- The browser keeps a cache, but authenticated progress is reconstructed here.

CREATE TABLE IF NOT EXISTS public.training_sessions (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    opening_slug TEXT NOT NULL CHECK (opening_slug ~ '^[a-z0-9-]+$'),
    line_pgn TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'learn' CHECK (mode IN ('learn', 'practice')),
    correct_moves INTEGER NOT NULL DEFAULT 0 CHECK (correct_moves >= 0),
    incorrect_moves INTEGER NOT NULL DEFAULT 0 CHECK (incorrect_moves >= 0),
    duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
    activity_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_training_sessions_user_date
    ON public.training_sessions(user_id, activity_date DESC);

CREATE INDEX IF NOT EXISTS idx_training_sessions_user_opening
    ON public.training_sessions(user_id, opening_slug);

ALTER TABLE public.training_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own training_sessions" ON public.training_sessions;
CREATE POLICY "Users can read own training_sessions"
    ON public.training_sessions FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own opening_progress" ON public.opening_progress;
DROP POLICY IF EXISTS "Users can manage own line_progress" ON public.line_progress;
DROP POLICY IF EXISTS "Users can manage own learned_lines" ON public.learned_lines;
DROP POLICY IF EXISTS "Users can manage own puzzle_ratings" ON public.puzzle_ratings;

DROP POLICY IF EXISTS "Users can read own opening_progress" ON public.opening_progress;
CREATE POLICY "Users can read own opening_progress"
    ON public.opening_progress FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can read own line_progress" ON public.line_progress;
CREATE POLICY "Users can read own line_progress"
    ON public.line_progress FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can read own learned_lines" ON public.learned_lines;
CREATE POLICY "Users can read own learned_lines"
    ON public.learned_lines FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can read own puzzle_ratings" ON public.puzzle_ratings;
CREATE POLICY "Users can read own puzzle_ratings"
    ON public.puzzle_ratings FOR SELECT
    USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.empty_accuracy_bucket()
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'learn', jsonb_build_object('correct', 0, 'incorrect', 0),
        'practice', jsonb_build_object('correct', 0, 'incorrect', 0)
    );
$$;

CREATE OR REPLACE FUNCTION public.add_accuracy_bucket(
    p_bucket JSONB,
    p_mode TEXT,
    p_correct INTEGER,
    p_incorrect INTEGER
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_set(
        jsonb_set(
            COALESCE(p_bucket, public.empty_accuracy_bucket()),
            ARRAY[p_mode, 'correct'],
            to_jsonb(COALESCE((p_bucket #>> ARRAY[p_mode, 'correct'])::INTEGER, 0) + p_correct),
            true
        ),
        ARRAY[p_mode, 'incorrect'],
        to_jsonb(COALESCE((p_bucket #>> ARRAY[p_mode, 'incorrect'])::INTEGER, 0) + p_incorrect),
        true
    );
$$;

DROP FUNCTION IF EXISTS public.get_user_progress(UUID);

CREATE OR REPLACE FUNCTION public.get_user_progress(p_user_id UUID, p_timezone TEXT DEFAULT 'UTC')
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    result JSONB := '{}'::JSONB;
    accuracy JSONB := jsonb_build_object(
        'totals', public.empty_accuracy_bucket(),
        'daily', '{}'::JSONB,
        'openings', '{}'::JSONB
    );
    activity_dates JSONB := '{}'::JSONB;
    opening_usage JSONB := '{}'::JSONB;
    opening_row RECORD;
    line_row RECORD;
    session_row RECORD;
    activity_row RECORD;
    slug_data JSONB;
    opening_accuracy JSONB;
    line_accuracy JSONB;
    expected_date DATE := NULL;
    streak_count INTEGER := 0;
    last_active_date DATE := NULL;
    current_local_date DATE;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;
    current_local_date := (NOW() AT TIME ZONE p_timezone)::DATE;

    result := jsonb_set(result, '{puzzleELO}',
        COALESCE((SELECT to_jsonb(pr.puzzle_elo) FROM public.puzzle_ratings pr WHERE pr.user_id = p_user_id), '1500'));

    FOR opening_row IN
        SELECT opening_slug, drill_high_score, time_high_score
        FROM public.opening_progress
        WHERE user_id = p_user_id
    LOOP
        slug_data := jsonb_build_object(
            'drillHighScore', opening_row.drill_high_score,
            'timeHighScore', opening_row.time_high_score,
            'lines', '{}'::JSONB,
            'learnedLines', '[]'::JSONB
        );

        FOR line_row IN
            SELECT line_pgn, completions, perfect_attempts, last_attempt_timestamp, confidence
            FROM public.line_progress
            WHERE user_id = p_user_id AND opening_slug = opening_row.opening_slug
        LOOP
            slug_data := jsonb_set(
                slug_data,
                '{lines}',
                (slug_data->'lines') || jsonb_build_object(
                    line_row.line_pgn,
                    jsonb_build_object(
                        'completions', line_row.completions,
                        'perfectAttempts', line_row.perfect_attempts,
                        'practicePerfectAttempts', line_row.perfect_attempts,
                        'lastAttemptTimestamp', line_row.last_attempt_timestamp,
                        'confidence', line_row.confidence
                    )
                )
            );
        END LOOP;

        slug_data := jsonb_set(
            slug_data,
            '{learnedLines}',
            COALESCE(
                (SELECT jsonb_agg(ll.line_pgn ORDER BY ll.learned_at)
                 FROM public.learned_lines ll
                 WHERE ll.user_id = p_user_id AND ll.opening_slug = opening_row.opening_slug),
                '[]'::JSONB
            )
        );

        result := result || jsonb_build_object(opening_row.opening_slug, slug_data);
    END LOOP;

    FOR activity_row IN
        SELECT activity_date, COUNT(*)::INTEGER AS session_count
        FROM public.training_sessions
        WHERE user_id = p_user_id
        GROUP BY activity_date
        ORDER BY activity_date DESC
    LOOP
        activity_dates := activity_dates || jsonb_build_object(activity_row.activity_date::TEXT, activity_row.session_count);
        IF last_active_date IS NULL THEN
            last_active_date := activity_row.activity_date;
            IF activity_row.activity_date < current_local_date - 1 THEN
                EXIT;
            END IF;
            expected_date := activity_row.activity_date;
        END IF;
        IF activity_row.activity_date <> expected_date THEN
            EXIT;
        END IF;
        streak_count := streak_count + 1;
        expected_date := expected_date - 1;
    END LOOP;

    FOR opening_row IN
        SELECT opening_slug, COUNT(*)::INTEGER AS session_count,
               FLOOR(EXTRACT(EPOCH FROM MAX(created_at)) * 1000)::BIGINT AS last_used
        FROM public.training_sessions
        WHERE user_id = p_user_id
        GROUP BY opening_slug
    LOOP
        opening_usage := opening_usage || jsonb_build_object(
            opening_row.opening_slug,
            jsonb_build_object('count', opening_row.session_count, 'lastUsed', opening_row.last_used)
        );
    END LOOP;

    FOR session_row IN
        SELECT opening_slug, line_pgn, mode, activity_date,
               SUM(correct_moves)::INTEGER AS correct_moves,
               SUM(incorrect_moves)::INTEGER AS incorrect_moves
        FROM public.training_sessions
        WHERE user_id = p_user_id
        GROUP BY opening_slug, line_pgn, mode, activity_date
    LOOP
        accuracy := jsonb_set(
            accuracy,
            '{totals}',
            public.add_accuracy_bucket(accuracy->'totals', session_row.mode, session_row.correct_moves, session_row.incorrect_moves)
        );
        accuracy := jsonb_set(
            accuracy,
            ARRAY['daily', session_row.activity_date::TEXT],
            public.add_accuracy_bucket(accuracy #> ARRAY['daily', session_row.activity_date::TEXT], session_row.mode, session_row.correct_moves, session_row.incorrect_moves),
            true
        );

        opening_accuracy := COALESCE(
            accuracy #> ARRAY['openings', session_row.opening_slug],
            jsonb_build_object('totals', public.empty_accuracy_bucket(), 'daily', '{}'::JSONB, 'lines', '{}'::JSONB)
        );
        opening_accuracy := jsonb_set(
            opening_accuracy,
            '{totals}',
            public.add_accuracy_bucket(opening_accuracy->'totals', session_row.mode, session_row.correct_moves, session_row.incorrect_moves)
        );
        opening_accuracy := jsonb_set(
            opening_accuracy,
            ARRAY['daily', session_row.activity_date::TEXT],
            public.add_accuracy_bucket(opening_accuracy #> ARRAY['daily', session_row.activity_date::TEXT], session_row.mode, session_row.correct_moves, session_row.incorrect_moves),
            true
        );

        line_accuracy := COALESCE(
            opening_accuracy #> ARRAY['lines', session_row.line_pgn],
            jsonb_build_object('totals', public.empty_accuracy_bucket(), 'daily', '{}'::JSONB)
        );
        line_accuracy := jsonb_set(
            line_accuracy,
            '{totals}',
            public.add_accuracy_bucket(line_accuracy->'totals', session_row.mode, session_row.correct_moves, session_row.incorrect_moves)
        );
        line_accuracy := jsonb_set(
            line_accuracy,
            ARRAY['daily', session_row.activity_date::TEXT],
            public.add_accuracy_bucket(line_accuracy #> ARRAY['daily', session_row.activity_date::TEXT], session_row.mode, session_row.correct_moves, session_row.incorrect_moves),
            true
        );
        opening_accuracy := jsonb_set(opening_accuracy, ARRAY['lines', session_row.line_pgn], line_accuracy, true);
        accuracy := jsonb_set(accuracy, ARRAY['openings', session_row.opening_slug], opening_accuracy, true);
    END LOOP;

    result := result || jsonb_build_object(
        'dailyStreak', jsonb_build_object(
            'count', streak_count,
            'lastActiveDate', CASE WHEN last_active_date IS NULL THEN NULL ELSE last_active_date::TEXT END,
            'activityDates', activity_dates
        ),
        'trainingTime', jsonb_build_object(
            'learn', COALESCE((SELECT SUM(duration_ms) FROM public.training_sessions WHERE user_id = p_user_id AND mode = 'learn'), 0),
            'practice', COALESCE((SELECT SUM(duration_ms) FROM public.training_sessions WHERE user_id = p_user_id AND mode = 'practice'), 0),
            'drill', 0,
            'time', 0,
            'puzzle', 0
        ),
        'accuracy', accuracy,
        'openingUsage', opening_usage
    );

    RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_training_session(
    p_event_id UUID,
    p_opening_slug TEXT,
    p_line_pgn TEXT,
    p_mode TEXT DEFAULT 'learn',
    p_correct_moves INTEGER DEFAULT 0,
    p_incorrect_moves INTEGER DEFAULT 0,
    p_duration_ms INTEGER DEFAULT 0,
    p_timezone TEXT DEFAULT 'UTC'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    user_uuid UUID := auth.uid();
    local_activity_date DATE;
    event_timestamp BIGINT := FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000);
    inserted_rows INTEGER := 0;
BEGIN
    IF user_uuid IS NULL THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;
    IF p_opening_slug IS NULL OR p_opening_slug !~ '^[a-z0-9-]+$' THEN
        RAISE EXCEPTION 'Invalid opening slug';
    END IF;
    IF p_line_pgn IS NULL OR LENGTH(BTRIM(p_line_pgn)) = 0 OR LENGTH(p_line_pgn) > 10000 THEN
        RAISE EXCEPTION 'Invalid line';
    END IF;
    IF p_mode NOT IN ('learn', 'practice') THEN
        RAISE EXCEPTION 'Invalid training mode';
    END IF;
    IF p_correct_moves < 0 OR p_correct_moves > 1000
       OR p_incorrect_moves < 0 OR p_incorrect_moves > 1000
       OR p_duration_ms < 0 OR p_duration_ms > 14400000 THEN
        RAISE EXCEPTION 'Invalid training metrics';
    END IF;

    local_activity_date := (NOW() AT TIME ZONE p_timezone)::DATE;

    INSERT INTO public.training_sessions (
        id, user_id, opening_slug, line_pgn, mode, correct_moves,
        incorrect_moves, duration_ms, activity_date
    )
    VALUES (
        p_event_id, user_uuid, p_opening_slug, p_line_pgn, p_mode,
        p_correct_moves, p_incorrect_moves, p_duration_ms, local_activity_date
    )
    ON CONFLICT (id) DO NOTHING;

    GET DIAGNOSTICS inserted_rows = ROW_COUNT;
    IF inserted_rows = 0 THEN
        RETURN public.get_user_progress(user_uuid, p_timezone);
    END IF;

    INSERT INTO public.opening_progress (user_id, opening_slug, updated_at)
    VALUES (user_uuid, p_opening_slug, NOW())
    ON CONFLICT (user_id, opening_slug) DO UPDATE SET updated_at = NOW();

    INSERT INTO public.line_progress (
        user_id, opening_slug, line_pgn, completions, perfect_attempts,
        last_attempt_timestamp, confidence, updated_at
    )
    VALUES (
        user_uuid, p_opening_slug, p_line_pgn, 1,
        CASE WHEN p_mode = 'practice' AND p_incorrect_moves = 0 THEN 1 ELSE 0 END,
        event_timestamp, 0, NOW()
    )
    ON CONFLICT (user_id, opening_slug, line_pgn) DO UPDATE SET
        completions = public.line_progress.completions + 1,
        perfect_attempts = public.line_progress.perfect_attempts
            + CASE WHEN p_mode = 'practice' AND p_incorrect_moves = 0 THEN 1 ELSE 0 END,
        last_attempt_timestamp = event_timestamp,
        updated_at = NOW();

    IF p_mode = 'learn' THEN
        INSERT INTO public.learned_lines (user_id, opening_slug, line_pgn)
        VALUES (user_uuid, p_opening_slug, p_line_pgn)
        ON CONFLICT (user_id, opening_slug, line_pgn) DO NOTHING;
    END IF;

    RETURN public.get_user_progress(user_uuid, p_timezone);
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_opening_training_progress(
    p_opening_slug TEXT,
    p_timezone TEXT DEFAULT 'UTC'
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

    DELETE FROM public.training_sessions WHERE user_id = user_uuid AND opening_slug = p_opening_slug;
    DELETE FROM public.learned_lines WHERE user_id = user_uuid AND opening_slug = p_opening_slug;
    DELETE FROM public.line_progress WHERE user_id = user_uuid AND opening_slug = p_opening_slug;
    DELETE FROM public.opening_progress WHERE user_id = user_uuid AND opening_slug = p_opening_slug;

    RETURN public.get_user_progress(user_uuid, p_timezone);
END;
$$;

REVOKE ALL ON FUNCTION public.empty_accuracy_bucket() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_accuracy_bucket(JSONB, TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_user_progress(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_training_session(UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_opening_training_progress(TEXT, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_user_progress(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_training_session(UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reset_opening_training_progress(TEXT, TEXT) TO authenticated;
