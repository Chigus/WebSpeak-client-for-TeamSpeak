#!/bin/sh
# Keep TLS reloads independent of long-lived WebSocket and TeamSpeak sessions.
set -eu
umask 077
: "${RELAY_HOST:?Missing relay hostname}"
: "${UPSTREAM_HOST:?Missing upstream hostname}"
case "$RELAY_HOST:$UPSTREAM_HOST" in *[!a-zA-Z0-9.:-]*) exit 1 ;; esac

source_dir="/acme/live/$RELAY_HOST"
tls_link=/tmp/webspeak-tls
tls_store=/tmp/webspeak-tls-versions
nginx_conf=/tmp/nginx.conf
active_hash=
staged_hash=
candidate=
nginx_pid=
watcher_pid=

log() { printf 'WebSpeak relay TLS: %s\n' "$1" >&2; }
source_hash() {
    [ -s "$source_dir/fullchain.pem" ] && [ -s "$source_dir/privkey.pem" ] || return 1
    hashes=$(sha256sum "$source_dir/fullchain.pem" "$source_dir/privkey.pem" 2>/dev/null) || return 1
    printf '%s\n' "$hashes" | sha256sum | awk '{print $1}'
}
discard_candidate() {
    case "$candidate" in "$tls_store"/snapshot.*) rm -rf "$candidate" ;; esac
    candidate=
}
stage_snapshot() {
    staged_hash=$(source_hash) || return 1
    sleep 2
    [ "$(source_hash)" = "$staged_hash" ] || return 1
    candidate=$(mktemp -d "$tls_store/snapshot.XXXXXX") || return 1
    if ! cp "$source_dir/fullchain.pem" "$source_dir/privkey.pem" "$candidate/" ||
       ! chmod 600 "$candidate/fullchain.pem" "$candidate/privkey.pem" ||
       [ "$(source_hash)" != "$staged_hash" ] ||
       ! sed "s|/tmp/webspeak-tls/|$candidate/|g" "$nginx_conf" > "$candidate/nginx.conf" ||
       ! nginx -t -q -c "$candidate/nginx.conf" >/dev/null 2>&1; then
        discard_candidate
        return 1
    fi
}
switch_link() {
    rm -f "$tls_link.next"
    ln -s "$1" "$tls_link.next" && mv -Tf "$tls_link.next" "$tls_link"
}
reload_workers() {
    previous_workers=$(cat "/proc/$nginx_pid/task/$nginx_pid/children") || return 1
    nginx -s reload -c "$nginx_conf" >/dev/null 2>&1 || return 1
    attempt=0
    while [ "$attempt" -lt 8 ]; do
        workers=$(cat "/proc/$nginx_pid/task/$nginx_pid/children") || return 1
        for worker in $workers; do
            case " $previous_workers " in *" $worker "*) continue ;; esac
            if kill -0 "$worker" 2>/dev/null; then return 0; fi
        done
        sleep 1
        attempt=$((attempt+1))
    done
    return 1
}
activate_snapshot() {
    previous=$(readlink "$tls_link" 2>/dev/null || true)
    if ! switch_link "$candidate"; then discard_candidate; return 1; fi
    # Sending HUP alone does not prove nginx accepted the new configuration.
    # Keep the old snapshot and retry until a replacement worker has started.
    if [ -n "$nginx_pid" ] && ! reload_workers; then
        [ -z "$previous" ] || switch_link "$previous"
        discard_candidate
        return 1
    fi
    active_hash=$staged_hash
    candidate=
    case "$previous" in "$tls_store"/snapshot.*) rm -rf "$previous" ;; esac
}
watch_certificates() {
    sleep_pid=
    trap '[ -z "$sleep_pid" ] || kill "$sleep_pid" 2>/dev/null || true; exit 0' TERM INT
    while :; do
        sleep 300 & sleep_pid=$!
        wait "$sleep_pid" || return 0
        sleep_pid=
        current_hash=$(source_hash) || { log 'certificate unavailable; retaining current certificate.'; continue; }
        [ "$current_hash" != "$active_hash" ] || continue
        if stage_snapshot && activate_snapshot; then
            log 'certificate renewed and reloaded.'
        else
            log 'incomplete or invalid update; retaining current certificate.'
        fi
    done
}
stop_children() {
    trap '' TERM INT
    [ -z "$watcher_pid" ] || kill "$watcher_pid" 2>/dev/null || true
    [ -z "$nginx_pid" ] || kill -QUIT "$nginx_pid" 2>/dev/null || true
    [ -z "$nginx_pid" ] || wait "$nginx_pid" 2>/dev/null || true
    exit 0
}

mkdir -p "$tls_store" /tmp/nginx/client_body /tmp/nginx/proxy /tmp/nginx/fastcgi /tmp/nginx/uwsgi /tmp/nginx/scgi
chown -R nginx:nginx /tmp/nginx
envsubst '${RELAY_HOST} ${UPSTREAM_HOST}' < /relay/nginx.conf.template > "$nginx_conf"
if ! stage_snapshot || ! activate_snapshot; then
    log 'a stable matching certificate and key are required before startup.'
    exit 1
fi
nginx -c "$nginx_conf" -g 'daemon off;' & nginx_pid=$!
watch_certificates & watcher_pid=$!
trap stop_children TERM INT
status=0
wait "$nginx_pid" || status=$?
kill "$watcher_pid" 2>/dev/null || true
wait "$watcher_pid" 2>/dev/null || true
exit "$status"
