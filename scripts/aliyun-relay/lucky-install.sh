#!/bin/sh
# First installation, from a clean committed release archive. Requires root.
set -eu
umask 077
ROOT=/opt/webspeak-aliyun-relay
STATE=/var/lib/webspeak-lucky
SHA=${1:?Full committed deployment-script revision required}
case "$SHA" in *[!0-9a-f]*|'') exit 1 ;; esac
[ "${#SHA}" = 40 ]
RELEASE="$ROOT/releases/$SHA"
[ "$(cat "$RELEASE/COMMIT")" = "$SHA" ]
SCRIPT="$RELEASE/scripts/aliyun-relay"
[ "$(id -u)" = 0 ]
[ ! -e /etc/systemd/system/webspeak-lucky.service ]
[ ! -e "$STATE" ]
[ ! -e "$ROOT/lucky-admin.json" ]
[ -s "$ROOT/lucky-stage/lucky.tar.gz" ]
printf '%s  %s\n' '78adf3fa5e8869be0b1510cb7bcc755d57dccb13252989c8394a7207a392fe66' \
    "$ROOT/lucky-stage/lucky.tar.gz" | sha256sum -c -
python3 - <<'PY'
import socket
opened=[]
try:
    for kind,ports in [(socket.SOCK_STREAM,[5555,33478,5349,16602]),(socket.SOCK_DGRAM,[33478,9987])]:
        for port in ports:
            sock=socket.socket(socket.AF_INET,kind)
            opened.append(sock)
            sock.bind(('0.0.0.0',port))
finally:
    for sock in opened:sock.close()
PY
install -d -m 755 /usr/local/lib/webspeak-lucky/2.27.2
tar -xzf "$ROOT/lucky-stage/lucky.tar.gz" -C /usr/local/lib/webspeak-lucky/2.27.2 lucky LICENSE
chmod 755 /usr/local/lib/webspeak-lucky/2.27.2/lucky
id webspeak-lucky >/dev/null 2>&1 || useradd --system --home-dir "$STATE" \
    --shell /usr/sbin/nologin --user-group webspeak-lucky
install -d -m 750 -o root -g webspeak-lucky "$STATE"
# No default credential is ever exposed to a host or public interface.
unshare --net -- sh -c 'ip link set lo up; exec python3 "$1" bootstrap' sh "$SCRIPT/lucky-config.py"
chown -R webspeak-lucky:webspeak-lucky "$STATE/conf"
chmod 700 "$STATE/conf"
cat > /etc/systemd/system/webspeak-lucky.service <<'UNIT'
[Unit]
Description=Lucky WebSpeak entry through Shenzhen
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=webspeak-lucky
Group=webspeak-lucky
WorkingDirectory=/var/lib/webspeak-lucky/conf
ExecStart=/usr/local/lib/webspeak-lucky/2.27.2/lucky -cd /var/lib/webspeak-lucky/conf -ds
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
ReadWritePaths=/var/lib/webspeak-lucky/conf
UMask=0077
MemoryMax=384M
TasksMax=256
LimitNOFILE=16384

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl start webspeak-lucky.service
trap 'systemctl stop webspeak-lucky.service; printf "%s\n" "Lucky initial release failed; stopped. Private state retained for diagnosis." >&2' EXIT
sleep 3
python3 "$SCRIPT/lucky-config.py" configure
healthy=false
for attempt in $(seq 1 20); do
    if curl --fail --silent --max-time 5 --resolve aliyun.narcissu1.top:5555:127.0.0.1 \
        https://aliyun.narcissu1.top:5555/health | grep -q '"status":"ok"'; then
        healthy=true
        break
    fi
    sleep 2
done
[ "$healthy" = true ]
cat > /etc/systemd/system/webspeak-lucky-certificate.service <<UNIT
[Unit]
Description=Renew WebSpeak certificate and refresh Lucky
After=network-online.target webspeak-lucky.service

[Service]
Type=oneshot
ExecStart=/bin/sh $SCRIPT/issue-cert.sh
ExecStart=/usr/bin/python3 $SCRIPT/lucky-config.py renew
UMask=0077
UNIT
cat > /etc/systemd/system/webspeak-lucky-certificate.timer <<'UNIT'
[Unit]
Description=Check WebSpeak Lucky certificate twice daily
[Timer]
OnCalendar=*-*-* 03,15:15:00
RandomizedDelaySec=900
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable webspeak-lucky.service webspeak-lucky-certificate.timer
systemctl start webspeak-lucky-certificate.timer
printf '%s\n' "$SHA" > "$ROOT/LUCKY_DEPLOYMENT_COMMIT"
trap - EXIT
printf '%s\n' 'Lucky installed; HTTPS health through Shenzhen and Macau passed.'
