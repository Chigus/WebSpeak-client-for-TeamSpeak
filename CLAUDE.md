# WebSpeak TeamSpeak Browser Gateway

WebSpeak connects browser users to TeamSpeak 3 and TeamSpeak 6 through a self-hosted Node.js gateway. Each connected browser session owns an independent TeamSpeak client. The repository also contains a standalone UDP acceleration relay and an Android preview with an embedded local gateway.

## Application boundaries

| Location | Responsibility |
| --- | --- |
| `src/index.ts` | Gateway startup, SQLite, master secret, admin service and shutdown; also supports relay mode |
| `src/server/server.ts` | HTTP or HTTPS, public configuration, skins, join tickets, admin routes and static frontend |
| `src/server/voice-bridge.ts` | `/ws/voice`, admission, connection/reconnection orchestration and voice transport assembly |
| `src/server/voice-commands.ts`, `directory-view.ts`, `audio-stats.ts` | Command execution, public directory projection and diagnostic snapshots |
| `src/server/screen-share-coordinator.ts` | Server/channel-scoped sharing membership and browser/native signaling |
| `src/shared/` | Browser-safe wire types and runtime parsers shared by both endpoints |
| `src/shared/admin-inputs.ts`, `admin-responses.ts` | Shared admin request types and runtime-checked response projections |
| `src/server/ts-client.ts` and `teamspeak-adapter.ts` | SDK integration, TS3/TS6 negotiation, identity, chat, voice and client events |
| `src/server/session-manager.ts` and `directory-sync.ts` | Connection state, teardown, admission limits and directory reconciliation |
| `src/server/webrtc-audio.ts` and `opus-codec.ts` | WebRTC audio mixing and platform-specific Opus codecs |
| `src/admin/`, `src/security/`, `src/persistence/` | Administration, access policies, credentials and persistent settings |
| `src/relay.ts` and `src/server/acceleration-relay.ts` | Standalone relay and gateway-side relay transport |
| `web/src/views/` and `web/src/composables/` | Vue pages, connection state, audio controls, chat and screen sharing |
| `web/src/voice/screen-share.ts` | Per-session screen capture, peer negotiation, cleanup and diagnostics |
| `web/src/voice/remote-playback.ts` | Per-speaker compatibility decoding, bounded scheduling, volume and resource cleanup |
| `web/src/voice/microphone-test.ts` | Cancellable recording tests, recorder deadline and playback URL ownership |
| `web/src/voice/audio-sink.ts` | Serialized device routing per audio endpoint, with stale-operation guards |
| `web/src/platform/` | Browser mounting and cancellable Android gateway readiness handshake |
| `web/src/services/`, `web/src/i18n/`, `web/src/skins/` | Browser persistence, identity import, skin packages and translations |
| `web/src/services/admin-api.ts` | Admin HTTP transport, response validation, current CSRF and authentication-expiry notification, including skin uploads and backup downloads |
| `src/mobile/`, `mobile/`, `web/android/` | Android loopback gateway, asset packaging and Capacitor container |

## Connection and control protocol

1. The browser requests `/api/join-ticket`. The gateway validates the request against its access policy and issues a short-lived, single-use ticket.
2. The browser presents the ticket to `/ws/voice`. The bridge admits a session, acquires any required identity lease and creates its TeamSpeak client.
3. WebSocket text messages carry JSON commands, events, WebRTC negotiation and screen-sharing signaling. The server uses the WebSocket `isBinary` flag to distinguish audio from control messages.
4. Register TeamSpeak event listeners before connecting: directory and membership events may arrive during the handshake.

Channel and member data come from SDK directory snapshots and client-protocol commands, followed by realtime notifications. WebQuery and its API key are not required. `DirectorySynchronizer` reconciles snapshots with membership events.

Session teardown must remain safe when requested more than once or when sockets and codec resources are already closed. Reconnection is governed by `reconnect-policy.ts`; preserve terminal error handling, bounded retries and the previous-channel fallback.

Late socket messages and media permission/negotiation results must not mutate a replacement session. Screen-sharing ownership is scoped to both the TeamSpeak target and channel; another member moving channels must not stop the current user's share. Preserve these invariants when extracting the remaining audio responsibilities.

WebRTC offers, answers, playback callbacks and accompaniment capture belong to the session and peer that started them. Invalidate pending negotiation on stop, reconnect or teardown before awaiting resource closure. A stale peer must not publish errors, counters or audio into its successor. Negotiation and track setup failures must restore compatibility capture without misreporting a microphone failure.

## Audio and screen sharing

The compatibility voice path captures 48 kHz mono PCM using an AudioWorklet, with a ScriptProcessor fallback. The browser assembles 960-sample, 20 ms frames and sends 1,920-byte Int16 payloads over WebSocket. The gateway encodes them as Opus for TeamSpeak. Incoming Opus uses a three-byte header containing codec and client ID, then browser WebCodecs decoding and playback.

When enabled by the administrator, WebRTC provides a separate voice transport between the browser and gateway. The gateway uses `werift` and mixes incoming TeamSpeak speakers for WebRTC playback. Negotiation failures can fall back to the compatibility path. Keep microphone mute, per-member volume and playback behavior consistent across both transports.

Screen sharing has its own peer connections. The gateway coordinates stream membership and SDP/ICE signaling between browsers and supported TeamSpeak 6 clients. Screen media travels directly or through an externally configured TURN server; the WebSpeak gateway does not carry screen media.

Preserve bounded audio buffering and stale-playback recovery. Audio counters stay in memory and are exposed in session diagnostics. Do not add per-frame persistent logging to the voice path.

Remote playback owns each speaker's decoder, gain and source nodes as one resource set. Member departure, decoder failure and session teardown release that set; queued callbacks must not touch its replacement. Preserve the 80 ms playback window and three-frame decoder queue threshold unless audio validation justifies changing them.

Microphone recording tests own their recorder, timeout and object URL, while the capture layer owns the microphone stream. A normal stop may publish its final recording; replacement and session teardown discard late results and revoke the old URL. Stopping a test while connected must preserve room capture. Test cancellation and stale permission failures must not change a newer test's state.

Device and noise-suppression changes share one configuration operation. Persist only the last successful settings; stale failures cannot roll back a newer choice. Acquiring a replacement microphone must preserve the current WebRTC peer and compatibility PCM capture until the replacement is ready. Capture callbacks are invalidated when their graph stops, separately from permission-request generations. Closing settings also releases standalone device-preview capture when no recording was started.

Serialize `setSinkId` on each audio context or media element, since an in-flight browser sink change cannot be cancelled. Bind subsequent work to the original endpoint and current operation; session teardown invalidates queued changes and device enumeration results. If one output endpoint rejects after another changed, attempt to restore the last committed output.

`src/server/opus-codec.ts` loads the native `@discordjs/opus` implementation for server deployments and `opusscript` for the Android bundle. Dispose codec and media resources at the end of their owning session.

## Configuration and persistence

| Source | Purpose |
| --- | --- |
| SQLite `webspeak.db` | Admin credentials, target and access settings, relay nodes, invitations, audit records and visitor metadata |
| `master.key` beside the database | Encryption key for persisted secrets; retain it with database backups |
| `/admin` | Normal configuration and operational controls |
| Legacy `config.json` | One-time import of `tsHost`, `tsPort` and `tsServerPassword`; later changes do not replace database settings |
| `WEBSPEAK_DATA_DIR` | Persistent data directory; defaults to project `data/`, while Docker uses `/data` |
| `WEBSPEAK_SCREEN_SHARE_ICE_SERVERS` | Screen-sharing ICE configuration read at startup |
| Relay environment variables | Standalone relay mode; public gateway relay choices come from saved admin settings |
| Browser IndexedDB and localStorage | Local identities, preferences, server history and skin state |

The current SQLite schema version is defined in `src/persistence/database.ts`. Keep schema migrations separate from structural refactors. Legacy fields such as `voiceToken`, `tsApiKey`, `tsQueryPort`, `port` and `maxClients` do not configure the current gateway.

The gateway HTTP port is `3040`. Its admission ceiling is `100` sessions, defined in `src/constants.ts`; this is an application limit, not a TeamSpeak license allowance or a measured performance guarantee. Target server capacity and permissions still apply.

The server uses HTTPS when `certs/cert.pem` and `certs/key.pem` are supplied; otherwise it starts HTTP. It does not generate certificates. Use an appropriate secure browser origin for microphone and screen capture, typically HTTPS in public deployments. Feature support depends on the browser and selected transport; do not infer a universal minimum browser version from WebCodecs alone.

## Development and verification

Server deployments require Node.js 22.5 or newer. CI uses Node.js 22.22.2. Root and frontend dependencies are installed separately. The pinned Git SDK and native Opus module require the preparation steps used by CI:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run prepare:sdk
npm rebuild @discordjs/opus --foreground-scripts --no-audit --no-fund
npm --prefix web ci --no-audit --no-fund
npm run verify
```

`npm run verify` runs unit tests, the backend build and `npm run web:build`. The latter delegates to the frontend build, including `vue-tsc --noEmit`. Use `npm run dev` and `npm run web:dev` for development, or `npm start` after building both applications.

CI verifies pushes to `dev` and `master`, pull requests and manual runs. Docker publication on `master` or release tags, and release packaging on tags or manual runs, call the same verification workflow before publishing or packaging. Verification includes the application checks and a Docker HTTP health smoke test; that smoke test does not prove voice or screen-sharing functionality.

Tests requiring a real TeamSpeak server, browser media devices or Android hardware must document their environment and outcome separately. Never substitute a mock codec or an HTTP health response for a successful audio test.

## Android preview

The Android app starts an embedded Node.js gateway on `127.0.0.1:3040` and opens it in the WebView. This preview disables gateway WebRTC voice and the admin console, while reusing the compatibility voice path. Its dependencies and runtime differ from server deployments.

See `mobile/README.md` for build steps and recorded limitations. The embedded Node.js version, SDK compatibility, real-device connections, background audio and native screen sharing require their own validation. Do not present these capabilities as production-ready based on desktop tests.

Platform startup owns its message listener, polling interval and deadline, including slow listener registration. Release them on success, failure, timeout and page exit. The retry button repeats the readiness handshake; it does not restart the embedded Node.js runtime.

## Repository maintenance

Routes load their page modules on demand. Document-level page styles must be gated by `html[data-ws-route]` because loaded CSS remains after navigation. The admin stylesheet is independent of public skins. Component extraction must retain `data-ws-part` hooks and account for Vue scoped styles across component boundaries.

Validate admin responses before applying them to page state. Network and protocol failures must preserve unsaved input; a failed logout must not be presented as a successful logout. Keep secret keep/replace/remove actions intact and do not persist credentials in UI error messages or diagnostic logs.

The repository remote is `https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak`. Preserve existing local work when implementing the plan in `docs/CODE_REFACTOR_PLAN.zh-CN.md`. Keep private configuration, runtime data and local deployment archives out of source commits. Preserve documented skin hooks and browser persistence formats during component refactors.
