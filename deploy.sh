#!/bin/bash
set -Eeuo pipefail

export PATH="$HOME/.orbstack/bin:$PATH"

cd "$(dirname "$0")"

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

upstream naru_control_plane {
    server control-plane-$slot:3000;
    keepalive 32;
}

upstream naru_site_proxy {
    server proxy-$slot:5000;
    keepalive 32;
}

server {
    listen 3000;
    client_max_body_size 0;

    location / {
        proxy_pass http://naru_control_plane;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$naru_forwarded_proto;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$naru_connection_upgrade;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
    }
}

server {
    listen 5000;
    client_max_body_size 0;

    location / {
        proxy_pass http://naru_site_proxy;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$naru_forwarded_proto;
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

  if docker compose ps --status running --services | grep -qx gateway; then
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

rollback() {
  local current target
  current=$(active_slot)
  if [[ "$current" == none ]]; then
    echo "No previous blue-green deployment is available." >&2
    exit 1
  fi
  target=$(other_slot "$current")
  wait_for_healthy "control-plane-$target"
  wait_for_healthy "proxy-$target"
  switch_gateway "$target"
  echo "Traffic rolled back from $current to $target."
}

if [[ "${BASH_SOURCE[0]:-$0}" != "$0" ]]; then
  return 0
fi

if [[ "${1:-deploy}" == rollback ]]; then
  rollback
  exit 0
fi
if [[ "${1:-deploy}" != deploy ]]; then
  echo "Usage: $0 [deploy|rollback]" >&2
  exit 2
fi

current=$(active_slot)
target=$(other_slot "$current")
control_plane_service="control-plane-$target"
proxy_service="proxy-$target"

echo "Pulling latest changes..."
git pull --ff-only

echo "Building the $target slot while $current continues serving traffic..."
docker compose build "$control_plane_service" "$proxy_service"

echo "Running backward-compatible migrations..."
docker compose run --rm --no-deps "$control_plane_service" pnpm migrate

echo "Starting and checking the $target slot..."
docker compose up -d --no-deps --force-recreate "$control_plane_service" "$proxy_service"
wait_for_healthy "$control_plane_service"
wait_for_healthy "$proxy_service"

echo "Switching traffic to the $target slot..."
switch_gateway "$target"

echo "Updating background processes..."
docker compose up -d --no-deps --force-recreate cron worker

echo "Deployment complete. Active slot: $target (previous slot: $current)."
if [[ "$current" != none ]]; then
  echo "Run ./deploy.sh rollback to switch HTTP traffic back before the next deployment."
else
  echo "The first rollback slot will become available after the next deployment."
fi
