#!/usr/bin/env bash
# A fresh local cluster and a local site-data Worker (with-site-data-worker.sh):
# overrides the application's DATABASE_URL and SITE_DATA_WORKER_*. With no
# arguments, the SDK contract suite; with the whole directory, it also runs the
# SDK suite again with its data requests sent to the Worker, as Cloudflare
# routes them in production.
set -euo pipefail
cd "$(dirname "$0")/.."
sdk_pg_bin=${NARU_TEST_PG_BIN:-$(pg_config --bindir)}
sdk_pg_dir=$(mktemp -d /tmp/naru-sdk-pg.XXXXXX)
sdk_pg_started=0
cleanup() {
  if [[ "$sdk_pg_started" == 1 ]]; then
    if ! "$sdk_pg_bin/pg_ctl" -D "$sdk_pg_dir/data" -m immediate -w stop; then
      echo "Could not stop test PostgreSQL. Logs and data: $sdk_pg_dir" >&2
      return 1
    fi
  fi
  rm -rf "$sdk_pg_dir"
}
trap cleanup EXIT
"$sdk_pg_bin/initdb" -D "$sdk_pg_dir/data" --auth=trust --username=sdk_test --no-locale >"$sdk_pg_dir/init.log"
# A private Unix socket avoids port collisions and TCP access to the test DB.
if ! "$sdk_pg_bin/pg_ctl" -D "$sdk_pg_dir/data" -l "$sdk_pg_dir/server.log" -o "-h '' -k $sdk_pg_dir" -w start; then
  cat "$sdk_pg_dir/server.log" >&2
  exit 1
fi
sdk_pg_started=1
"$sdk_pg_bin/createdb" -h "$sdk_pg_dir" -U sdk_test naru_data_test
if [[ "$#" == 0 ]]; then
  set -- src/lib/site-data/__tests__/sdk-integration.test.ts
fi
export NARU_DATA_TEST=1
export DATABASE_URL="postgresql://sdk_test@localhost/naru_data_test?host=$sdk_pg_dir"
scripts/with-site-data-worker.sh \
  ./node_modules/.bin/jest --config jest.data.config.cjs --runInBand "$@"
if [[ "$*" == "src/lib/site-data/__tests__/" ]]; then
  NARU_DATA_TEST_EDGE=1 scripts/with-site-data-worker.sh \
    ./node_modules/.bin/jest --config jest.data.config.cjs --runInBand \
    src/lib/site-data/__tests__/sdk-integration.test.ts
fi
