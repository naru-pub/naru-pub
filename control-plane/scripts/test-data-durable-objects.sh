#!/usr/bin/env bash
# The Durable Objects backend against a fresh local PostgreSQL cluster and the
# site-data Worker under `wrangler dev` (workerd, with SQLite-backed objects in
# a scratch directory). Install ../site-data-worker first: pnpm install there.
# Overrides the application's DATABASE_URL and SITE_DATA_WORKER_*.
set -euo pipefail
cd "$(dirname "$0")/.."
worker_dir=../site-data-worker
if [[ ! -x "$worker_dir/node_modules/.bin/wrangler" ]]; then
  echo "Run pnpm install in site-data-worker first." >&2
  exit 1
fi
pg_bin=${NARU_TEST_PG_BIN:-$(pg_config --bindir)}
scratch=$(mktemp -d /tmp/naru-do-test.XXXXXX)
pg_started=0
worker_pid=
cleanup() {
  if [[ -n "$worker_pid" ]]; then kill "$worker_pid" 2>/dev/null || true; fi
  if [[ "$pg_started" == 1 ]]; then
    "$pg_bin/pg_ctl" -D "$scratch/data" -m immediate -w stop >/dev/null || true
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT
"$pg_bin/initdb" -D "$scratch/data" --auth=trust --username=sdk_test --no-locale >"$scratch/init.log"
# A private Unix socket avoids port collisions and TCP access to the test DB.
if ! "$pg_bin/pg_ctl" -D "$scratch/data" -l "$scratch/server.log" -o "-h '' -k $scratch" -w start; then
  cat "$scratch/server.log" >&2
  exit 1
fi
pg_started=1
"$pg_bin/createdb" -h "$scratch" -U sdk_test naru_data_test

secret=$(head -c 32 /dev/urandom | base64 | tr -dc A-Za-z0-9)
port=$((20000 + RANDOM % 20000))
(cd "$worker_dir" && exec ./node_modules/.bin/wrangler dev --local \
  --ip 127.0.0.1 --port "$port" --inspector-port $((port + 1)) \
  --persist-to "$scratch/worker" --var "SITE_DATA_WORKER_SECRET:$secret" \
  --log-level warn) >"$scratch/worker.log" 2>&1 &
worker_pid=$!
for _ in $(seq 1 100); do
  if curl -s -o /dev/null "http://127.0.0.1:$port/"; then break; fi
  if ! kill -0 "$worker_pid" 2>/dev/null; then
    cat "$scratch/worker.log" >&2
    exit 1
  fi
  sleep 0.2
done

NARU_DATA_TEST=1 NARU_DATA_DO_TEST=1 \
  DATABASE_URL="postgresql://sdk_test@localhost/naru_data_test?host=$scratch" \
  SITE_DATA_WORKER_URL="http://127.0.0.1:$port" SITE_DATA_WORKER_SECRET="$secret" \
  ./node_modules/.bin/jest --config jest.data.config.cjs --runInBand \
  src/lib/site-data/__tests__/durable-object.test.ts "$@"
