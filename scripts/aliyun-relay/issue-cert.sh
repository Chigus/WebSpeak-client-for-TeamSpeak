#!/bin/sh
# DNS validation leaves host ports 80/443 available for the future website.
set -eu
umask 077
ROOT=/opt/webspeak-aliyun-relay
. "$ROOT/runtime.env"
[ "${RELAY_HOST:-}" = aliyun.narcissu1.top ] || exit 1
case "${CERTBOT_IMAGE:-}" in certbot/dns-cloudflare@sha256:*) digest=${CERTBOT_IMAGE##*@sha256:} ;; sha256:*) digest=${CERTBOT_IMAGE#sha256:} ;; *) exit 1 ;; esac
case "$digest" in *[!0-9a-f]*|'') exit 1 ;; esac
[ "${#digest}" = 64 ] || exit 1
[ -s "$ROOT/credentials/cloudflare.ini" ] || exit 1
: "${ACME_ACCOUNT:?Provide an existing registered ACME account}"
case "$ACME_ACCOUNT" in *[!0-9a-f]*|'') exit 1 ;; esac
[ -d "$ROOT/acme/accounts/acme-v02.api.letsencrypt.org/directory/$ACME_ACCOUNT" ] || exit 1
docker image inspect "$CERTBOT_IMAGE" >/dev/null
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --memory 192m --pids-limit 64 --tmpfs /tmp:size=32m,mode=1777 \
    --network bridge --dns 223.5.5.5 --dns 119.29.29.29 \
    -v "$ROOT/acme:/etc/letsencrypt" -v "$ROOT/acme-work:/var/lib/letsencrypt" \
    -v "$ROOT/acme-logs:/var/log/letsencrypt" -v "$ROOT/credentials:/credentials:ro" \
    "$CERTBOT_IMAGE" certonly --non-interactive --account "$ACME_ACCOUNT" \
    --dns-cloudflare --dns-cloudflare-credentials /credentials/cloudflare.ini \
    --dns-cloudflare-propagation-seconds 30 --cert-name "$RELAY_HOST" \
    -d "$RELAY_HOST" --keep-until-expiring
