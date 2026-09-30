#!/bin/sh
set -eu
test "${PGDATABASE:-}" = "hugh_s8_security_test"
cd "$(dirname "$0")"
psql -v ON_ERROR_STOP=1 -f 057_tts_character_budget.sql

i=0
pids=""
while [ "$i" -lt 8 ]; do
  psql -v ON_ERROR_STOP=1 -c "INSERT INTO reservation_results SELECT granted FROM reserve_tts('22222222-2222-4222-8222-222222222222', '2026-09-01', 2000, 20000);" &
  pids="$pids $!"
  i=$((i + 1))
done
for pid in $pids; do wait "$pid"; done
psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF (SELECT count(*) FROM reservation_results) <> 8 OR
     (SELECT count(*) FROM reservation_results WHERE granted) <> 1 OR
     (SELECT chars_admitted FROM tts_counters
      WHERE user_id = '22222222-2222-4222-8222-222222222222') <> 20000 THEN
    RAISE EXCEPTION 'Concurrent TTS requests exceeded the character allowance';
  END IF;
  RAISE NOTICE 'PASS eight-way near-limit TTS concurrency';
END $$;
SQL
