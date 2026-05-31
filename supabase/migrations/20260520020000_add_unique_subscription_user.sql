-- Ensure each app user has at most one local subscription mirror row.
DELETE FROM public.subscriptions a
USING public.subscriptions b
WHERE a.user_id = b.user_id
  AND a.id < b.id;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_user_id_key
  ON public.subscriptions(user_id);
