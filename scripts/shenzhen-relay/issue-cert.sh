#!/bin/sh
# Run once before release.sh. Renewal subsequently uses the separate container.
set -eu
umask 077
ROOT=/opt/webspeak-relay
. "$ROOT/runtime.env"
: "${CERTBOT_IMAGE:?}" "${RELAY_HOST:?}"
case "$RELAY_HOST" in *[!a-zA-Z0-9.-]*|'') exit 1 ;; esac
case "$CERTBOT_IMAGE" in certbot/dns-cloudflare@sha256:*) ;; *) exit 1 ;; esac
docker run --rm --read-only --security-opt no-new-privileges:true \
    --tmpfs /tmp:size=32m,mode=1777 --network bridge --dns 223.5.5.5 --dns 119.29.29.29 \
    -v "$ROOT/acme:/etc/letsencrypt" -v "$ROOT/acme-work:/var/lib/letsencrypt" \
    -v "$ROOT/acme-logs:/var/log/letsencrypt" -v "$ROOT/credentials:/credentials:ro" \
    "$CERTBOT_IMAGE" certonly --non-interactive --agree-tos --register-unsafely-without-email \
    --dns-cloudflare --dns-cloudflare-credentials /credentials/cloudflare.ini \
    --dns-cloudflare-propagation-seconds 30 --cert-name "$RELAY_HOST" \
    -d "$RELAY_HOST" --keep-until-expiring
