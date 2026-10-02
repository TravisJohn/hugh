# Live voice control rollout

This branch is stacked on the scripted-mastery removal branch. Keep
`MASTERY_REALTIME_ENABLED=false` until migrations 058 and 059, the recovery
secrets, and a real call check are complete. The API still admits only an
unblocked administrator. Hugh Pro learners are not enabled here.

## Session policy

- Two minutes maximum and 60 seconds without observed speech or response
  activity. The server sideband enforces these; browser timers help the UI.
- Twelve coach responses, one open session per user and two across Hugh.
- Each response is configured for at most 500 output tokens and a 2,000-token
  post-instruction context window. Hugh's browser sends no session updates;
  the sideband hangs up if it observes one.
- $0.20 reserved per attempt, $2 per user and $10 across Hugh each UTC month.
  The database admits requests under a transaction lock. It counts the larger
  of reservation and observed cost for each session, including failed or
  interrupted attempts. These are conservative API-cost estimates, not a
  provider invoice or a precise per-response hard ceiling.
- Provider `response.done` and transcription events are stored once by event
  ID. The same transaction updates session totals, `usage_logs` and the
  existing token counter. Browser-submitted usage is closed by default.
- User, admin, timeout, inactivity, followup, cost, and sideband-failure paths
  call OpenAI's hangup endpoint. A minute recovery job retries expired calls
  if an app function disappears or hangup fails.

## Production setup

1. Apply migrations 058 and 059 using the project's forward-only migration
   process. They add the session ledger and Supabase `pg_cron`/`pg_net` recovery
   job. No new calls can start until recovery is configured.
2. Generate a random secret of at least 32 characters. Set it as Vercel
   `CRON_SECRET` for the production deployment. Do not use the OpenAI key.
3. In the Supabase SQL editor, store the exact production recovery URL and the
   same secret in Vault. Replace the placeholders locally, never in Git:

   ```sql
   select vault.create_secret(
     'https://YOUR-HUGH-DOMAIN/api/internal/mastery-realtime-recover',
     'mastery_realtime_recovery_url'
   );
   select vault.create_secret('YOUR-RANDOM-SECRET',
     'mastery_realtime_recovery_secret');
   ```

4. Check `select public.mastery_realtime_recovery_ready();` returns `true`.
   Confirm `mastery-realtime-recovery` is active in `cron.job`. The cron job
   sends a request only while an overdue call exists; the app endpoint requires
   `Authorization: Bearer <CRON_SECRET>`.
5. With the flag still off, test the recovery endpoint using a staging expired
   session. Confirm OpenAI hangup succeeds and the row ends. Then enable the
   flag for an administrator and run one short call. Check `/admin/voice`,
   `usage_logs`, OpenAI usage, user end, admin end, timeout, and a disconnected
   browser. Turn the flag off if any server usage or termination check fails.

If the old browser credential flow has an administrator call in flight during
deployment, `MASTERY_LEGACY_REPORTS_UNTIL` may be set to a UTC timestamp no
more than 16 minutes after the change. This temporarily accepts browser
reports for that call. Leave it unset otherwise and remove it after the drain.

The observer runs in a Next `after()` callback with a 240-second function
duration for a 120-second call. Recovery remains necessary because function
shutdown or network loss can interrupt that callback. The minute job bounds
the retry delay but cannot guarantee an exact cutoff at 120 seconds. Keep the
OpenAI project budget as a final provider-side ceiling, and reconcile Hugh's
observed estimates with OpenAI billing before enabling Pro access.

The existing `gpt-realtime-mini` model stays in this control change. OpenAI
lists its January 20, 2027 shutdown and recommends `gpt-realtime-2.1-mini`;
schedule model migration and live voice quality checks before that date.
