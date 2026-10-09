# Lucky entry through Shenzhen

Lucky **2.27.2** is the selected Aliyun implementation. It runs its own Web
reverse proxy and TCP/UDP forwarders, including incoming TURN TLS termination.
There is no Nginx data path on Aliyun. The earlier Nginx scripts remain an
alternative, not the current deployment procedure.

Obtain the Linux x86-64 archive from the official `gdy666/lucky` GitHub release.
Its SHA-256 is
`78adf3fa5e8869be0b1510cb7bcc755d57dccb13252989c8394a7207a392fe66`.
Stage it as `/opt/webspeak-aliyun-relay/lucky-stage/lucky.tar.gz`. Lucky versions
after 1.4.10 are closed source; the WebSpeak AGPL source archive covers WebSpeak,
not the separately installed Lucky binary.

Push and pass CI first. Export this directory from the same explicit clean
commit to `/opt/webspeak-aliyun-relay/releases/COMMIT`, with a `COMMIT` file.
On Windows, use `git -c core.autocrlf=false archive` to preserve shell line endings.
Prepare the existing registered ACME account, issued certificate, pinned certbot
image and private `runtime.env` as described in README.md. Then run:

```sh
sh /opt/webspeak-aliyun-relay/releases/COMMIT/scripts/aliyun-relay/lucky-install.sh COMMIT
```

The first installation refuses existing Lucky state or occupied ports. Default
credentials are changed inside an isolated network namespace before the daemon
starts on the host. The service runs as the dedicated unprivileged
`webspeak-lucky` user, can write only its configuration directory, and cannot read
the root-only DNS token or root-only deployment credentials.

| Lucky rule | Listener | Fixed destination |
| --- | --- | --- |
| Web service | HTTPS/WSS 5555 | `https://2.narcissu1.top:5555` |
| Web redirect | HTTP 5555 | Fixed hostname HTTPS entry on 5555 |
| Port forward | UDP and TCP 33478 | `2.narcissu1.top:33478` |
| TLS port forward | TCP 5349, TLS on | `2.narcissu1.top:33478`, plain TCP |
| Native TeamSpeak | UDP 9987 | `2.narcissu1.top:9988` |

Web upstream certificate validation stays enabled. Original Host/Origin and
WebSocket are preserved; cross-origin authorization stays with WebSpeak. Unknown
hostnames have no default upstream. Lucky 2.27.2 normalizes UDP settings to a
30-second idle timeout and 32 concurrent target readers per forwarder in this
installation. ICE consent/voice heartbeats must keep active sessions alive;
long-idle allocations may need reconnection. Do not claim the alternative
Nginx implementation's ten-minute timeout applies to Lucky. Validate sessions
for longer than 30 seconds and size concurrency separately from bandwidth.
TURN credentials are still issued by Macau using the existing Shenzhen secret.
Gateway-side TURN URLs must continue to point to Shenzhen, as README.md explains.

Lucky's backend listens on **127.0.0.1:16602** only. Access it using an ordinary
administrator SSH tunnel (`ssh -L 16602:127.0.0.1:16602 root@ECS_IP`) and the safe
entry path/account/password in the root-only
`/opt/webspeak-aliyun-relay/lucky-admin.json`. The task's temporary restricted SSH
key deliberately cannot forward ports. Use the owner's normal administration
credentials; do not publicly open the management port or remove authentication.
Service rules can then be edited in Lucky's Web services and Port forwarding UI.
The deployment script refuses to overwrite rules subsequently managed in the UI.

The certificate timer reuses the existing certbot account twice daily. It
publishes a validated, matching key/certificate snapshot through an atomic
directory symlink and asks Lucky to refresh it. Lucky also checks path
certificates daily. Failed issuance retains the previous certificate. This
requires no new ACME account or agreement, port 80/443 listener, or Lucky DNS token.
Check `systemctl list-timers webspeak-lucky-certificate.timer` and
`journalctl -u webspeak-lucky-certificate.service` for renewal status.

If initial HTTPS health fails, the installer stops the new service and retains
its private state for diagnosis. It never restarts Shenzhen, native TeamSpeak,
the Macau HTTPS proxy, or the Macau gateway. Before subsequent UI edits, export
a Lucky configuration backup. Before a software upgrade, stop Lucky briefly and
snapshot `/var/lib/webspeak-lucky/conf`, retain the previous binary and unit, and
restore all three if validation fails.

An HTTPS health check is only installation validation. Run the real serial voice,
stereo, native TS, screen UDP/TCP/TLS and fallback acceptance in README.md. The
shared 3-Mbps ECS egress limit and screen ICE selection limitations still apply.
Ports 80/443 and `behregaming.top`/ICP work are separate follow-up deployment work.
