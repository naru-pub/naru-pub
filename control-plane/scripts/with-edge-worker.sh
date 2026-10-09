#!/usr/bin/env bash
# Runs a command with the edge Worker under `wrangler dev` (workerd, with
# SQLite-backed Durable Objects in a scratch directory), which every site
# database lives in. Sets EDGE_WORKER_URL and EDGE_WORKER_SECRET for
# it, and SITE_DATA_TEST_ORIGIN_PORT: the Worker sends what it does not answer
# itself to a server a test may start on that port, standing in for the
# control plane. It also opens the Worker's test-only export and import
# operations. Install ../edge first: pnpm install there.
set -euo pipefail
cd "$(dirname "$0")/.."
worker_dir=../edge
if [[ ! -x "$worker_dir/node_modules/.bin/wrangler" ]]; then
  echo "Run pnpm install in edge/ first." >&2
  exit 1
fi
scratch=$(mktemp -d /tmp/naru-edge-worker.XXXXXX)
worker_pid=
cleanup() {
  if [[ -n "$worker_pid" ]]; then kill "$worker_pid" 2>/dev/null || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT
secret=$(head -c 32 /dev/urandom | base64 | tr -dc A-Za-z0-9)
port=$((20000 + RANDOM % 20000))
origin_port=$((port + 2))
(cd "$worker_dir" && exec ./node_modules/.bin/wrangler dev --local \
  --ip 127.0.0.1 --port "$port" --inspector-port $((port + 1)) \
  --persist-to "$scratch/worker" --var "EDGE_WORKER_SECRET:$secret" \
  --var "PASSTHROUGH_ORIGIN:http://127.0.0.1:$origin_port" \
  --var "TEST_OPERATIONS:1" \
  --log-level warn) >"$scratch/worker.log" 2>&1 &
worker_pid=$!
for _ in $(seq 1 150); do
  if curl -s -o /dev/null "http://127.0.0.1:$port/"; then break; fi
  if ! kill -0 "$worker_pid" 2>/dev/null; then
    cat "$scratch/worker.log" >&2
    exit 1
  fi
  sleep 0.2
done
export EDGE_WORKER_URL="http://127.0.0.1:$port"
export EDGE_WORKER_SECRET="$secret"
export SITE_DATA_TEST_ORIGIN_PORT="$origin_port"
status=0
"$@" || status=$?
if [[ "$status" != 0 ]]; then
  echo "--- edge Worker log ---" >&2
  tail -50 "$scratch/worker.log" >&2
fi
exit "$status"
