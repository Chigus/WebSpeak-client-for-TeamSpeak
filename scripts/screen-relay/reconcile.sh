#!/bin/sh
# Install alongside committed network-config.mjs; node.json stays private.
set -eu
ROOT=${1:?Usage: reconcile.sh ABSOLUTE_RUNTIME_DIRECTORY}
case "$ROOT" in /opt/webspeak-screen-relay|/share/CACHEDEV1_DATA/DockerData/webspeak-screen-relay) ;; *) exit 1 ;; esac
if ! mkdir "$ROOT/.lock" 2>/dev/null; then
  pid=$(cat "$ROOT/.lock/pid" 2>/dev/null || true)
  case "$pid" in ''|*[!0-9]*) exit 1 ;; esac
  kill -0 "$pid" 2>/dev/null && exit 0
  rm -f "$ROOT/.lock/pid"
  rmdir "$ROOT/.lock"
  mkdir "$ROOT/.lock" 2>/dev/null || exit 0
fi
printf '%s\n' "$$" >"$ROOT/.lock/pid"
trap 'rm -f "$ROOT/.lock/pid"; rmdir "$ROOT/.lock"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
. "$ROOT/runtime.env"
docker_cmd() { "$DOCKER" --config "$DOCKER_CONFIG" "$@"; }
docker_cmd run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 96m --pids-limit 64 --tmpfs /tmp:size=8m \
  --mount "type=bind,source=$ROOT,target=/runtime" \
  --entrypoint node "$NODE_IMAGE" /runtime/network-config.mjs
# The successful restart marker survives failed/retried reconciliation.
hash=$(sha256sum "$ROOT/coturn/turnserver.conf" | awk '{print $1}')
previous=$(cat "$ROOT/applied.sha256" 2>/dev/null || true)
running=$(docker_cmd inspect webspeak-screen-relay --format '{{.State.Running}}' 2>/dev/null || true)
if [ "$hash" != "$previous" ] || [ "$running" != true ]; then
  if [ -n "$running" ]; then
    docker_cmd restart webspeak-screen-relay >/dev/null
  else
    docker_cmd run -d --name webspeak-screen-relay --restart unless-stopped --network host \
      --read-only --cap-drop ALL --security-opt no-new-privileges --memory 192m --pids-limit 64 \
      --tmpfs /tmp:size=16m --log-opt max-size=5m --log-opt max-file=2 \
      --mount "type=bind,source=$ROOT/coturn,target=/etc/webspeak-turn,readonly" \
      --entrypoint /usr/bin/turnserver \
      coturn/coturn@sha256:bbefd3e1fdfdc0d58770fe01b581fd8b00d9f3a5580d00acb77cf719a6bc78e3 \
      -c /etc/webspeak-turn/turnserver.conf >/dev/null
  fi
  printf '%s\n' "$hash" >"$ROOT/applied.sha256"
fi
