#!/usr/bin/env bash
# Cross-database pg_cron scheduling in a disposable cluster. Requires pg_cron
# installed for the selected PostgreSQL, or the temporary paths below.
set -euo pipefail
cd "$(dirname "$0")/.."
pg_bin=${NARU_TEST_PG_BIN:-$(pg_config --bindir)}
pg_dir=$(mktemp -d /tmp/naru-payment-schedules.XXXXXX)
pg_started=0
cleanup() {
  if [[ "$pg_started" == 1 ]]; then
    "$pg_bin/pg_ctl" -D "$pg_dir/data" -m immediate -w stop >/dev/null || true
  fi
  rm -rf "$pg_dir"
}
trap cleanup EXIT
"$pg_bin/initdb" -D "$pg_dir/data" --auth=trust --username=payments_test --no-locale >"$pg_dir/init.log"
printf '%s\n' "shared_preload_libraries = '${NARU_TEST_PG_CRON_LIBRARY:-pg_cron}'" \
  "cron.database_name = 'postgres'" "cron.host = '$pg_dir'" >>"$pg_dir/data/postgresql.conf"
if [[ -n "${NARU_TEST_PG_CRON_EXTENSION_DIR:-}" ]]; then
  printf '%s\n' "extension_control_path = '$NARU_TEST_PG_CRON_EXTENSION_DIR:\$system'" >>"$pg_dir/data/postgresql.conf"
fi
if ! "$pg_bin/pg_ctl" -D "$pg_dir/data" -l "$pg_dir/server.log" -o "-h '' -k $pg_dir" -w start >/dev/null; then
  cat "$pg_dir/server.log" >&2
  exit 1
fi
pg_started=1
"$pg_bin/createdb" -h "$pg_dir" -U payments_test naru_schedule_test
export DATABASE_URL="postgresql://payments_test@localhost/naru_schedule_test?host=$pg_dir"
node scripts/build-cli.mjs
node dist/cli/migrate.mjs >"$pg_dir/migrate.log"
node dist/cli/configure-payment-schedules.mjs
node dist/cli/configure-payment-schedules.mjs
psql_meta() { "$pg_bin/psql" -h "$pg_dir" -U payments_test -d postgres -At -v ON_ERROR_STOP=1 -c "$1"; }
psql_app() { "$pg_bin/psql" -h "$pg_dir" -U payments_test -d naru_schedule_test -At -v ON_ERROR_STOP=1 -c "$1"; }
[[ "$(psql_meta "select count(*) from cron.job where jobname='naru-renewal-scan' and database='naru_schedule_test' and schedule='0 * * * *' and active")" == 1 ]]
[[ "$(psql_app "select count(*) from absurd.t_payments")" == 1 ]]
# Prove pg_cron itself enqueues into the other database, not just the installer's
# catch-up call. The temporary queue has no other work and no running worker.
psql_app 'truncate absurd.c_payments, absurd.e_payments, absurd.r_payments, absurd.t_payments, absurd.w_payments cascade' >/dev/null
psql_meta "select cron.alter_job(jobid, schedule := '1 second') from cron.job where jobname='naru-renewal-scan'" >/dev/null
for ((i=0;i<100;i++)); do
  if [[ "$(psql_app 'select count(*) from absurd.t_payments')" == 1 ]]; then break; fi
  sleep 0.1
done
[[ "$(psql_app "select count(*) from absurd.t_payments where params->'job'->>'kind'='enqueue_due_renewals'")" == 1 ]]
sleep 2
[[ "$(psql_app 'select count(*) from absurd.t_payments')" == 1 ]]
[[ "$(psql_meta "select count(*) from cron.job_run_details where status='succeeded'")" -ge 1 ]]
[[ "$(psql_meta "select count(*) from cron.job_run_details where status='failed'")" == 0 ]]
echo 'pg_cron cross-database schedule, deployment catch-up, and slot deduplication passed'
