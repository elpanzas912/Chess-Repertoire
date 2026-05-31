-- ============================================================
-- Migration: Normalize user_progress JSONB into relational tables
-- Date: 2026-05-20
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── 1. New normalized tables ──

CREATE TABLE IF NOT EXISTS public.opening_progress (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
    opening_slug TEXT NOT NULL,
    drill_high_score INTEGER DEFAULT 0,
    time_high_score INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, opening_slug)
);

CREATE TABLE IF NOT EXISTS public.line_progress (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
    opening_slug TEXT NOT NULL,
    line_pgn TEXT NOT NULL,
    completions INTEGER DEFAULT 0,
    perfect_attempts INTEGER DEFAULT 0,
    last_attempt_timestamp BIGINT,
    confidence INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, opening_slug, line_pgn)
);

CREATE TABLE IF NOT EXISTS public.learned_lines (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
    opening_slug TEXT NOT NULL,
    line_pgn TEXT NOT NULL,
    learned_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, opening_slug, line_pgn)
);

CREATE TABLE IF NOT EXISTS public.puzzle_ratings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users ON DELETE CASCADE UNIQUE,
    puzzle_elo INTEGER DEFAULT 1500,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 2. Indexes ──

CREATE INDEX IF NOT EXISTS idx_opening_progress_user ON public.opening_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_line_progress_user ON public.line_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_line_progress_user_slug ON public.line_progress(user_id, opening_slug);
CREATE INDEX IF NOT EXISTS idx_learned_lines_user ON public.learned_lines(user_id);
CREATE INDEX IF NOT EXISTS idx_learned_lines_user_slug ON public.learned_lines(user_id, opening_slug);

-- ── 3. RLS policies ──

ALTER TABLE public.opening_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learned_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.puzzle_ratings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own opening_progress"
    ON public.opening_progress FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can manage own line_progress"
    ON public.line_progress FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can manage own learned_lines"
    ON public.learned_lines FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can manage own puzzle_ratings"
    ON public.puzzle_ratings FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- ── 4. Migrate existing JSONB data ──

INSERT INTO public.opening_progress (user_id, opening_slug, drill_high_score, time_high_score)
SELECT
    p.id,
    opening.slug,
    COALESCE((opening.data->>'drillHighScore')::INTEGER, 0),
    COALESCE((opening.data->>'timeHighScore')::INTEGER, 0)
FROM public.profiles p,
    LATERAL jsonb_each(p.user_progress) AS opening(slug, data)
WHERE p.user_progress IS NOT NULL
  AND opening.data ? 'drillHighScore'
ON CONFLICT (user_id, opening_slug) DO UPDATE SET
    drill_high_score = GREATEST(opening_progress.drill_high_score, EXCLUDED.drill_high_score),
    time_high_score = GREATEST(opening_progress.time_high_score, EXCLUDED.time_high_score);

INSERT INTO public.opening_progress (user_id, opening_slug, drill_high_score, time_high_score)
SELECT
    p.id,
    opening.slug,
    0,
    0
FROM public.profiles p,
    LATERAL jsonb_each(p.user_progress) AS opening(slug, data)
WHERE p.user_progress IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.opening_progress op
    WHERE op.user_id = p.id AND op.opening_slug = opening.slug
  )
ON CONFLICT DO NOTHING;

INSERT INTO public.line_progress (user_id, opening_slug, line_pgn, completions, perfect_attempts, last_attempt_timestamp, confidence)
SELECT
    p.id,
    opening.slug,
    line.pgn,
    COALESCE((line.data->>'completions')::INTEGER, 0),
    COALESCE((line.data->>'perfectAttempts')::INTEGER, 0),
    (line.data->>'lastAttemptTimestamp')::BIGINT,
    COALESCE((line.data->>'confidence')::INTEGER, 0)
FROM public.profiles p,
    LATERAL jsonb_each(p.user_progress) AS opening(slug, data),
    LATERAL jsonb_each(opening.data->'lines') AS line(pgn, data)
WHERE p.user_progress IS NOT NULL
ON CONFLICT (user_id, opening_slug, line_pgn) DO UPDATE SET
    completions = GREATEST(line_progress.completions, EXCLUDED.completions),
    perfect_attempts = GREATEST(line_progress.perfect_attempts, EXCLUDED.perfect_attempts),
    confidence = GREATEST(line_progress.confidence, EXCLUDED.confidence),
    last_attempt_timestamp = GREATEST(COALESCE(line_progress.last_attempt_timestamp, 0), COALESCE(EXCLUDED.last_attempt_timestamp, 0));

INSERT INTO public.learned_lines (user_id, opening_slug, line_pgn)
SELECT
    p.id,
    opening.slug,
    line_learned.pgn
FROM public.profiles p,
    LATERAL jsonb_each(p.user_progress) AS opening(slug, data),
    LATERAL jsonb_array_elements_text(opening.data->'learnedLines') AS line_learned(pgn)
WHERE p.user_progress IS NOT NULL
  AND opening.data ? 'learnedLines'
ON CONFLICT DO NOTHING;

INSERT INTO public.puzzle_ratings (user_id, puzzle_elo)
SELECT p.id, COALESCE((p.user_progress->>'puzzleELO')::INTEGER, 1500)
FROM public.profiles p
WHERE p.user_progress IS NOT NULL
  AND p.user_progress ? 'puzzleELO'
ON CONFLICT (user_id) DO UPDATE SET
    puzzle_elo = GREATEST(puzzle_ratings.puzzle_elo, EXCLUDED.puzzle_elo);

-- ── 5. Updated RPC function (now queries normalized tables) ──

CREATE OR REPLACE FUNCTION public.get_daily_event_counts_by_timezone(
    p_user_id UUID,
    p_timezone TEXT DEFAULT 'UTC'
)
RETURNS TABLE (date_str TEXT, event_count BIGINT) AS $$
BEGIN
    RETURN QUERY
    SELECT
        (TO_TIMESTAMP(COALESCE(lp.last_attempt_timestamp, 0) / 1000.0) AT TIME ZONE p_timezone)::DATE::TEXT as date_str,
        COUNT(*)::BIGINT as event_count
    FROM public.line_progress lp
    WHERE lp.user_id = p_user_id
      AND lp.last_attempt_timestamp IS NOT NULL
    GROUP BY (TO_TIMESTAMP(COALESCE(lp.last_attempt_timestamp, 0) / 1000.0) AT TIME ZONE p_timezone)::DATE::TEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 6. Helper function to reconstruct user_progress JSONB from normalized tables ──
-- This allows backwards compatibility: the client can request the full progress
-- as a single JSONB object for local caching, while individual writes go to
-- the normalized tables.

CREATE OR REPLACE FUNCTION public.get_user_progress(p_user_id UUID)
RETURNS JSONB AS $$
DECLARE
    result JSONB := '{}';
    opening_row RECORD;
    line_row RECORD;
    slug_data JSONB;
BEGIN
    -- Puzzle ELO
    result := jsonb_set(result, '{puzzleELO}',
        COALESCE((SELECT to_jsonb(pr.puzzle_elo) FROM public.puzzle_ratings pr WHERE pr.user_id = p_user_id), '1500'));

    -- Per-opening data
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

        -- Lines
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

        -- Learned lines
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

    -- Add slugs that have line_progress or learned_lines but no opening_progress row
    FOR opening_row IN
        SELECT DISTINCT opening_slug FROM public.line_progress WHERE user_id = p_user_id
        EXCEPT
        SELECT opening_slug FROM public.opening_progress WHERE user_id = p_user_id
    LOOP
        slug_data := jsonb_build_object(
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 7. Keep the profiles.user_progress column for backwards compatibility ──
-- but mark it as deprecated. The client will gradually migrate to writing
-- directly to the normalized tables. During the transition, both systems
-- are kept in sync.
COMMENT ON COLUMN public.profiles.user_progress IS 'DEPRECATED: Use opening_progress, line_progress, learned_lines, and puzzle_ratings tables instead.';