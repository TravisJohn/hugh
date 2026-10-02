-- Supabase's minute scheduler calls Hugh only when a voice call is overdue.
-- Two Vault secrets are configured at rollout, outside source control:
--   mastery_realtime_recovery_url: production HTTPS origin plus
--     /api/internal/mastery-realtime-recover
--   mastery_realtime_recovery_secret: the same random value as CRON_SECRET
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS vault;
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

CREATE FUNCTION public.mastery_realtime_recovery_ready()
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM cron.job
    WHERE jobname = 'mastery-realtime-recovery' AND active
  ) AND EXISTS (
    SELECT 1 FROM vault.decrypted_secrets
    WHERE name = 'mastery_realtime_recovery_url'
      AND decrypted_secret LIKE 'https://%/api/internal/mastery-realtime-recover'
  ) AND EXISTS (
    SELECT 1 FROM vault.decrypted_secrets
    WHERE name = 'mastery_realtime_recovery_secret' AND length(decrypted_secret) >= 32
  );
$$;
REVOKE ALL ON FUNCTION public.mastery_realtime_recovery_ready() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mastery_realtime_recovery_ready() TO service_role;

CREATE FUNCTION public.queue_mastery_realtime_recovery()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE v_url text; v_secret text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.mastery_realtime_sessions
                 WHERE state IN ('starting','active') AND deadline_at <= now()) THEN
    RETURN;
  END IF;
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets
    WHERE name = 'mastery_realtime_recovery_url';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
    WHERE name = 'mastery_realtime_recovery_secret';
  IF v_url IS NULL OR v_secret IS NULL THEN RETURN; END IF;
  PERFORM net.http_get(
    url := v_url,
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 10000
  );
END;
$$;
REVOKE ALL ON FUNCTION public.queue_mastery_realtime_recovery() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule(
  'mastery-realtime-recovery', '* * * * *',
  $job$ SELECT public.queue_mastery_realtime_recovery() $job$
);
