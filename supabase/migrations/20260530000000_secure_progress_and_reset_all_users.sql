-- Secure progress RPCs, expose a minimal leaderboard RPC, and reset all user progress.

CREATE OR REPLACE FUNCTION public.get_daily_event_counts_by_timezone(
    p_user_id UUID,
    p_timezone TEXT DEFAULT 'UTC'
)
RETURNS TABLE (date_str TEXT, event_count BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    RETURN QUERY
    SELECT
        (TO_TIMESTAMP(COALESCE(lp.last_attempt_timestamp, 0) / 1000.0) AT TIME ZONE p_timezone)::DATE::TEXT,
        COUNT(*)::BIGINT
    FROM public.line_progress lp
    WHERE lp.user_id = p_user_id
      AND lp.last_attempt_timestamp IS NOT NULL
    GROUP BY (TO_TIMESTAMP(COALESCE(lp.last_attempt_timestamp, 0) / 1000.0) AT TIME ZONE p_timezone)::DATE::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_user_progress(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    result JSONB := '{}'::JSONB;
    opening_row RECORD;
    line_row RECORD;
    slug_data JSONB;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    result := jsonb_set(result, '{puzzleELO}',
        COALESCE((SELECT to_jsonb(pr.puzzle_elo) FROM public.puzzle_ratings pr WHERE pr.user_id = p_user_id), '1500'));

    FOR opening_row IN
        SELECT opening_slug, drill_high_score, time_high_score
        FROM public.opening_progress WHERE user_id = p_user_id
    LOOP
        slug_data := jsonb_build_object(
            'drillHighScore', opening_row.drill_high_score,
            'timeHighScore', opening_row.time_high_score,
            'lines', '{}'::jsonb,
            'learnedLines', '[]'::jsonb
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
                (SELECT jsonb_agg(ll.line_pgn)
                 FROM public.learned_lines ll
                 WHERE ll.user_id = p_user_id AND ll.opening_slug = opening_row.opening_slug),
                '[]'::jsonb
            )
        );

        result := result || jsonb_build_object(opening_row.opening_slug, slug_data);
    END LOOP;

    RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.has_active_subscription(user_uuid UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> user_uuid THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    RETURN EXISTS (
        SELECT 1 FROM public.subscriptions
        WHERE user_id = user_uuid
          AND status IN ('trialing', 'active')
          AND current_period_end > NOW()
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_puzzle_leaderboard(p_limit INTEGER DEFAULT 10)
RETURNS TABLE (display_name TEXT, puzzle_elo INTEGER)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        COALESCE(NULLIF(BTRIM(p.display_name), ''), 'Anonymous') AS display_name,
        pr.puzzle_elo
    FROM public.puzzle_ratings pr
    LEFT JOIN public.profiles p ON p.id = pr.user_id
    ORDER BY pr.puzzle_elo DESC, pr.updated_at ASC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 100);
$$;

REVOKE ALL ON FUNCTION public.get_daily_event_counts_by_timezone(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_user_progress(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_active_subscription(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_puzzle_leaderboard(INTEGER) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_daily_event_counts_by_timezone(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_progress(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_active_subscription(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_puzzle_leaderboard(INTEGER) TO anon, authenticated;

DELETE FROM public.learned_lines;
DELETE FROM public.line_progress;
DELETE FROM public.opening_progress;
DELETE FROM public.puzzle_ratings;

UPDATE public.profiles
SET user_progress = '{}'::JSONB,
    updated_at = NOW();
