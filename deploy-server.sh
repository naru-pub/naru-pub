#!/bin/bash
# The server half of a deploy, blue/green. deploy.sh runs this over ssh, and it
# can also be run here directly:
#
#   ./deploy-server.sh <commit>
#   ./deploy-server.sh rollback
#
# It deploys naru-pub-control-plane:<commit> (the Next.js server) and
# naru-pub-control-plane-jobs:<commit> (worker and migrations). Hosted sites
# are served by the edge Worker (edge/), not from here. When `deploy.sh build`
# has already loaded them,
# those are used. Otherwise they are pulled from the images GitHub Actions
# built for <commit>:
#
#   ghcr.io/naru-pub/naru-control-plane:git-<commit>-arm64
#   ghcr.io/naru-pub/naru-control-plane-jobs:git-<commit>-arm64
#
# Nothing is compiled here. The builds used to run on this machine, where a
# Next.js build ran the Docker VM out of memory while
# the live slot, and every other service on this host, was sharing it.
set -Eeuo pipefail

export PATH="$HOME/.orbstack/bin:$PATH"

cd "$(dirname "$0")"

DEPLOY_DOWNTIME=${DEPLOY_DOWNTIME:-0}
case "$DEPLOY_DOWNTIME" in
  0|1) ;;
  *) echo "DEPLOY_DOWNTIME must be 0 or 1." >&2; exit 2 ;;
esac

STATE_DIR=.deploy-state
NGINX_DIR="$STATE_DIR/nginx"
ACTIVE_FILE="$STATE_DIR/active-slot"
mkdir -p "$NGINX_DIR"

active_slot() {
  if [[ -f "$ACTIVE_FILE" ]]; then
    cat "$ACTIVE_FILE"
  else
    printf 'none'
  fi
}

other_slot() {
  case "$1" in
    blue) printf 'green' ;;
    green) printf 'blue' ;;
    none) printf 'blue' ;;
    *) echo "Invalid active slot: $1" >&2; exit 1 ;;
  esac
}

render_gateway_config() {
  local slot=$1
  local destination=$2

  cat > "$destination" <<EOF
map \$http_x_forwarded_proto \$naru_forwarded_proto {
    default \$http_x_forwarded_proto;
    ""      \$scheme;
}

map \$http_upgrade \$naru_connection_upgrade {
    default upgrade;
    ""      "";
}

# The site database API is the one control-plane surface a stranger can drive at
# will: it is public, CORS-open, and every request costs a PostgreSQL round trip
# on the pool the whole control plane shares. These buckets keep a burst against
# one site from becoming a sign-in outage for everyone else. Per-client, so a
# busy site with many real visitors is unaffected.
#
# Every request reaches this gateway through the Cloudflare Tunnel running on the
# host, so the peer address is the tunnel, identical for the whole internet. A
# limit keyed on it would be one bucket for every visitor at once — which is not
# a rate limit, it is an outage waiting for a busy afternoon.
#
# The real address is recovered per server block (see below), so these zones key
# on the visitor rather than on the tunnel every request shares.
#
# The gateway overwrites CF-Connecting-IP before proxying to the application.
# This gives the database write limiter the same verified address while making
# a value supplied by an internet client irrelevant.
limit_req_zone \$binary_remote_addr zone=naru_data:16m rate=30r/s;
limit_req_zone \$binary_remote_addr zone=naru_data_auth:8m rate=2r/s;
limit_req_status 429;
limit_conn_zone \$binary_remote_addr zone=naru_conn:16m;
limit_conn_status 429;

# Docker assigns a new address whenever a blue/green container is recreated.
# Resolve upstream names through Docker's embedded DNS at runtime so the
# long-lived gateway never keeps sending traffic to a recycled container IP.
resolver 127.0.0.11 ipv6=off valid=10s;

upstream naru_control_plane {
    zone naru_control_plane 64k;
    server control-plane-$slot:3000 resolve;
    keepalive 32;
}

server {
    listen 3000;
    client_max_body_size 0;

    # Recover the visitor's address before the limits below are keyed on it.
    # Trusted only when the peer is the private tunnel address: cloudflared
    # connects outbound and these ports are not routable from off the host's
    # network, so an internet caller cannot supply this header themselves.
    # real_ip runs before limit_req, so \$binary_remote_addr
    # is already the visitor by the time a bucket is chosen.
    set_real_ip_from 10.0.0.0/8;
    set_real_ip_from 172.16.0.0/12;
    set_real_ip_from 192.168.0.0/16;
    set_real_ip_from 127.0.0.0/8;
    set_real_ip_from ::1/128;
    set_real_ip_from fd00::/8;
    # CF-Connecting-IP does not survive this tunnel; X-Forwarded-For does, and
    # recursion walks it right to left past trusted hops so a value a client
    # prepended itself cannot win.
    real_ip_header X-Forwarded-For;
    real_ip_recursive on;

    # A document is capped at 64 KiB and the largest body the data API accepts
    # is one batch of them, so nothing on these routes needs megabytes.
    location /api/data/ {
        limit_req zone=naru_data burst=60 nodelay;
        limit_conn naru_conn 24;
        client_max_body_size 1m;
        proxy_pass http://naru_control_plane;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header CF-Connecting-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$naru_forwarded_proto;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
        proxy_buffering off;
    }

    # Sign-in is a human action a few times a day, never a page-load cost, so
    # this can be far tighter than the data API. Token exchange and revocation
    # both live here, and both are worth bounding against guessing.
    location /api/data-auth/ {
        limit_req zone=naru_data_auth burst=10 nodelay;
        limit_conn naru_conn 24;
        client_max_body_size 64k;
        proxy_pass http://naru_control_plane;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header CF-Connecting-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$naru_forwarded_proto;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
        proxy_buffering off;
    }

    # A saved file is capped at 10 MiB, which JSON escaping can at most about
    # double; the cap stops Node from parsing a body it will reject anyway.
    location = /api/files/save {
        client_max_body_size 25m;
        proxy_pass http://naru_control_plane;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header CF-Connecting-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$naru_forwarded_proto;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
    }

    # One upload request carries every selected file, each capped at 10 MiB,
    # so this matches Cloudflare's own request limit rather than one file.
    location /api/files/ {
        client_max_body_size 100m;
        proxy_pass http://naru_control_plane;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header CF-Connecting-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$naru_forwarded_proto;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
    }

    location / {
        proxy_pass http://naru_control_plane;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header CF-Connecting-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$naru_forwarded_proto;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$naru_connection_upgrade;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
    }
}
EOF
}

wait_for_healthy() {
  local service=$1
  local container_id
  local status

  container_id=$(docker compose ps -q "$service")
  if [[ -z "$container_id" ]]; then
    echo "$service did not start." >&2
    return 1
  fi

  for _ in $(seq 1 60); do
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")
    case "$status" in
      healthy) return 0 ;;
      unhealthy|exited|dead)
        docker compose logs --tail=100 "$service" >&2
        return 1
        ;;
    esac
    sleep 1
  done

  echo "$service did not become healthy within 60 seconds." >&2
  docker compose logs --tail=100 "$service" >&2
  return 1
}

switch_gateway() {
  local slot=$1
  local config="$NGINX_DIR/default.conf"
  local next_config="$STATE_DIR/default.conf.next"
  local previous_config="$STATE_DIR/default.conf.previous"

  render_gateway_config "$slot" "$next_config"
  if [[ -f "$config" ]]; then
    cp "$config" "$previous_config"
  fi
  cp "$next_config" "$config"

  # The gateway bind-mounts $NGINX_DIR by the absolute path it had when it was
  # created, so after this directory moves it would keep reading the old one.
  # Recreating it then costs a moment of control-plane requests.
  local mounted
  mounted=$(docker inspect naru-pub-gateway \
    --format '{{range .Mounts}}{{if eq .Destination "/etc/nginx/conf.d"}}{{.Source}}{{end}}{{end}}' \
    2>/dev/null || true)

  if [[ -n "$mounted" && "$mounted" != "$PWD/$NGINX_DIR" ]]; then
    echo "The gateway reads $mounted, not $PWD/$NGINX_DIR; recreating it..."
    docker compose up -d --no-deps --force-recreate gateway
    if ! wait_for_healthy gateway; then
      [[ -f "$previous_config" ]] && cp "$previous_config" "$config"
      return 1
    fi
  elif docker compose ps --status running --services | grep -qx gateway; then
    if ! docker compose exec -T gateway nginx -t; then
      [[ -f "$previous_config" ]] && cp "$previous_config" "$config"
      return 1
    fi
    docker compose exec -T gateway nginx -s reload
  else
    # The first blue-green deployment replaces the two legacy containers that
    # own the public ports. Every later deployment keeps the gateway running.
    docker compose pull gateway
    docker compose create gateway
    docker rm -f naru-pub-control-plane naru-pub-proxy 2>/dev/null || true
    docker compose start gateway
    wait_for_healthy gateway
  fi

  printf '%s\n' "$slot" > "$ACTIVE_FILE"
  rm -f "$next_config" "$previous_config"
}

# After a reload, nginx keeps its old workers until their requests finish, and
# those requests are still going to the slot traffic just left. Stopping that
# slot is safe once they are gone. The wait is bounded because a long upload or
# a held-open connection could keep an old worker for the full 300s timeout;
# anything still running then is cut, as it would be by the next deploy anyway.
DRAIN_TIMEOUT_SECONDS=${DRAIN_TIMEOUT_SECONDS:-120}

stop_slot() {
  local slot=$1

  echo "Waiting for requests to the $slot slot to finish..."
  for _ in $(seq 1 "$DRAIN_TIMEOUT_SECONDS"); do
    if [[ "$(docker compose exec -T gateway ps -o args 2>/dev/null)" != *"shutting down"* ]]; then
      break
    fi
    sleep 1
  done

  # A stopped slot costs no memory. Its containers are kept, so a rollback
  # starts them again rather than rebuilding.
  echo "Stopping the $slot slot..."
  docker compose stop "control-plane-$slot"
}

rollback() {
  local current target
  current=$(active_slot)
  if [[ "$current" == none ]]; then
    echo "No previous blue-green deployment is available." >&2
    exit 1
  fi
  target=$(other_slot "$current")
  if [[ -z "$(docker compose ps -a -q "control-plane-$target")" ]]; then
    echo "The $target slot has no containers to roll back to." >&2
    exit 1
  fi
  docker compose start "control-plane-$target"
  wait_for_healthy "control-plane-$target"
  switch_gateway "$target"
  stop_slot "$current"
  echo "Traffic rolled back from $current to $target."
}

if [[ "${BASH_SOURCE[0]:-$0}" != "$0" ]]; then
  return 0
fi

usage() {
  echo "Usage: $0 <commit> | rollback" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage

LOCK_DIR=.deploy.lock

# One deploy or rollback at a time. Taken before the release files are
# replaced, because that is itself a change to the machine. The restart below
# keeps the lock: bash runs no EXIT trap on exec, and NARU_DEPLOY_LOCK_HELD
# tells the new process that it already holds it.
if [[ -z "${NARU_DEPLOY_LOCK_HELD:-}" ]] && ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Another deploy is in progress (remove $LOCK_DIR if it is not)." >&2
  exit 1
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

if [[ "$1" == rollback ]]; then
  rollback
  exit 0
fi

COMMIT=$1
CONTROL_PLANE_IMAGE="naru-pub-control-plane:$COMMIT"
JOBS_IMAGE="naru-pub-control-plane-jobs:$COMMIT"

# The images were built from <commit>, and the Compose topology and this script
# have to agree with them. This directory is not a git checkout: it holds .env,
# .deploy-state/ and the two files below, fetched from GitHub as committed at
# exactly <commit> (the repository is public). Each is swapped in with mv, so
# this running copy keeps reading the file it opened, then the script starts
# over from the new copy before reading any of it.
SOURCE_REPO=${SOURCE_REPO:-naru-pub/naru}
RELEASE_FILES=(deploy-server.sh docker-compose.yml)
COMMIT_FILE="$STATE_DIR/commit"

if [[ "${NARU_DEPLOY_AFTER_PULL:-0}" != 1 ]]; then
  # Refuse to go backwards, as a fast-forward of a checkout did: only a commit
  # that contains the one last deployed. A server that still has its git
  # checkout from before says what it was at.
  deployed=$(cat "$COMMIT_FILE" 2>/dev/null || git rev-parse HEAD 2>/dev/null || true)
  if [[ -n "$deployed" && "$deployed" != "$COMMIT" ]]; then
    relation=$(curl -fsSL --retry 3 \
      "https://api.github.com/repos/$SOURCE_REPO/compare/$deployed...$COMMIT?per_page=1" \
      | jq -r .status) || relation=unknown
    if [[ "$relation" != ahead ]]; then
      echo "$COMMIT is not ahead of the deployed ${deployed:0:7} (GitHub says '$relation');" >&2
      echo "refusing to put an older release live. Use rollback instead." >&2
      exit 1
    fi
  fi

  echo "Fetching ${RELEASE_FILES[*]} at $COMMIT..."
  rm -rf .deploy-incoming
  mkdir .deploy-incoming
  for file in "${RELEASE_FILES[@]}"; do
    if ! curl -fsSL --retry 3 -o ".deploy-incoming/$file" \
      "https://raw.githubusercontent.com/$SOURCE_REPO/$COMMIT/$file"; then
      echo "Could not fetch $file at $COMMIT from $SOURCE_REPO." >&2
      exit 1
    fi
  done
  chmod +x .deploy-incoming/deploy-server.sh
  for file in "${RELEASE_FILES[@]}"; do
    mv ".deploy-incoming/$file" "$file"
  done
  rmdir .deploy-incoming
  exec env NARU_DEPLOY_AFTER_PULL=1 NARU_DEPLOY_LOCK_HELD=1 "$0" "$@"
fi
# What the files here are now from. Written here rather than above so that the
# first deploy, which the previous script started by moving its checkout, also
# records it.
printf '%s\n' "$COMMIT" > "$COMMIT_FILE"

# Where CI pushes the images for each commit on main (.github/workflows/main.yml).
IMAGE_REGISTRY=${IMAGE_REGISTRY:-ghcr.io/naru-pub/naru}
# The packages are private, so this pulls with the `docker login ghcr.io` in
# ~/.docker/config.json. That login has to be kept in the file, not the macOS
# keychain, which the ssh session deploy.sh runs this in cannot open; see
# docs/deployment.md.

REPOSITORIES=(naru-pub-control-plane naru-pub-control-plane-jobs)

# Pulled under the registry name, then renamed to the local one, so everything
# below and the cleanup at the end only ever see naru-pub-*:<commit> and
# naru-pub-*:current. An image `deploy.sh build` shipped is used as is.
for repository in "${REPOSITORIES[@]}"; do
  image="$repository:$COMMIT"
  if docker image inspect "$image" >/dev/null 2>&1; then
    continue
  fi
  remote_image="$IMAGE_REGISTRY-${repository#naru-pub-}:git-$COMMIT-arm64"
  echo "Pulling $remote_image..."
  if ! docker pull --quiet --platform linux/arm64 "$remote_image" >/dev/null; then
    echo "Could not pull $remote_image. Check that CI built it and that this" >&2
    echo "machine's ghcr.io login can read it, or deploy with \`deploy.sh build\`." >&2
    exit 1
  fi
  docker tag "$remote_image" "$image"
  docker rmi "$remote_image" >/dev/null
done

current=$(active_slot)
target=$(other_slot "$current")
control_plane_service="control-plane-$target"

# Every service is declared with the :current tags. Moving them does not touch
# the running containers: a container holds the image it was created from, not
# the name, which is also what keeps the stopped slot able to roll back.
docker tag "$CONTROL_PLANE_IMAGE" naru-pub-control-plane:current
docker tag "$JOBS_IMAGE" naru-pub-control-plane-jobs:current

# Remove the retired hosted-site proxy, which the edge Worker replaced, and
# its images. Neither slot's container is declared in Compose any more.
for service in proxy-blue proxy-green; do
  retired_proxy=$(docker ps -aq --filter label=com.docker.compose.project=naru-pub --filter "label=com.docker.compose.service=$service")
  if [[ -n "$retired_proxy" ]]; then
    docker rm -f $retired_proxy >/dev/null
  fi
done
for tag in $(docker image ls naru-pub-proxy --format '{{.Tag}}'); do
  docker rmi "naru-pub-proxy:$tag" >/dev/null 2>&1 || true
done

# Stop and remove the retired scheduler from older releases. It is no longer
# declared in Compose; do not let it overlap the durable maintenance worker.
retired_cron=$(docker ps -aq --filter label=com.docker.compose.project=naru-pub --filter label=com.docker.compose.service=cron)
if [[ -n "$retired_cron" ]]; then
  docker stop --timeout 300 $retired_cron
  docker rm $retired_cron
fi

# Ordinary releases keep the active HTTP slot serving until its replacement
# passes health checks. Breaking migrations explicitly opt into a full cutover.
case "$DEPLOY_DOWNTIME" in
  0)
    echo "Keeping the active web slot serving; stopping background processes before migrations..."
    docker compose stop --timeout 300 worker
    ;;
  1)
    echo "Stopping application and background processes for a breaking schema cutover..."
    docker compose stop --timeout 300 control-plane-blue control-plane-green worker
    ;;
  *) echo "DEPLOY_DOWNTIME must be 0 or 1." >&2; exit 2 ;;
esac

echo "Running migrations..."
# In the jobs image, through the worker service's settings: the web image is only
# the Next.js server and has no migrations.
docker compose run --rm --no-deps worker node dist/cli/migrate.mjs

echo "Configuring pg_cron schedules..."
docker compose run --rm --no-deps worker node dist/cli/configure-schedules.mjs

echo "Starting and checking the $target slot..."
docker compose up -d --no-deps --force-recreate "$control_plane_service"
wait_for_healthy "$control_plane_service"

echo "Switching traffic to the $target slot..."
switch_gateway "$target"

echo "Updating background processes..."
docker compose up -d --no-deps --force-recreate worker

if [[ "$current" != none ]]; then
  stop_slot "$current"
fi

# Nothing else removes old releases. docker refuses to remove the last tag of
# an image a container still uses, so the stopped slot's image stays for a
# rollback until the next deploy recreates that slot. `latest` is what
# `docker compose build` tagged before images were built elsewhere.
echo "Removing old release images..."
for repository in "${REPOSITORIES[@]}"; do
  for tag in $(docker image ls "$repository" --format '{{.Tag}}'); do
    if [[ "$tag" != current && "$tag" != "$COMMIT" ]]; then
      docker rmi "$repository:$tag" >/dev/null 2>&1 || true
    fi
  done
done

echo "Deployment complete. Active slot: $target (previous slot: $current)."
if [[ "$current" != none ]]; then
  echo "The $current slot is stopped; ./deploy.sh rollback starts it and switches HTTP traffic back."
else
  echo "The first rollback slot will become available after the next deployment."
fi
