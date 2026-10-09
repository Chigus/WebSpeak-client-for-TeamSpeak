# Aliyun entry through Shenzhen

This entry preserves the Macau WebSpeak gateway and native TeamSpeak server.
Aliyun forwards only to the existing Shenzhen entry; it does not run another
gateway, mixer, coturn server, database or TeamSpeak instance.

| Aliyun listener | Shenzhen destination | Final role |
| --- | --- | --- |
| HTTPS/WSS TCP 5555 | `2.narcissu1.top:5555` | Existing TLS proxy to Macau |
| TURN UDP/TCP 33478 | `2.narcissu1.top:33478` | Existing authenticated coturn |
| TURN TLS TCP 5349 | `2.narcissu1.top:33478` TCP | TLS termination, then existing coturn |
| Native TS UDP 9987 | `2.narcissu1.top:9988` | Existing UDP proxy to Macau 9987 |

Publish a DNS-only A record for `aliyun.narcissu1.top` to the ECS public IPv4.
Cloudflare's normal HTTP proxy does not carry these TURN/TS ports. Do not publish
an AAAA record unless the entire IPv6 path has separately been configured and
tested. Only the five protocol/port entries above need new service ingress in
the ECS security group. Ports 80/443 remain available for the future website.
This deployment does not file or complete ICP registration.

## Actual media path

Coturn allocations remain on Shenzhen and advertise Shenzhen's public relay
address. Do not forward UDP 49160–49259 to Aliyun or rewrite coturn `external-ip`
to the Aliyun address. Browser-to-TURN connections enter through Aliyun; the
existing Shenzhen relay sockets reach the other media peer. Screens use one
connection per viewer; the Macau gateway authenticates/signals the share and
does not process its media.

The gateway's private `aliyun` relay entry must use the existing Shenzhen HMAC
secret, browser URLs pointing to Aliyun, and **server-only TURN URLs pointing to
Shenzhen**. The opaque voice data channel forces relay candidates at both ends.
Giving the Macau server only the Aliyun URLs would send its allocation traffic
directly Macau → Aliyun and defeat the intended route. No TURN secret is needed
on the Aliyun frontend. Keep permanent credentials out of Git and browsers.

UDP proxy sessions keep one upstream socket per client tuple. Their inactivity
timeout is ten minutes; normal TURN refresh, ICE consent and voice heartbeats
keep them alive. Do not add `proxy_responses` or a finite `proxy_requests` count:
TURN and TeamSpeak both send asynchronous traffic. UDP sessions and existing
TCP connections retain their resolved upstream address; new sessions re-resolve
the hostname. A Shenzhen WAN change may require ICE restart or reconnection.
The frontend bounds all media sessions together and does not impose a small
per-IP limit that would penalize users behind one campus NAT.

TLS protects browser → Aliyun TURN TCP. Aliyun → Shenzhen uses the existing TURN
TCP service; WebRTC media remains encrypted by DTLS/SRTP or DTLS/SCTP end to end.
The frontend is a fixed-destination proxy, not a general-purpose public proxy.

## Runtime and release

Use a reviewed, committed source archive under
`/opt/webspeak-aliyun-relay/releases/FULL_COMMIT_SHA`, containing `COMMIT` with
that SHA. The archive must include both `scripts/aliyun-relay/` and
`scripts/shenzhen-relay/`: the latter supplies the shared certificate snapshot
and renewal code from the same revision. Do not deploy edited loose source.

Keep the runtime root mode 700. Create its `acme/`, `acme-work/`, `acme-logs/`,
`credentials/` and `releases/` directories before issuing a certificate. Place
the DNS token only in mode-600 `credentials/cloudflare.ini`, scoped to the
intended DNS zone. `runtime.env` is private, trusted shell configuration:

```sh
NGINX_IMAGE='nginx@sha256:VERIFIED_MANIFEST_DIGEST'
CERTBOT_IMAGE='certbot/dns-cloudflare@sha256:VERIFIED_MANIFEST_DIGEST'
RELAY_HOST='aliyun.narcissu1.top'
UPSTREAM_HOST='2.narcissu1.top'
BIND_IP='ECS_PRIVATE_IPV4'
CERT_RENEWAL='cloudflare'
ACME_ACCOUNT='EXISTING_REGISTERED_ACCOUNT_ID'
```

Resolve and pull pinned image digests for the ECS architecture before release.
For an offline transfer, pull those digests on a trusted amd64 host, save only
the two official images, and verify the archive SHA-256 and each loaded image ID.
The runtime also accepts the resulting immutable `sha256:IMAGE_ID` references;
record their original registry digests alongside the transfer verification.
An image digest copied from an ARM Shenzhen host must be checked for an amd64
manifest before using it on an x86 ECS instance. The chosen Nginx image must
include stream, stream TLS, stream limit-connection, HTTP TLS, and `envsubst`.
The release performs an actual `nginx -t` with the exact image and certificate
before replacing an existing entry. It refuses occupied service ports owned by
another listener. It never stops another project's service or exposes Docker.

Provision the existing registered ACME account under `acme/accounts/` through a
confidential channel. The issuance script requires that account and does not
register a new account or accept new terms. Run the committed `issue-cert.sh`
once, then `release.sh FULL_COMMIT_SHA`.
DNS validation avoids binding 80/443. The Nginx container is read-only, capped at
128 MiB and one CPU, with only CHOWN/SETUID/SETGID capabilities for its certificate
snapshot and worker setup. No Docker socket or DNS token is mounted into it.
The separate 192-MiB certbot sidecar checks renewal every twelve hours, retaining
the existing certificate if issuance fails. The Nginx watcher validates a stable
matching key/certificate pair and reloads workers without restarting the server.

If an existing secure certificate-delivery job already covers this hostname,
set `CERT_RENEWAL='external'`. Supply `acme/live/aliyun.narcissu1.top/` with its
matching pair (and the corresponding `acme/archive/` if using ACME symlinks).
The same reload watcher handles updates; no DNS credentials or local certbot
sidecar are needed in that mode. Merely copying a certificate once does not
provide renewal, so use this mode only with an established delivery job.

Container health follows Aliyun → Shenzhen → Macau and checks the gateway JSON.
Public `/health` and `/api/health` also traverse the actual HTTPS chain. A failed
release restores the previous Aliyun container and certificate sidecar, including
their original running/stopped state. Previous
containers remain stopped as named rollback copies after success. The existing
Shenzhen services, Macau gateway, native TS, and HTTPS proxy are not restarted.

## Automatic selection, capacity and acceptance

Add `https://aliyun.narcissu1.top:5555` to the Macau gateway's explicit origins
alongside its existing entries; preserve original Host/Origin through both
proxies. Keep automatic selection enabled and retain the direct Shenzhen,
Macau and Cloudflare choices. Gateway probes compare end-to-end HTTP timing and
stability; voice probes compare data-channel RTT and probe loss. Screen ICE checks
candidate reachability, and the encoder adapts from actual media feedback; screen
sharing does not rank every route by RTT or measured capacity. A nearby cloud
region alone is not proof of a better route.

A 3-Mbps fixed ECS egress allocation is shared by all proxy traffic, including
forwarded uploads, downloads, and website requests. If both screen participants
use Aliyun TURN connections, the same stream can consume ECS egress on both the
Aliyun → Shenzhen and Aliyun → viewer legs. A single stream can therefore hit
the link below 1.5 Mbps before audio/protocol overhead. Existing screen bitrate
adaptation can reduce quality but cannot increase that shared bandwidth or
promise smooth high-resolution multi-viewer sharing. Do not infer video capacity
from a small RTT probe or force every user onto Aliyun.

Acceptance must include DNS-only resolution, valid TLS/SNI, public HTTPS and
WSS admission, TURN allocations over UDP/TCP/TLS, and real synthetic video/audio.
An Aliyun TURN allocation correctly advertises a **Shenzhen** relay address;
record the local candidate's TURN URL/relay protocol plus frontend socket or
traffic-counter evidence to distinguish it from direct Shenzhen TURN. For voice,
verify the gateway uses Shenzhen URLs and receives actual native TS frames with
the original independent stereo/codec bytes. Test native UDP admission separately
if advertising the native TS entry. Keep real sessions serial to avoid test-room
rate limits, and remove only task-owned test resources afterward.
