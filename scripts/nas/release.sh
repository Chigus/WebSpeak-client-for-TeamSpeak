#!/bin/sh
# Build and deploy one committed version. Host requirements: POSIX sh, Git,
# Docker, Compose v2 and standard tar/gzip/sha256sum/coreutils; no host Node.js.
set -eu
umask 077

APP=/share/CACHEDEV1_DATA/DockerData/webspeak
COMMIT=
HEALTH_TIMEOUT=90
STEREO_ANCHOR=24304f2d8ec4ecaa2962042dcd7b39a4bbab6851
LOCK_HELD=0
SWITCH_STARTED=0
COMPLETED=0
RELEASE=
PREVIOUS_IMAGE_ID=

usage() {
  cat <<'USAGE'
Usage: sh scripts/nas/release.sh --commit FULL_SHA [--app ABSOLUTE_APP_PATH] [--health-timeout SECONDS]

The commit must equal the clean APP/repo HEAD and retain the stereo anchor.
GIT, DOCKER and COMPOSE may each name an executable or an executable wrapper.
Arguments embedded in those variables are not supported. Runtime configuration,
credentials, data and release artifacts stay outside APP/repo.
USAGE
}

die() { printf 'Release failed: %s\n' "$*" >&2; exit 1; }
git_repo() { "$GIT" -C "$REPO" "$@"; }
docker_cmd() { "$DOCKER" --config "$APP/docker-config" "$@"; }
compose_cmd() {
  DOCKER_CONFIG="$APP/docker-config" "$COMPOSE" --project-directory "$APP" --project-name webspeak "$@"
}

require_executable() {
  case "$1" in
    */*) [ -x "$1" ] || die 'A configured executable is missing or not executable' ;;
    *) command -v "$1" >/dev/null 2>&1 || die "Required command is unavailable: $1" ;;
  esac
}

assert_checkout() {
  CHECK_HEAD=$(git_repo rev-parse --verify HEAD) || die 'Cannot read checkout HEAD'
  [ "$CHECK_HEAD" = "$COMMIT" ] || die 'Checkout HEAD changed or differs from the requested commit'
  CHECK_STATUS=$(git_repo status --porcelain --untracked-files=all) || die 'Cannot inspect the working tree'
  [ -z "$CHECK_STATUS" ] || die 'Commit or preserve working changes before releasing'
}

wait_healthy() {
  HEALTH_EXPECTED=$1
  HEALTH_NOW=$(date +%s) || return 1
  HEALTH_DEADLINE=$((HEALTH_NOW + HEALTH_TIMEOUT))
  while [ "$HEALTH_NOW" -lt "$HEALTH_DEADLINE" ]; do
    HEALTH_STATE=$(docker_cmd inspect webspeak --format '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.Image}}') || return 1
    HEALTH_NOW=$(date +%s) || return 1
    [ "$HEALTH_NOW" -lt "$HEALTH_DEADLINE" ] || return 1
    [ "$HEALTH_STATE" = "true|healthy|$HEALTH_EXPECTED" ] && return 0
    case "$HEALTH_STATE" in
      "true|starting|$HEALTH_EXPECTED") ;;
      *) return 1 ;;
    esac
    sleep 3 || return 1
    HEALTH_NOW=$(date +%s) || return 1
  done
  return 1
}

restore_previous() {
  cp "$RELEASE/compose.rollback.yaml" "$APP/.compose-restore-$RELEASE_ID.yaml" || return 1
  mv -f "$APP/.compose-restore-$RELEASE_ID.yaml" "$APP/compose.yaml" || return 1
  compose_cmd -f "$APP/compose.yaml" up -d --no-deps --no-build --pull never webspeak >>"$RELEASE/rollback.log" 2>&1 || return 1
  wait_healthy "$PREVIOUS_IMAGE_ID" >>"$RELEASE/rollback.log" 2>&1 || return 1
  if [ -f "$RELEASE/current-release.previous" ]; then
    cp "$RELEASE/current-release.previous" "$APP/.current-release-restore-$RELEASE_ID" || return 1
    mv -f "$APP/.current-release-restore-$RELEASE_ID" "$APP/current-release" || return 1
  elif [ -f "$APP/current-release" ] && [ "$(cat "$APP/current-release")" = "$RELEASE" ]; then
    rm -f "$APP/current-release" || return 1
  fi
}

finish() {
  FINISH_CODE=$?
  trap - 0 HUP INT TERM
  set +e
  if [ "$SWITCH_STARTED" -eq 1 ] && [ "$COMPLETED" -eq 0 ]; then
    printf '%s\n' rolling-back >"$RELEASE/status"
    printf 'Restoring the previous WebSpeak image; see %s/rollback.log\n' "$RELEASE" >&2
    if restore_previous; then
      printf '%s\n' rolled-back >"$RELEASE/status"
    else
      printf '%s\n' rollback-failed >"$RELEASE/status"
      printf 'Rollback needs attention; the saved configuration and image remain in %s\n' "$RELEASE" >&2
    fi
    [ "$FINISH_CODE" -ne 0 ] || FINISH_CODE=1
  elif [ "$COMPLETED" -eq 0 ] && [ -n "$RELEASE" ] && [ -d "$RELEASE" ]; then
    printf '%s\n' failed-before-switch >"$RELEASE/status"
  fi
  if [ "$LOCK_HELD" -eq 1 ]; then
    if [ "$(cat "$APP/.git-release-lock/pid" 2>/dev/null)" = "$$" ]; then
      rm -f "$APP/.git-release-lock/pid"
      rmdir "$APP/.git-release-lock" 2>/dev/null
    fi
  fi
  exit "$FINISH_CODE"
}

main() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --commit) [ "$#" -ge 2 ] || die 'Missing commit'; COMMIT=$2; shift 2 ;;
      --app) [ "$#" -ge 2 ] || die 'Missing app path'; APP=$2; shift 2 ;;
      --health-timeout) [ "$#" -ge 2 ] || die 'Missing health timeout'; HEALTH_TIMEOUT=$2; shift 2 ;;
      --help|-h) usage; exit 0 ;;
      *) usage >&2; die 'Unknown argument' ;;
    esac
  done
  case "$COMMIT" in ''|*[!0-9a-f]*) die 'Use the complete lowercase commit SHA' ;; esac
  [ "${#COMMIT}" -eq 40 ] || [ "${#COMMIT}" -eq 64 ] || die 'Commit SHA must be complete'
  case "$HEALTH_TIMEOUT" in ''|0*|*[!0-9]*) die 'Health timeout must be a decimal integer without leading zeroes' ;; esac
  [ "${#HEALTH_TIMEOUT}" -le 3 ] && [ "$HEALTH_TIMEOUT" -ge 3 ] && [ "$HEALTH_TIMEOUT" -le 600 ] || die 'Health timeout must be 3..600 seconds'
  case "$APP" in /*) ;; *) die 'App path must be absolute' ;; esac
  case "$APP" in *[!A-Za-z0-9_./\ -]*) die 'App path may contain only ASCII letters, numbers, spaces, dots, slashes, underscores and hyphens' ;; esac
  [ -d "$APP" ] || die 'The existing NAS app directory is required'
  APP=$(CDPATH= cd "$APP" && pwd -P) || die 'Cannot resolve app path'
  case "$APP" in *[!A-Za-z0-9_./\ -]*) die 'Resolved app path contains unsupported characters' ;; esac
  case "$APP" in /|/share|/share/CACHEDEV1_DATA) die 'App path is too broad' ;; esac
  REPO=$APP/repo
  [ -d "$REPO" ] && [ ! -L "$REPO" ] || die 'APP/repo must be a real checkout directory'
  REPO=$(CDPATH= cd "$REPO" && pwd -P) || die 'Cannot resolve repository path'
  [ "$REPO" = "$APP/repo" ] || die 'Checkout must resolve to APP/repo'
  if [ -z "${GIT:-}" ]; then
    if [ -x "$APP/tools/git" ]; then GIT=$APP/tools/git; else GIT=git; fi
  fi
  DOCKER=${DOCKER:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
  COMPOSE=${COMPOSE:-$APP/bin/docker-compose}
  for REQUIRED in "$GIT" "$DOCKER" "$COMPOSE" tar gzip sha256sum awk grep cmp cp mv mkdir rmdir rm date id sleep cat cut; do
    require_executable "$REQUIRED"
  done
  CHECK_ROOT=$(git_repo rev-parse --show-toplevel) || die 'APP/repo is not a Git checkout'
  [ "$CHECK_ROOT" = "$REPO" ] || die 'Unexpected Git worktree root'
  assert_checkout
  git_repo merge-base --is-ancestor "$STEREO_ANCHOR" "$COMMIT" || die 'Requested history does not retain the NAS stereo commit'
  [ -f "$APP/compose.yaml" ] && [ ! -L "$APP/compose.yaml" ] || die 'Existing regular APP/compose.yaml is required'
  for RUNTIME_DIRECTORY in data tls config docker-config releases; do
    if [ "$RUNTIME_DIRECTORY" = releases ] && [ ! -e "$APP/releases" ]; then mkdir "$APP/releases"; fi
    [ -d "$APP/$RUNTIME_DIRECTORY" ] || die "Runtime directory is missing: $RUNTIME_DIRECTORY"
    RUNTIME_RESOLVED=$(CDPATH= cd "$APP/$RUNTIME_DIRECTORY" && pwd -P) || die 'Cannot resolve a runtime directory'
    case "$RUNTIME_RESOLVED/" in "$REPO/"*) die 'Runtime files must stay outside the Git checkout' ;; esac
  done
  mkdir "$APP/.git-release-lock" 2>/dev/null || die 'Another release owns the lock; inspect its PID and status before retrying'
  LOCK_HELD=1
  printf '%s\n' "$$" >"$APP/.git-release-lock/pid"
  assert_checkout
  RELEASE_ID=$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%s' "$COMMIT" | cut -c1-12)-$$
  RELEASE=$APP/releases/$RELEASE_ID
  mkdir "$RELEASE"
  printf '%s\n' preparing >"$RELEASE/status"
  printf '%s\n' "$COMMIT" >"$RELEASE/commit"
  printf 'Preparing commit %s in %s\n' "$COMMIT" "$RELEASE"

  # Reject symlinks/submodules and private runtime material before extracting anything.
  # Read tree metadata, not private file contents; no pipefail dependency is needed.
  git_repo ls-tree -r "$COMMIT" >"$RELEASE/tree.txt"
  awk '$1 != "100644" && $1 != "100755" { exit 1 }' "$RELEASE/tree.txt" || die 'Release tree must contain ordinary files only; vendor submodule sources explicitly'
  git_repo -c core.quotePath=false ls-tree -r --name-only "$COMMIT" >"$RELEASE/paths.txt"
  while IFS= read -r SOURCE_PATH; do
    case "$SOURCE_PATH" in
      \"*|/*|../*|*/../*|*/..) die 'Unsupported or unsafe source path' ;;
      .env.example|.env.template|*/.env.example|*/.env.template) ;;
      .env|.env.*|*/.env|*/.env.*|*.pem|*.key|*.p12|*.pfx|.npmrc|*/.npmrc|config.json|*/config.json|node_modules/*|*/node_modules/*|data/*|tls/*|tls-sync/*|config/*|docker-config/*|releases/*|dist/*|web/dist/*) die 'Tracked credentials, runtime data or generated output must not enter a release archive' ;;
    esac
  done <"$RELEASE/paths.txt"
  git_repo archive --format=tar --prefix="webspeak-$COMMIT/" "$COMMIT" >"$RELEASE/source.tar"
  tar -xf "$RELEASE/source.tar" -C "$RELEASE"
  CONTEXT=$RELEASE/webspeak-$COMMIT
  [ -f "$CONTEXT/Dockerfile" ] && [ -f "$CONTEXT/LICENSE" ] && [ -f "$CONTEXT/scripts/nas/stereo-smoke.mjs" ] && [ -f "$CONTEXT/scripts/nas/validate-compose.mjs" ] || die 'Required build/release source is absent from this commit'
  grep -Eq '^[[:space:]]*RUN npm run verify([[:space:]]|$)' "$CONTEXT/Dockerfile" || die 'Dockerfile must verify the release before pruning dependencies'
  mkdir "$RELEASE/source-overlay"
  gzip -n -c "$RELEASE/source.tar" >"$RELEASE/source-overlay/webspeak-stereo-source.tar.gz"
  SOURCE_HASH=$(sha256sum "$RELEASE/source-overlay/webspeak-stereo-source.tar.gz")
  SOURCE_HASH=${SOURCE_HASH%% *}
  printf '%s  webspeak-stereo-source.tar.gz\n' "$SOURCE_HASH" >"$RELEASE/source.sha256"
  BUILD_IMAGE=webspeak-build:git-$COMMIT
  IMAGE=webspeak-local:git-$COMMIT
  printf '%s\n' building >"$RELEASE/status"
  printf 'Building and verifying Linux source; log: %s/build.log\n' "$RELEASE"
  docker_cmd build --pull=false --label "org.opencontainers.image.revision=$COMMIT" -t "$BUILD_IMAGE" "$CONTEXT" >"$RELEASE/build.log" 2>&1
  printf 'FROM %s\nCOPY --chown=node:node webspeak-stereo-source.tar.gz /app/web/dist/source/webspeak-stereo-source.tar.gz\n' "$BUILD_IMAGE" >"$RELEASE/source-overlay/Dockerfile"
  # Public source metadata is derived only from ordinary GitHub origin URLs.
  # An origin containing credentials is never copied into an image label or log.
  ORIGIN_URL=$(git_repo remote get-url origin 2>/dev/null) || ORIGIN_URL=
  SOURCE_URL=
  case "$ORIGIN_URL" in
    https://github.com/*) SOURCE_URL=${ORIGIN_URL%.git} ;;
    git@github.com:*) SOURCE_URL=https://github.com/${ORIGIN_URL#git@github.com:}; SOURCE_URL=${SOURCE_URL%.git} ;;
  esac
  case "$SOURCE_URL" in *[!A-Za-z0-9_./:-]*) SOURCE_URL= ;; esac
  set -- --pull=false --label "org.opencontainers.image.revision=$COMMIT" --label "org.opencontainers.image.licenses=AGPL-3.0-only" --label "io.webspeak.source-sha256=$SOURCE_HASH" -t "$IMAGE"
  [ -z "$SOURCE_URL" ] || set -- "$@" --label "org.opencontainers.image.source=$SOURCE_URL"
  docker_cmd build "$@" "$RELEASE/source-overlay" >>"$RELEASE/build.log" 2>&1
  IMAGE_ID=$(docker_cmd image inspect "$IMAGE" --format '{{.Id}}')
  printf '%s\n' "$IMAGE_ID" >"$RELEASE/image-id"
  printf '%s\n' "$IMAGE" >"$RELEASE/image"
  printf '%s\n' checking-codec >"$RELEASE/status"
  docker_cmd run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:size=16m --workdir /app --entrypoint node "$IMAGE_ID" --input-type=module <"$CONTEXT/scripts/nas/stereo-smoke.mjs" >"$RELEASE/stereo-check.json" 2>"$RELEASE/stereo-check.log"

  # Save the currently running image ID, not only its potentially mutable tag.
  assert_checkout
  PREVIOUS_IMAGE_ID=$(docker_cmd inspect webspeak --format '{{.Image}}')
  case "$PREVIOUS_IMAGE_ID" in sha256:*) ;; *) die 'Cannot identify the previous container image' ;; esac
  [ "${#PREVIOUS_IMAGE_ID}" -eq 71 ] || die 'Unexpected previous image ID'
  case "${PREVIOUS_IMAGE_ID#sha256:}" in *[!0-9a-f]*) die 'Unexpected previous image ID' ;; esac
  PREVIOUS_RUNNING=$(docker_cmd inspect webspeak --format '{{.State.Running}}')
  [ "$PREVIOUS_RUNNING" = true ] || die 'The previous WebSpeak container must be running for a reversible update'
  printf '%s\n' "$PREVIOUS_IMAGE_ID" >"$RELEASE/previous-image-id"
  ROLLBACK_IMAGE=webspeak-rollback:release-$RELEASE_ID
  docker_cmd image tag "$PREVIOUS_IMAGE_ID" "$ROLLBACK_IMAGE"
  printf '%s\n' "$ROLLBACK_IMAGE" >"$RELEASE/rollback-image"
  cp "$APP/compose.yaml" "$RELEASE/compose.original.yaml"
  if [ -e "$APP/current-release" ] || [ -L "$APP/current-release" ]; then
    [ -f "$APP/current-release" ] && [ ! -L "$APP/current-release" ] || die 'Current release record must be a regular file'
    cp "$APP/current-release" "$RELEASE/current-release.previous"
  fi
  printf 'services:\n  webspeak:\n    image: %s\n' "$IMAGE" >"$RELEASE/image.override.yaml"
  printf 'services:\n  webspeak:\n    image: %s\n' "$ROLLBACK_IMAGE" >"$RELEASE/rollback.override.yaml"
  compose_cmd -f "$APP/compose.yaml" config --format json >"$RELEASE/compose.before.json"
  compose_cmd -f "$APP/compose.yaml" -f "$RELEASE/image.override.yaml" config >"$RELEASE/compose.candidate.yaml"
  compose_cmd -f "$APP/compose.yaml" -f "$RELEASE/rollback.override.yaml" config >"$RELEASE/compose.rollback.yaml"
  compose_cmd -f "$RELEASE/compose.candidate.yaml" config --format json >"$RELEASE/compose.candidate.json"
  compose_cmd -f "$RELEASE/compose.rollback.yaml" config --format json >"$RELEASE/compose.rollback.json"
  docker_cmd run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user "$(id -u):$(id -g)" --mount "type=bind,source=$RELEASE,target=/release,readonly" --env "WEBSPEAK_APP_ROOT=$APP" --env "WEBSPEAK_CANDIDATE_IMAGE=$IMAGE" --env "WEBSPEAK_ROLLBACK_IMAGE=$ROLLBACK_IMAGE" --tmpfs /tmp:size=16m --entrypoint node "$IMAGE_ID" --input-type=module <"$CONTEXT/scripts/nas/validate-compose.mjs" >"$RELEASE/compose-check.json" 2>"$RELEASE/compose-check.log"
  compose_cmd -f "$RELEASE/compose.candidate.yaml" config --quiet
  compose_cmd -f "$RELEASE/compose.rollback.yaml" config --quiet
  assert_checkout
  cmp -s "$APP/compose.yaml" "$RELEASE/compose.original.yaml" || die 'Runtime configuration changed while preparing the release'
  CURRENT_IMAGE_ID=$(docker_cmd inspect webspeak --format '{{.Image}}')
  [ "$CURRENT_IMAGE_ID" = "$PREVIOUS_IMAGE_ID" ] || die 'Another operation replaced WebSpeak during release preparation'

  printf '%s\n' switching >"$RELEASE/status"
  SWITCH_STARTED=1
  cp "$RELEASE/compose.candidate.yaml" "$APP/.compose-next-$RELEASE_ID.yaml"
  mv -f "$APP/.compose-next-$RELEASE_ID.yaml" "$APP/compose.yaml"
  printf 'Switching only the WebSpeak service; log: %s/deploy.log\n' "$RELEASE"
  compose_cmd -f "$APP/compose.yaml" up -d --no-deps --no-build --pull never webspeak >"$RELEASE/deploy.log" 2>&1
  wait_healthy "$IMAGE_ID" >>"$RELEASE/deploy.log" 2>&1 || die 'New image did not become healthy'
  printf '{"commit":"%s","image":"%s","imageId":"%s","previousImageId":"%s","sourceSha256":"%s","containerHealth":"healthy","publicVerification":"required"}\n' "$COMMIT" "$IMAGE" "$IMAGE_ID" "$PREVIOUS_IMAGE_ID" "$SOURCE_HASH" >"$RELEASE/release.json"
  printf '%s\n' deployed-healthy-awaiting-public-check >"$RELEASE/status"
  printf '%s\n' "$RELEASE" >"$APP/.current-release-$RELEASE_ID"
  mv -f "$APP/.current-release-$RELEASE_ID" "$APP/current-release"
  COMPLETED=1
  printf 'Deployed commit %s; container is healthy. Verify public HTTPS/WSS, TeamSpeak and source SHA256 separately.\nRecord: %s/release.json\n' "$COMMIT" "$RELEASE"
}

trap finish 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
main "$@"
