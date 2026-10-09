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

Rollback: stop the two named coturn containers and remove only this project's
crontab lines. Delete only mappings described `WebSpeak-Screen` with matching LAN
address and port. Restore the gateway's saved Compose/config and previous image;
P2P continues without relay configuration. Keep secrets and runtime backups out
of Git, logs and the corresponding-source archive.
