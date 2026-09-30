#!/bin/sh
set -eu
# Invoked inside isolated PostgreSQL, without host ports or production secrets.
test "${PGDATABASE:-}" = "hugh_s2_security_test"
cd "$(dirname "$0")"
psql -v ON_ERROR_STOP=1 -f s2_text_budget.sql
i=0
pids=""
while [ "$i" -lt 8 ]; do
  psql -v ON_ERROR_STOP=1 -c "INSERT INTO reservation_results SELECT granted FROM reserve_usage('33333333-3333-4333-8333-333333333333', '2026-09-01', 18000, 100000, 30, 60, 150, '2026-09-29 12:00:00+00');" &
  pids="$pids $!"
  i=$((i + 1))
done
for pid in $pids; do wait "$pid"; done
psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF (SELECT count(*) FROM reservation_results) <> 8 OR
     (SELECT count(*) FROM reservation_results WHERE granted) <> 1 OR
     (SELECT reserved_tokens FROM usage_counters) <> 18000 OR
     (SELECT rate_count FROM usage_counters) <> 8 THEN
    RAISE EXCEPTION 'Concurrent prompt-sized reservations exceeded the available budget';
  END IF;
END $$;
SELECT 'S2 concurrent reservation checks passed' AS result;
SQL
