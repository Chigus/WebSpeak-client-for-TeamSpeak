#!/bin/sh
# Owner-approved public HTTPS ingress, from an explicit CI-verified release.
set -eu
umask 077
ROOT=/opt/webspeak-aliyun-relay
SHA=${1:?Provide the CI-verified release commit}
case "$SHA" in *[!0-9a-f]*|'') exit 1 ;; esac
[ "${#SHA}" = 40 ] || exit 1
SCRIPT="$ROOT/releases/$SHA/scripts/aliyun-relay"
[ "$(cat "$ROOT/releases/$SHA/COMMIT")" = "$SHA" ]
systemctl is-active --quiet webspeak-lucky.service
python3 - <<'PY'
import socket
from pathlib import Path
for port in [16601, 20195]:
    with socket.socket() as sock:
        sock.bind(('0.0.0.0', port))
root=Path('/opt/webspeak-aliyun-relay')
runtime=root/'runtime.env'
text=runtime.read_text()
if 'CERT_WILDCARD=' in text and 'CERT_WILDCARD=true' not in text.splitlines():
    raise RuntimeError('Review existing wildcard certificate setting')
if 'CERT_WILDCARD=true' not in text.splitlines():
    runtime.write_text(text.rstrip()+'\nCERT_WILDCARD=true\n')
    runtime.chmod(0o600)
PY
python3 "$SCRIPT/dns-wildcard.py"
sh "$SCRIPT/issue-cert.sh"
python3 "$SCRIPT/lucky-config.py" renew
openssl x509 -in /var/lib/webspeak-lucky/certs/current/fullchain.pem \
    -noout -checkhost lucky.aliyun.narcissu1.top | grep -q 'does match certificate'
python3 "$SCRIPT/lucky-public.py" --apply
# Keep future renewals on the same committed implementation and wildcard names.
cp /etc/systemd/system/webspeak-lucky-certificate.service \
    "$ROOT/private-backups/certificate-service-before-public-$SHA"
cat > /etc/systemd/system/webspeak-lucky-certificate.service <<UNIT
[Unit]
Description=Renew WebSpeak and Lucky wildcard certificate
After=network-online.target webspeak-lucky.service

[Service]
Type=oneshot
ExecStart=/bin/sh $SCRIPT/issue-cert.sh
ExecStart=/usr/bin/python3 $SCRIPT/lucky-config.py renew
UMask=0077
UNIT
systemctl daemon-reload
curl --fail --silent --show-error --max-time 15 \
    --resolve aliyun.narcissu1.top:5555:127.0.0.1 \
    https://aliyun.narcissu1.top:5555/health
printf '%s\n' "$SHA" > "$ROOT/LUCKY_PUBLIC_DEPLOYMENT_COMMIT"
printf '\nPublic Lucky HTTPS ingress installed. Verify authentication externally.\n'
