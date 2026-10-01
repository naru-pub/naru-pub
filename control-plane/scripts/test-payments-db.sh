#!/usr/bin/env bash
# The payment database tests — period grants, the charge lease, the renewal
# cron and refund reconciliation — against a fresh local cluster migrated to
# the latest schema. Overrides the application's DATABASE_URL.
set -euo pipefail
cd "$(dirname "$0")/.."
pg_bin=${NARU_TEST_PG_BIN:-$(pg_config --bindir)}
pg_dir=$(mktemp -d /tmp/naru-payments-pg.XXXXXX)
pg_started=0
cleanup() {
  if [[ "$pg_started" == 1 ]]; then
    "$pg_bin/pg_ctl" -D "$pg_dir/data" -m immediate -w stop >/dev/null || true
  fi
  rm -rf "$pg_dir"
}
trap cleanup EXIT
"$pg_bin/initdb" -D "$pg_dir/data" --auth=trust --username=payments_test --no-locale >"$pg_dir/init.log"
# A private Unix socket avoids port collisions and TCP access to the test DB.
if ! "$pg_bin/pg_ctl" -D "$pg_dir/data" -l "$pg_dir/server.log" -o "-h '' -k $pg_dir" -w start; then
  cat "$pg_dir/server.log" >&2
  exit 1
fi
pg_started=1
"$pg_bin/createdb" -h "$pg_dir" -U payments_test naru_payments_test
export DATABASE_URL="postgresql://payments_test@localhost/naru_payments_test?host=$pg_dir"
./node_modules/.bin/tsx src/cli/migrate.ts >/dev/null
# src/lib/db.d.ts is generated from this schema (pnpm kysely-codegen against a
# migrated database); a migration without regenerated types fails here.
./node_modules/.bin/kysely-codegen --config-file .kysely-codegenrc.json --verify
NARU_PAYMENTS_DB_TEST=1 ./node_modules/.bin/jest --config jest.payment.config.cjs --runInBand src/lib/__tests__/billing-db "$@"
