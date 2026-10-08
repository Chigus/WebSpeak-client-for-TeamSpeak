#!/bin/sh
set -eu
# Certbot remembers the DNS plugin and credentials path from initial issuance.
# A failed renewal keeps the existing certificate and retries in twelve hours.
child=
stop() {
    trap '' TERM INT
    [ -z "$child" ] || kill "$child" 2>/dev/null || true
    [ -z "$child" ] || wait "$child" 2>/dev/null || true
    exit 0
}
trap stop TERM INT
while :; do
    certbot renew --non-interactive --quiet & child=$!
    if wait "$child"; then
        printf '%s\n' 'WebSpeak relay: certificate renewal checked.'
    else
        printf '%s\n' 'WebSpeak relay: certificate renewal failed; retry scheduled.' >&2
    fi
    child=
    sleep 43200 & child=$!
    wait "$child" || true
    child=
done
