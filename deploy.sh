#!/bin/bash
# Deploy what is on origin/main.
#
#   ./deploy.sh            deploy the images CI built for origin/main
#   ./deploy.sh build      build the images on this machine and ship them instead
#   ./deploy.sh rollback   switch HTTP traffic back to the stopped slot
#
# By default production runs what GitHub Actions built: every push to main
# builds and pushes ghcr.io/naru-pub/naru-control-plane:git-<commit>-arm64
# and ghcr.io/naru-pub/naru-control-plane-jobs:git-<commit>-arm64
# (.github/workflows/main.yml). This waits for that run to succeed, then runs deploy-server.sh
# <commit> on the server, which pulls the images from the registry.
#
# `build` is the manual path, for when CI is unavailable: it builds
# naru-pub-control-plane:<commit> and naru-pub-control-plane-jobs:<commit> from
# origin/main here, ships them over ssh, and runs the same deploy-server.sh
# <commit>, which
# then finds them already loaded and pulls nothing. `mise run deploy` runs the
# default path and `mise run deploy:local` this one.
#
# Neither path compiles on the server, where a Next.js build ran the Docker VM
# out of memory under every other service on that host. Both this machine and the server are arm64, like the CI runners.
#
# The server is reached by the ssh alias in DEPLOY_HOST, so its address lives
# in ~/.ssh/config and not in this public repository:
#
#   Host naru-pub-deploy
#       HostName <the server's address>
#
# The default path is meant to work over a metered connection: this machine
# only asks GitHub for the tip of main and the run's status, and sends one ssh
# command. The images, several GB, travel from ghcr.io to the server, never
# through here. It needs gh signed in. The build path uploads the images from
# here and needs Docker running; OrbStack is started if it is not.
set -Eeuo pipefail

# Opt into web downtime only for migrations incompatible with the serving slot.
DEPLOY_DOWNTIME=${DEPLOY_DOWNTIME:-0}
case "$DEPLOY_DOWNTIME" in
  0|1) ;;
  *) echo "DEPLOY_DOWNTIME must be 0 or 1." >&2; exit 2 ;;
esac

DEPLOY_HOST=${DEPLOY_HOST:-naru-pub-deploy}
# Expanded by the server's shell, not this one.
REMOTE_DIR=${REMOTE_DIR:-'~/Git/naru-pub'}
# The repository whose workflow builds the production images.
CI_REPO=${CI_REPO:-naru-pub/naru}
CI_WORKFLOW=${CI_WORKFLOW:-main.yml}
# A checkout of its own for the build path rather than the one this script was
# run from: that one holds node_modules, .next, target and the rest of a
# working tree, and it may not be what was pushed. This one is cleaned to
# exactly the commit deployed.
BUILD_DIR=${DEPLOY_BUILD_DIR:-$HOME/.cache/naru-pub-deploy}
LOCK_DIR=$BUILD_DIR.lock

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

# A login shell, so the server's PATH has docker and zstd on it.
remote() {
  ssh "$DEPLOY_HOST" "zsh -l -c '$1'"
}

MODE=${1:-deploy}
case "$MODE" in
  deploy|build) ;;
  rollback)
    remote "$REMOTE_DIR/deploy-server.sh rollback"
    exit 0
    ;;
  *)
    echo "Usage: $0 [deploy|build|rollback]" >&2
    exit 2
    ;;
esac

mkdir -p "$(dirname "$BUILD_DIR")"
# One deploy at a time from this machine: two would share the build checkout.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Another deploy is in progress (remove $LOCK_DIR if it is not)." >&2
  exit 1
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# ls-remote rather than fetch: it reads one ref instead of downloading every
# object pushed since this checkout last fetched.
echo "Resolving origin/main..."
COMMIT="$(git -C "$SOURCE_DIR" ls-remote origin refs/heads/main | cut -f1)"
if [[ -z "$COMMIT" ]]; then
  echo "Could not read origin/main." >&2
  exit 1
fi
echo "Deploying $(git -C "$SOURCE_DIR" log -1 --format='%h %s' "$COMMIT" 2>/dev/null || echo "$COMMIT")"

# Only what has been pushed goes out, because the server checks out the same
# commit for its compose file and deploy-server.sh.
if [[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" != "$COMMIT" ]]; then
  echo "  (not this checkout's HEAD, $(git -C "$SOURCE_DIR" rev-parse --short HEAD); push first to deploy that)"
fi

# Waits for the CI run that builds $COMMIT's images and fails unless it
# succeeded. A run appears a few seconds after the push that starts it. One
# small status request every CI_POLL_SECONDS; `gh run watch` would fetch every
# job and step each time.
CI_POLL_SECONDS=${CI_POLL_SECONDS:-30}

wait_for_ci() {
  local run_id="" state

  if ! command -v gh >/dev/null; then
    echo "gh is not installed; it is needed to find the CI run." >&2
    echo "Run \`$0 build\` to build the images here instead." >&2
    exit 1
  fi

  for _ in $(seq 1 12); do
    run_id=$(gh run list --repo "$CI_REPO" --workflow "$CI_WORKFLOW" \
      --commit "$COMMIT" --event push --limit 1 \
      --json databaseId --jq '.[0].databaseId // empty')
    [[ -n "$run_id" ]] && break
    sleep 5
  done
  if [[ -z "$run_id" ]]; then
    echo "No $CI_WORKFLOW run in $CI_REPO for $COMMIT." >&2
    echo "Run \`$0 build\` to build the images here instead." >&2
    exit 1
  fi

  echo "Waiting for CI to build the images: https://github.com/$CI_REPO/actions/runs/$run_id"
  while :; do
    state=$(gh run view "$run_id" --repo "$CI_REPO" \
      --json status,conclusion --jq '.status + " " + .conclusion')
    [[ "$state" == completed* ]] && break
    sleep "$CI_POLL_SECONDS"
  done
  if [[ "$state" != "completed success" ]]; then
    echo "The CI run for $COMMIT finished with '${state#completed }', so its images may not exist." >&2
    echo "Fix and push again, rerun it, or run \`$0 build\` to build the images here." >&2
    exit 1
  fi
}

build_and_ship() {
  local control_plane_image="naru-pub-control-plane:$COMMIT"
  local jobs_image="naru-pub-control-plane-jobs:$COMMIT"

  if ! docker info >/dev/null 2>&1; then
    if command -v orb >/dev/null; then
      echo "Starting OrbStack..."
      orb start
    fi
    if ! docker info >/dev/null 2>&1; then
      echo "Docker is not running on this machine." >&2
      exit 1
    fi
  fi

  if [[ ! -d $BUILD_DIR/.git ]]; then
    git clone --quiet "$(git -C "$SOURCE_DIR" remote get-url origin)" "$BUILD_DIR"
  fi
  git -C "$BUILD_DIR" fetch --quiet origin "$COMMIT"
  git -C "$BUILD_DIR" checkout --quiet --detach "$COMMIT"
  git -C "$BUILD_DIR" clean -qffdx

  # A deploy that failed after shipping can be retried without rebuilding or
  # sending the images again.
  if remote "docker image inspect $control_plane_image $jobs_image" >/dev/null 2>&1; then
    echo "The server already has the images for $COMMIT."
    return
  fi

  # NEXT_PUBLIC_* are compiled into the client bundle, so the build needs them.
  # The server's .env stays their one source of truth; only these public
  # values are read from it. The Dockerfile's defaults apply to any it lacks.
  echo "Reading build-time settings from the server..."
  local build_args=() line value
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    value=${line#*=}
    # Compose strips the quotes .env values may carry; do the same.
    if [[ $value == \"*\" || $value == \'*\' ]]; then
      value=${value:1:${#value}-2}
    fi
    build_args+=(--build-arg "${line%%=*}=$value")
  done < <(remote "grep ^NEXT_PUBLIC_ $REMOTE_DIR/.env || true")

  # Two targets of one Dockerfile; the second reuses the first's dependency
  # install from the build cache.
  echo "Building $control_plane_image..."
  DOCKER_BUILDKIT=1 docker build \
    --platform linux/arm64 \
    --target web \
    ${build_args[@]+"${build_args[@]}"} \
    --tag "$control_plane_image" \
    "$BUILD_DIR/control-plane"

  echo "Building $jobs_image..."
  DOCKER_BUILDKIT=1 docker build \
    --platform linux/arm64 \
    --target jobs \
    ${build_args[@]+"${build_args[@]}"} \
    --tag "$jobs_image" \
    "$BUILD_DIR/control-plane"

  # One stream for both, so the layers they share are sent once.
  echo "Shipping the images to $DEPLOY_HOST..."
  docker save "$control_plane_image" "$jobs_image" \
    | zstd -T0 -3 -q \
    | remote "zstd -dcq | docker load --quiet"
}

if [[ "$MODE" == build ]]; then
  build_and_ship
else
  wait_for_ci
fi

# One ssh session for the rest. First, one-time: a server checkout from before
# deploy-server.sh existed has none to run, so bring it up to the commit being
# deployed. Every later deploy leaves moving the checkout to deploy-server.sh,
# which does it under its lock.
echo "Switching the server to $COMMIT..."
remote "test -x $REMOTE_DIR/deploy-server.sh || (cd $REMOTE_DIR && git fetch --quiet origin && git merge --ff-only --quiet $COMMIT) && DEPLOY_DOWNTIME=$DEPLOY_DOWNTIME $REMOTE_DIR/deploy-server.sh $COMMIT"

# The server has the images now, and any copies built here only existed to be
# sent there. Keeping the ones just deployed makes a retry cheap; the build
# cache that makes the next build fast is separate and stays.
if [[ "$MODE" == build ]]; then
  for repository in naru-pub-control-plane naru-pub-control-plane-jobs; do
    for tag in $(docker image ls "$repository" --format '{{.Tag}}'); do
      if [[ "$tag" != "$COMMIT" ]]; then
        docker rmi "$repository:$tag" >/dev/null 2>&1 || true
      fi
    done
  done
fi
