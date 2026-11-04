#!/bin/sh
set -eu
# Invoked inside isolated PostgreSQL, without host ports or production secrets.
test "${PGDATABASE:-}" = "hugh_062_usage_release_test"
cd "$(dirname "$0")"
psql -v ON_ERROR_STOP=1 -f 062_usage_release_on_log.sql

# Reserving and logging must take their locks in the same order. A deadlock here
# would reach a learner as a refused request, so race the two for real: each
# client reserves and then logs, while all the others do the same.
psql -v ON_ERROR_STOP=1 -c "SELECT reserve_usage('62626262-6262-4262-8262-626262626262', '2099-01-01', 0, 100000, 1000, 60, 150);"
i=0
pids=""
while [ "$i" -lt 16 ]; do
  psql -v ON_ERROR_STOP=1 \
    -c "SELECT granted FROM reserve_usage('62626262-6262-4262-8262-626262626262', '2099-01-01', 1000, 100000, 1000, 60, 150, NOW(), 'learn/chat');" \
    -c "SELECT record_usage('62626262-6262-4262-8262-626262626262', '2099-01-01', 400, 'learn/chat');" &
  pids="$pids $!"
  i=$((i + 1))
done
for pid in $pids; do wait "$pid"; done
psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF (SELECT tokens_spent FROM usage_counters) <> 6400 OR
     (SELECT reserved_tokens FROM usage_counters) <> 0 OR
     (SELECT count(*) FROM usage_reservations) <> 0 THEN
    RAISE EXCEPTION 'Racing reservations and logs left the counter wrong';
  END IF;
END $$;
SELECT 'Migration 062 race checks passed' AS result;
SQL
