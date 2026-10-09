# Screen-share TURN nodes

Two independent coturn nodes forward encrypted screen media. They do not process
TeamSpeak voice or music. This is TURN, not an SFU: the publisher still uploads
one stream per viewer. P2P retains the existing ICE configuration.

Deploy only reviewed, committed copies of `network-config.mjs` and `reconcile.sh`.
Runtime directories are `/share/CACHEDEV1_DATA/DockerData/webspeak-screen-relay`
(Macau) and `/opt/webspeak-screen-relay` (Shenzhen). Keep each directory mode 700;
coturn reads only its `coturn/` subdirectory through a read-only bind mount. The
official binary requires NET_BIND_SERVICE in its capability bounding set; every
other capability is dropped and privilege escalation is disabled.

Create a private `node.json` (mode 600) with `lanIp`, `gateway`, `realm`, optional
`publicPort` (default 33478, forwarded to coturn's internal 3478), and a
separately generated 32-byte random hexadecimal `secret` for that node.
Create private `runtime.env` with quoted `DOCKER`, `DOCKER_CONFIG`, and a pinned
`NODE_IMAGE` providing Node 22. The helper receives no Docker socket.

`sh reconcile.sh RUNTIME_DIRECTORY` discovers only the local configured gateway,
queries its external IPv4 and restores missing UPnP mappings: TCP/UDP 33478 and UDP
49160–49259. Audit router static/game forwards as well as UPnP before installing;
game forwarding may intercept 3478 ahead of UPnP. Existing UPnP mappings to another
target fail closed. The helper retires only its own old 3478 mappings. Add this command to
the host's persistent crontab every five minutes. It restarts only coturn when the
public address/config changes, or starts it if missing. Docker restores coturn on
host boot; the next successful reconciliation restores router mappings after a
router reboot. A WAN IP change interrupts existing relay connections; re-share
after recovery. UPnP must remain enabled. Failures are logged; examine
`network-state.json` for the last successful check. No unrelated mappings change.

Mount a private gateway JSON array read-only and set
`WEBSPEAK_SCREEN_SHARE_RELAYS_FILE` to its container path:

```json
[
  {"id":"macau","urls":["turn:1.example:33478?transport=udp","turn:1.example:33478?transport=tcp"],"secret":"REPLACE_WITH_MACAU_SECRET_AT_LEAST_32_CHARACTERS"},
  {"id":"shenzhen","urls":["turn:2.example:33478?transport=udp","turn:2.example:33478?transport=tcp"],"secret":"REPLACE_WITH_SHENZHEN_SECRET_AT_LEAST_32_CHARACTERS"}
]
```

Only authenticated screen publishers receive temporary HMAC credentials, valid
for 24 hours from starting a share. The permanent secret never enters a browser
or stream list. A new peer after expiry requires restarting the share. Forced
relay routes never silently fall back to P2P. Viewer ICE stays unchanged; the
publisher's relay-only policy makes all media traverse the selected node.

Each node limits allocations to 100 total and 12 per temporary user, with
3 MB/s per session and 30 MB/s aggregate caps. These are protective caps, not a
measured capacity promise. Private, loopback and multicast destinations are
blocked. TURN TCP is supported for the browser-to-node connection; media relay
sockets are UDP. TURN TLS is not configured; WebRTC media itself is DTLS-SRTP
encrypted end-to-end. Networks blocking both TCP/UDP 33478 cannot use these nodes.

Some routers rewrite a same-LAN public-address loopback into a private address.
The private-peer restriction then prevents that local TURN path. For participants
on the node's own LAN, use P2P or the other regional node. Do not remove private
destination protection merely to make a same-machine acceptance test pass.

## Synthetic media acceptance

`browser-check-server.mjs` needs `SCREEN_TEST_GATEWAY` (HTTPS), `SCREEN_TEST_ROOM`
(an owned, password-protected test-channel JSON record) and `SCREEN_TEST_REPORT`.
It binds only `127.0.0.1:8848` and uses the gateway's actual advertised ICE settings.
The normal `/screen-relay-check` page tests P2P and Shenzhen UDP/TCP from Macau.
It verifies selected candidates and decoded video/audio, then releases both peers.

Load `/screen-relay-check#bitrate` to verify live manual 2/16 Mbps caps and all
three adaptive preferences on the same capture and peer. Synthetic bandwidth
feedback exercises congestion and recovery while real sender parameters and
decoded frames are checked. This is simulated feedback, not a throttled-network
benchmark, a measured visual-quality improvement, or proof of sustained 60 FPS.

To verify Macau without a same-LAN loopback, run the committed
`remote-reflector.mjs` on a Shenzhen Node 22 host with `werift@0.24.4` and
`ws@8.20.0`. Pass `{ "gateway": "https://gateway.example", "room": { ... } }`
through stdin, using the same private test-room record; never publish that record.
After it reports readiness, load `/screen-relay-check#remote`. The reflector joins
only that room and returns received synthetic VP8/Opus RTP. The page verifies
Macau UDP/TCP relay candidates and browser decoding after the cross-network round
trip. It captures no screen or microphone. This proves synthetic media transport,
not a physical display capture, a native TeamSpeak viewer, or general LAN hairpin
compatibility. Remove the temporary reflector runtime and empty owned test room
after checking both reports.

Rollback: stop the two named coturn containers and remove only this project's
crontab lines. Delete only mappings described `WebSpeak-Screen` with matching LAN
address and port. Restore the gateway's saved Compose/config and previous image;
P2P continues without relay configuration. Keep secrets and runtime backups out
of Git, logs and the corresponding-source archive.
