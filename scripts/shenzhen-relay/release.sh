#!/bin/sh
# Run from an extracted `git archive` of a reviewed, committed release.
# The source and credentials remain separate; no Docker socket is in a container.
set -eu
umask 077
ROOT=${RELAY_ROOT:-/opt/webspeak-relay}
COMMIT=${1:?Usage: sh release.sh FULL_COMMIT_SHA}
case "$COMMIT" in *[!0-9a-f]*|'') exit 1 ;; esac
[ "${#COMMIT}" = 40 ] || exit 1
[ "$ROOT" = /opt/webspeak-relay ] || { printf '%s\n' 'Unexpected relay root.' >&2; exit 1; }
SOURCE="$ROOT/releases/$COMMIT"
CONFIG="$SOURCE/scripts/shenzhen-relay"
[ "$(cat "$SOURCE/COMMIT")" = "$COMMIT" ] || exit 1
[ -s "$CONFIG/nginx.conf.template" ] && [ -s "$CONFIG/start-nginx.sh" ] || exit 1
[ -f "$ROOT/runtime.env" ] && [ -s "$ROOT/credentials/cloudflare.ini" ] || exit 1
. "$ROOT/runtime.env"
: "${NGINX_IMAGE:?}" "${CERTBOT_IMAGE:?}" "${RELAY_HOST:?}" "${UPSTREAM_HOST:?}" "${BIND_IP:?}"
for image in "$NGINX_IMAGE" "$CERTBOT_IMAGE"; do
    case "$image" in *@sha256:*) ;; *) exit 1 ;; esac
    digest=${image##*@sha256:}
    case "$digest" in *[!0-9a-f]*) exit 1 ;; esac
    [ "${#digest}" = 64 ] || exit 1
done
[ -s "$ROOT/acme/live/$RELAY_HOST/fullchain.pem" ] || exit 1
NAME=webspeak-shenzhen-relay
RENEWER=webspeak-shenzhen-cert-renew
BACKUP="$NAME-rollback-$(date +%s)"
RENEW_BACKUP="$RENEWER-rollback-$(date +%s)"
HAD_PREVIOUS=0
HAD_PREVIOUS_RENEWER=0
NEW_CREATED=0
NEW_RENEWER_CREATED=0
SUCCESS=0
docker image inspect "$NGINX_IMAGE" >/dev/null
docker image inspect "$CERTBOT_IMAGE" >/dev/null
mkdir "$ROOT/.release-lock" || { printf '%s\n' 'Another relay release is active.' >&2; exit 1; }

rollback() {
    code=$?
    trap - EXIT HUP INT TERM
    if [ "$SUCCESS" = 0 ]; then
        [ "$NEW_RENEWER_CREATED" = 0 ] || docker rm -f "$RENEWER" >/dev/null 2>&1 || true
        if [ "$HAD_PREVIOUS_RENEWER" = 1 ]; then
            docker rename "$RENEW_BACKUP" "$RENEWER" >/dev/null 2>&1 || true
            docker start "$RENEWER" >/dev/null 2>&1 || true
        fi
        [ "$NEW_CREATED" = 0 ] || docker rm -f "$NAME" >/dev/null 2>&1 || true
        if [ "$HAD_PREVIOUS" = 1 ]; then
            docker rename "$BACKUP" "$NAME" >/dev/null 2>&1 || true
            docker start "$NAME" >/dev/null 2>&1 || true
        fi
    fi
    rmdir "$ROOT/.release-lock" 2>/dev/null || true
    exit "$code"
}
trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Test the exact configuration/image/certificate before stopping a previous relay.
docker run --rm --read-only --tmpfs /tmp:size=32m,mode=1777 --network bridge \
    --security-opt no-new-privileges:true --dns 223.5.5.5 --dns 119.29.29.29 \
    -e RELAY_HOST="$RELAY_HOST" -e UPSTREAM_HOST="$UPSTREAM_HOST" \
    -v "$CONFIG:/relay:ro" -v "$ROOT/acme/live:/acme/live:ro" \
    -v "$ROOT/acme/archive:/acme/archive:ro" --entrypoint sh "$NGINX_IMAGE" -c '
      envsubst '\''${RELAY_HOST} ${UPSTREAM_HOST}'\'' < /relay/nginx.conf.template > /tmp/nginx.conf
      mkdir -p /tmp/webspeak-tls /tmp/nginx/client_body /tmp/nginx/proxy /tmp/nginx/fastcgi /tmp/nginx/uwsgi /tmp/nginx/scgi
      cp "/acme/live/$RELAY_HOST/fullchain.pem" "/acme/live/$RELAY_HOST/privkey.pem" /tmp/webspeak-tls/
      nginx -t -q -c /tmp/nginx.conf'

if docker inspect "$NAME" >/dev/null 2>&1; then
    [ "$(docker inspect "$NAME" --format '{{index .Config.Labels "io.webspeak.role"}}')" = shenzhen-relay ] || exit 1
    docker rename "$NAME" "$BACKUP"
    HAD_PREVIOUS=1
    docker stop -t 20 "$BACKUP" >/dev/null
fi
docker create --name "$NAME" --restart unless-stopped \
    --label io.webspeak.role=shenzhen-relay --label "org.opencontainers.image.revision=$COMMIT" \
    --read-only --security-opt no-new-privileges:true --tmpfs /tmp:size=32m,mode=1777 \
    --memory 128m --pids-limit 64 --network bridge --dns 223.5.5.5 --dns 119.29.29.29 \
    --log-driver json-file --log-opt max-size=2m --log-opt max-file=2 \
    -p "$BIND_IP:15555:15555/tcp" -p "$BIND_IP:19987:19987/udp" \
    -e RELAY_HOST="$RELAY_HOST" -e UPSTREAM_HOST="$UPSTREAM_HOST" \
    -v "$CONFIG:/relay:ro" -v "$ROOT/acme/live:/acme/live:ro" \
    -v "$ROOT/acme/archive:/acme/archive:ro" \
    --health-cmd 'wget -qO- http://127.0.0.1:18080/health | grep -qx ok' \
    --health-interval 10s --health-timeout 3s --health-retries 3 \
    --entrypoint /bin/sh "$NGINX_IMAGE" /relay/start-nginx.sh >/dev/null
NEW_CREATED=1
docker start "$NAME" >/dev/null
i=0
while [ "$i" -lt 45 ]; do
    state=$(docker inspect "$NAME" --format '{{.State.Status}}|{{.State.Health.Status}}')
    [ "$state" != 'running|healthy' ] || break
    sleep 1
    i=$((i+1))
done
[ "$state" = 'running|healthy' ] || { printf '%s\n' 'Relay failed its health check.' >&2; exit 1; }

if docker inspect "$RENEWER" >/dev/null 2>&1; then
    [ "$(docker inspect "$RENEWER" --format '{{index .Config.Labels "io.webspeak.role"}}')" = shenzhen-cert-renew ] || exit 1
    docker rename "$RENEWER" "$RENEW_BACKUP"
    HAD_PREVIOUS_RENEWER=1
    docker stop -t 20 "$RENEW_BACKUP" >/dev/null
fi
    docker create --name "$RENEWER" --restart unless-stopped \
        --label io.webspeak.role=shenzhen-cert-renew --label "org.opencontainers.image.revision=$COMMIT" \
        --read-only --security-opt no-new-privileges:true --tmpfs /tmp:size=32m,mode=1777 \
        --memory 192m --pids-limit 64 --network bridge --dns 223.5.5.5 --dns 119.29.29.29 \
        --log-driver json-file --log-opt max-size=2m --log-opt max-file=2 \
        -v "$ROOT/acme:/etc/letsencrypt" -v "$ROOT/acme-work:/var/lib/letsencrypt" \
        -v "$ROOT/acme-logs:/var/log/letsencrypt" -v "$ROOT/credentials:/credentials:ro" \
        -v "$CONFIG/renew-cert.sh:/relay/renew-cert.sh:ro" \
        --entrypoint /bin/sh "$CERTBOT_IMAGE" /relay/renew-cert.sh >/dev/null
NEW_RENEWER_CREATED=1
docker start "$RENEWER" >/dev/null
sleep 2
[ "$(docker inspect "$RENEWER" --format '{{.State.Running}}')" = true ] || exit 1
printf '%s\n' "$COMMIT" > "$ROOT/current-commit.new"
mv "$ROOT/current-commit.new" "$ROOT/current-commit"
SUCCESS=1
if [ "$HAD_PREVIOUS" = 1 ]; then printf 'Previous relay retained as %s\n' "$BACKUP"; fi
if [ "$HAD_PREVIOUS_RENEWER" = 1 ]; then printf 'Previous renewer retained as %s\n' "$RENEW_BACKUP"; fi
printf 'Relay healthy at commit %s. Public TCP/UDP checks are still required.\n' "$COMMIT"
