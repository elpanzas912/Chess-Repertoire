-- The opening catalog is being replaced. Old progress references PGN lines and
-- slugs that no longer describe the published courses, so it cannot be merged.
-- Preserve users, profiles, subscriptions, and puzzle ratings.

DELETE FROM public.learned_lines;
DELETE FROM public.line_progress;
DELETE FROM public.opening_progress;

UPDATE public.profiles
SET user_progress = '{}'::JSONB,
    free_opening_slug = NULL,
    updated_at = NOW();
