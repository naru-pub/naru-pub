#!/usr/bin/env bash
# Runs the two control-plane images against a fresh PostgreSQL, as a deploy
# would, to catch what only fails when they run: a file the standalone build
# did not trace, a dependency the jobs image did not install, a CLI bundle that
# does not start. CI runs it on the images it just pushed; locally:
#
#   docker build --target web -t naru-web control-plane
#   docker build --target jobs -t naru-jobs control-plane
#   control-plane/scripts/smoke-test-images.sh naru-web naru-jobs
#
# Everything it starts is named after this run and removed on exit.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <web image> <jobs image>" >&2
  exit 2
fi
web_image=$1
jobs_image=$2

run=naru-smoke-$$
database_url="postgres://postgres:smoke@$run-db:5432/naru"
started=()

cleanup() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    for container in ${started[@]+"${started[@]}"}; do
      echo "--- $container logs" >&2
      docker logs --tail 50 "$container" >&2 || true
    done
  fi
  [[ ${#started[@]} -eq 0 ]] || docker rm -f "${started[@]}" >/dev/null 2>&1 || true
  docker network rm "$run" >/dev/null 2>&1 || true
}
trap cleanup EXIT

start() {
  local name=$run-$1
  shift
  docker run -d --name "$name" --network "$run" "$@" >/dev/null
  started+=("$name")
}

# Retries a command once a second until it succeeds or the time is up.
wait_for() {
  local description=$1 seconds=$2
  shift 2
  for _ in $(seq 1 "$seconds"); do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for $description." >&2
  return 1
}

docker network create "$run" >/dev/null

echo "Starting PostgreSQL..."
# The major version production runs, so a migration that needs it fails here
# first. The Debian image, whose PostgreSQL apt repository has the extensions
# the migrations create; they need no restart, only their files.
start db -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=naru postgres:18
wait_for PostgreSQL 60 docker exec "$run-db" pg_isready -U postgres -d naru
docker exec "$run-db" sh -c 'apt-get update -qq && apt-get install -qq --yes --no-install-recommends "postgresql-$PG_MAJOR-hll"' >/dev/null

echo "Migrating, twice: the second run must find nothing to do..."
for _ in 1 2; do
  docker run --rm --network "$run" -e DATABASE_URL="$database_url" \
    "$jobs_image" node dist/cli/migrate.mjs
done

echo "Starting the web server..."
start web -e DATABASE_URL="$database_url" "$web_image"
# The same check docker-compose.yml uses.
wait_for "the web server to become healthy" 60 docker exec "$run-web" node -e \
  "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

echo "Requesting pages, SDK files and assets..."
docker exec "$run-web" node -e '
const base = "http://127.0.0.1:3000";
const expect = async (path, type) => {
  const response = await fetch(base + path);
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.startsWith(type)) {
    throw new Error(`${path}: ${response.status} ${contentType}`);
  }
  console.log(`  ${path} ${response.status}`);
  return response;
};
(async () => {
  await expect("/", "text/html");
  const login = await (await expect("/login", "text/html")).text();
  const chunk = login.match(/\/_next\/static\/[^"]+\.js/);
  if (!chunk) throw new Error("/login references no /_next/static script");
  await expect(chunk[0], "application/javascript");
  await expect("/sdk/1/naru.js", "application/javascript");
  await expect("/sdk/1.0.0/naru.d.ts", "text/plain");
  await expect("/logo.png", "image/png");
  await expect("/docs/database/blog.zip", "application/zip");
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
'

echo "Starting durable workers..."
# Enqueue a harmless empty screenshot sweep to exercise the compiled child CLI
# adapter as well as worker startup; pg_cron itself is tested separately.
docker exec "$run-db" psql -U postgres -d naru -c "select absurd.spawn_task('maintenance', 'maintenance-job-v1', '{\"name\":\"screenshot-updater\"}'::jsonb);" >/dev/null
start worker -e DATABASE_URL="$database_url" "$jobs_image" node dist/cli/worker.mjs
wait_for "maintenance screenshot sweep" 60 sh -c \
  "docker logs '$run-worker' 2>&1 | grep -q 'maintenance-worker.*update-screenshots.tsx completed'"

wait_for "payment worker startup" 20 sh -c \
  "docker logs '$run-worker' 2>&1 | grep -q 'payments-worker.*Started'"
echo "Checking graceful worker shutdown..."
docker stop --timeout 20 "$run-worker" >/dev/null
if [[ "$(docker inspect -f '{{.State.ExitCode}}' "$run-worker")" != 0 ]]; then
  echo "Worker did not exit cleanly on SIGTERM." >&2
  exit 1
fi
if ! docker logs "$run-worker" 2>&1 | grep -q 'Database connections closed'; then
  echo "Worker did not finish closing its database connections." >&2
  exit 1
fi

if ! docker logs "$run-worker" 2>&1 | grep -q 'payments-worker.*Drained'; then
  echo "Worker did not drain its payment tasks." >&2
  exit 1
fi

if ! docker logs "$run-worker" 2>&1 | grep -q 'maintenance-worker.*Drained'; then
  echo "Worker did not drain its maintenance tasks." >&2
  exit 1
fi

echo "Launching Chromium from the jobs image..."
docker run --rm "$jobs_image" node -e '
import("playwright").then(async ({ chromium }) => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  const page = await browser.newPage();
  await page.setContent("<h1>나루 😀</h1>");
  await page.screenshot();
  await browser.close();
});
'

echo "Smoke test passed."
