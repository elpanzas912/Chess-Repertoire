-- The free opening is assigned once by the get-opening Edge Function using the
-- service role. Prevent authenticated clients from rotating it through a
-- generic profiles update policy.

CREATE OR REPLACE FUNCTION public.prevent_client_free_opening_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF auth.role() = 'authenticated'
       AND (
           (TG_OP = 'INSERT' AND NEW.free_opening_slug IS NOT NULL)
           OR
           (TG_OP = 'UPDATE' AND NEW.free_opening_slug IS DISTINCT FROM OLD.free_opening_slug)
       ) THEN
        RAISE EXCEPTION 'free_opening_slug can only be assigned by the server';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_free_opening_choice ON public.profiles;

CREATE TRIGGER protect_free_opening_choice
BEFORE INSERT OR UPDATE OF free_opening_slug ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.prevent_client_free_opening_change();
