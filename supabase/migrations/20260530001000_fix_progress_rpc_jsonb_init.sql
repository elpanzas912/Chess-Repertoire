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

REVOKE ALL ON FUNCTION public.get_user_progress(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_progress(UUID) TO authenticated;
