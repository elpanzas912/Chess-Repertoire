ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS free_opening_slug TEXT;
