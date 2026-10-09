#!/bin/sh
# Run only an extracted archive of the reviewed and committed source revision.
# Private runtime state and credentials stay outside that source directory.
set -eu
umask 077
ROOT=/opt/webspeak-aliyun-relay
COMMIT=${1:?Usage: sh release.sh FULL_COMMIT_SHA}
case "$COMMIT" in *[!0-9a-f]*|'') exit 1 ;; esac
[ "${#COMMIT}" = 40 ] || exit 1
SOURCE="$ROOT/releases/$COMMIT"
CONFIG="$SOURCE/scripts/aliyun-relay"
COMMON="$SOURCE/scripts/shenzhen-relay"
[ "$(cat "$SOURCE/COMMIT")" = "$COMMIT" ] || exit 1
for path in "$CONFIG/nginx.conf.template" "$CONFIG/start-nginx.sh" "$COMMON/start-nginx.sh" "$COMMON/renew-cert.sh"; do
    [ -s "$path" ] || exit 1
done
[ -s "$ROOT/runtime.env" ] || exit 1
. "$ROOT/runtime.env"
: "${NGINX_IMAGE:?}" "${BIND_IP:?}"
[ "${RELAY_HOST:-}" = aliyun.narcissu1.top ] || exit 1
[ "${UPSTREAM_HOST:-}" = 2.narcissu1.top ] || exit 1
printf '%s\n' "$BIND_IP" | awk -F. 'NF != 4 {exit 1} {for(i=1;i<=4;i++) if ($i !~ /^[0-9]+$/ || $i>255) exit 1}' || exit 1
CERT_RENEWAL=${CERT_RENEWAL:-cloudflare}
case "$CERT_RENEWAL" in cloudflare|external) ;; *) exit 1 ;; esac
validate_image() {
    case "$1" in *@sha256:*) digest=${1##*@sha256:} ;; sha256:*) digest=${1#sha256:} ;; *) exit 1 ;; esac
    case "$digest" in *[!0-9a-f]*|'') exit 1 ;; esac
    [ "${#digest}" = 64 ] || exit 1
    docker image inspect "$1" >/dev/null
}
validate_image "$NGINX_IMAGE"
if [ "$CERT_RENEWAL" = cloudflare ]; then
    case "${CERTBOT_IMAGE:-}" in certbot/dns-cloudflare@sha256:*|sha256:*) ;; *) exit 1 ;; esac
    validate_image "$CERTBOT_IMAGE"
    [ -s "$ROOT/credentials/cloudflare.ini" ] || exit 1
fi
[ -s "$ROOT/acme/live/$RELAY_HOST/fullchain.pem" ] || exit 1
[ -s "$ROOT/acme/live/$RELAY_HOST/privkey.pem" ] || exit 1
command -v ss >/dev/null
NAME=webspeak-aliyun-relay
RENEWER=webspeak-aliyun-cert-renew
BACKUP="$NAME-rollback-$(date +%s)"
RENEW_BACKUP="$RENEWER-rollback-$(date +%s)"
HAD_PREVIOUS=0
HAD_PREVIOUS_RENEWER=0
PREVIOUS_RUNNING=false
PREVIOUS_RENEWER_RUNNING=false
NEW_CREATED=0
NEW_RENEWER_CREATED=0
SUCCESS=0
mkdir "$ROOT/.release-lock" || { printf '%s\n' 'Another Aliyun relay release is active.' >&2; exit 1; }

rollback() {
    code=$?
    trap - EXIT HUP INT TERM
    if [ "$SUCCESS" = 0 ]; then
        [ "$NEW_RENEWER_CREATED" = 0 ] || docker rm -f "$RENEWER" >/dev/null 2>&1 || true
        if [ "$HAD_PREVIOUS_RENEWER" = 1 ]; then
            docker rename "$RENEW_BACKUP" "$RENEWER" >/dev/null 2>&1 || true
            if [ "$PREVIOUS_RENEWER_RUNNING" = true ]; then docker start "$RENEWER" >/dev/null 2>&1 || true; fi
        fi
        [ "$NEW_CREATED" = 0 ] || docker rm -f "$NAME" >/dev/null 2>&1 || true
        if [ "$HAD_PREVIOUS" = 1 ]; then
            docker rename "$BACKUP" "$NAME" >/dev/null 2>&1 || true
            if [ "$PREVIOUS_RUNNING" = true ]; then docker start "$NAME" >/dev/null 2>&1 || true; fi
        fi
    fi
    rmdir "$ROOT/.release-lock" 2>/dev/null || true
    exit "$code"
}
trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if docker inspect "$NAME" >/dev/null 2>&1; then
    [ "$(docker inspect "$NAME" --format '{{index .Config.Labels "io.webspeak.role"}}')" = aliyun-relay ] || exit 1
    PREVIOUS_RUNNING=$(docker inspect "$NAME" --format '{{.State.Running}}')
fi
if docker inspect "$RENEWER" >/dev/null 2>&1; then
    [ "$(docker inspect "$RENEWER" --format '{{index .Config.Labels "io.webspeak.role"}}')" = aliyun-cert-renew ] || exit 1
    PREVIOUS_RENEWER_RUNNING=$(docker inspect "$RENEWER" --format '{{.State.Running}}')
fi
check_port() {
    protocol=$1
    port=$2
    if [ "$protocol" = tcp ]; then sockets=$(ss -H -lnt "sport = :$port");
    else sockets=$(ss -H -lnu "sport = :$port"); fi
    [ -n "$sockets" ] || return 0
    if [ "$PREVIOUS_RUNNING" = true ] && docker port "$NAME" "$port/$protocol" | grep -Fx "$BIND_IP:$port" >/dev/null; then
        return 0
    fi
    printf 'Refusing occupied public port %s/%s.\n' "$port" "$protocol" >&2
    exit 1
}
check_port tcp 5555
check_port tcp 33478
check_port udp 33478
check_port tcp 5349
check_port udp 9987

# Use the exact pinned image, template and certificate before replacing anything.
docker run --rm --read-only --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID \
    --security-opt no-new-privileges:true --memory 128m --pids-limit 64 \
    --tmpfs /tmp:size=32m,mode=1777 --network bridge --dns 223.5.5.5 --dns 119.29.29.29 \
    -e RELAY_HOST="$RELAY_HOST" -e UPSTREAM_HOST="$UPSTREAM_HOST" \
    -v "$CONFIG:/relay:ro" -v "$ROOT/acme/live:/acme/live:ro" \
    -v "$ROOT/acme/archive:/acme/archive:ro" --entrypoint sh "$NGINX_IMAGE" -c '
      envsubst '\''${RELAY_HOST} ${UPSTREAM_HOST}'\'' < /relay/nginx.conf.template > /tmp/nginx.conf
      mkdir -p /tmp/webspeak-tls /tmp/nginx/client_body /tmp/nginx/proxy /tmp/nginx/fastcgi /tmp/nginx/uwsgi /tmp/nginx/scgi
      cp "/acme/live/$RELAY_HOST/fullchain.pem" "/acme/live/$RELAY_HOST/privkey.pem" /tmp/webspeak-tls/
      nginx -t -q -c /tmp/nginx.conf'

if docker inspect "$NAME" >/dev/null 2>&1; then
    docker rename "$NAME" "$BACKUP"
    HAD_PREVIOUS=1
    docker stop -t 20 "$BACKUP" >/dev/null
fi
docker create --name "$NAME" --restart unless-stopped \
    --label io.webspeak.role=aliyun-relay --label "org.opencontainers.image.revision=$COMMIT" \
    --read-only --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID \
    --security-opt no-new-privileges:true --tmpfs /tmp:size=32m,mode=1777 \
    --memory 128m --cpus 1 --pids-limit 64 --ulimit nofile=2048:2048 \
    --network bridge --dns 223.5.5.5 --dns 119.29.29.29 \
    --log-driver json-file --log-opt max-size=2m --log-opt max-file=2 \
    -p "$BIND_IP:5555:5555/tcp" -p "$BIND_IP:33478:33478/tcp" -p "$BIND_IP:33478:33478/udp" \
    -p "$BIND_IP:5349:5349/tcp" -p "$BIND_IP:9987:9987/udp" \
    -e RELAY_HOST="$RELAY_HOST" -e UPSTREAM_HOST="$UPSTREAM_HOST" \
    -v "$CONFIG:/relay:ro" -v "$COMMON:/common:ro" \
    -v "$ROOT/acme/live:/acme/live:ro" -v "$ROOT/acme/archive:/acme/archive:ro" \
    --health-cmd "wget -qO- -T 8 http://127.0.0.1:18080/upstream-health | grep -q '\"status\":\"ok\"'" \
    --health-interval 15s --health-timeout 12s --health-retries 3 --health-start-period 10s \
    --entrypoint /bin/sh "$NGINX_IMAGE" /relay/start-nginx.sh >/dev/null
NEW_CREATED=1
docker start "$NAME" >/dev/null
i=0
state=
while [ "$i" -lt 45 ]; do
    state=$(docker inspect "$NAME" --format '{{.State.Status}}|{{.State.Health.Status}}')
    [ "$state" != 'running|healthy' ] || break
    sleep 2
    i=$((i+1))
done
[ "$state" = 'running|healthy' ] || { printf '%s\n' 'Aliyun -> Shenzhen -> Macau health check failed.' >&2; exit 1; }

if docker inspect "$RENEWER" >/dev/null 2>&1; then
    docker rename "$RENEWER" "$RENEW_BACKUP"
    HAD_PREVIOUS_RENEWER=1
    docker stop -t 20 "$RENEW_BACKUP" >/dev/null
fi
if [ "$CERT_RENEWAL" = cloudflare ]; then
    docker create --name "$RENEWER" --restart unless-stopped \
        --label io.webspeak.role=aliyun-cert-renew --label "org.opencontainers.image.revision=$COMMIT" \
        --read-only --cap-drop ALL --security-opt no-new-privileges:true \
        --tmpfs /tmp:size=32m,mode=1777 --memory 192m --cpus 1 --pids-limit 64 \
        --network bridge --dns 223.5.5.5 --dns 119.29.29.29 \
        --log-driver json-file --log-opt max-size=2m --log-opt max-file=2 \
        -v "$ROOT/acme:/etc/letsencrypt" -v "$ROOT/acme-work:/var/lib/letsencrypt" \
        -v "$ROOT/acme-logs:/var/log/letsencrypt" -v "$ROOT/credentials:/credentials:ro" \
        -v "$COMMON/renew-cert.sh:/relay/renew-cert.sh:ro" \
        --entrypoint /bin/sh "$CERTBOT_IMAGE" /relay/renew-cert.sh >/dev/null
    NEW_RENEWER_CREATED=1
    docker start "$RENEWER" >/dev/null
    sleep 2
    [ "$(docker inspect "$RENEWER" --format '{{.State.Running}}')" = true ] || exit 1
fi
printf '%s\n' "$COMMIT" > "$ROOT/current-commit.new"
mv "$ROOT/current-commit.new" "$ROOT/current-commit"
SUCCESS=1
if [ "$HAD_PREVIOUS" = 1 ]; then printf 'Previous Aliyun relay retained as %s\n' "$BACKUP"; fi
if [ "$HAD_PREVIOUS_RENEWER" = 1 ]; then printf 'Previous renewer retained as %s\n' "$RENEW_BACKUP"; fi
printf 'Aliyun relay healthy at commit %s. Public TURN and real media still require acceptance.\n' "$COMMIT"
