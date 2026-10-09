// Synthetic cross-network acceptance peer; reads its protected room from stdin.
// Reflects only RTP received in this task-owned room, never captures any device.
import { RTCPeerConnection, RTCRtpCodecParameters, MediaStreamTrack } from 'werift';
import { WebSocket } from 'ws';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const { gateway, room } = JSON.parse(input);
if (!room.ownedByThisTask || !room.channelPassword || !gateway.startsWith('https://')) throw new Error('Protected test room required');
const origin = new URL(gateway).origin;
const ticketResponse = await fetch(origin+'/api/join-ticket', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ nickname: 'Screen-Reflect-'+Date.now().toString(36), rememberIdentity: false }), signal: AbortSignal.timeout(15000) });
if (ticketResponse.status !== 201) throw new Error('Test ticket rejected');
const ticket = await ticketResponse.json();
const url = new URL('/ws/voice', origin); url.protocol = 'wss:'; url.searchParams.set('ticket', ticket.ticket);
const socket = new WebSocket(url, { origin, handshakeTimeout: 15000 });
const send = message => socket.readyState === 1 && socket.send(JSON.stringify(message));
let peer, active, joined = false, iceServers = [], pendingIce = [], shuttingDown = false;
let completed = 0;
const timeout = setTimeout(() => shutdown(), 240000);
async function closePeer() { const old = peer; peer = undefined; pendingIce = []; active = undefined; await old?.close(); }
async function shutdown() { if (shuttingDown) return; shuttingDown = true; clearTimeout(timeout); await closePeer(); socket.close(); }
socket.on('close', shutdown); socket.on('error', shutdown);
socket.on('message', (raw, binary) => { if (!binary) void handle(JSON.parse(raw.toString())).catch(async error => { console.error(JSON.stringify({ failed: error.name })); await shutdown(); }); });
async function handle(m) {
  if (m.type === 'connected') { iceServers = m.screenShareIceServers; send({ type: 'switchChannel', requestId: 'reflect-room', payload: { channelId: String(room.channelId), password: room.channelPassword } }); }
  if (m.type === 'channelSwitched') { if (String(m.channelId) !== String(room.channelId)) return shutdown(); joined = true; console.log('Reflector ready in protected room'); }
  if (!joined) return;
  if (m.type === 'screenShareStarted' && m.stream?.route === 'macau') send({ type: 'screenShareJoin', requestId: 'reflect-join', streamId: m.stream.streamId });
  if (m.type === 'screenShareJoined') {
    await closePeer(); active = m.stream;
    const current = new RTCPeerConnection({ iceServers, iceUseIpv6: false, codecs: { video: [new RTCRtpCodecParameters({ mimeType: 'video/VP8', clockRate: 90000 })], audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2 })] } });
    peer = current;
    for (const kind of ['video', 'audio']) {
      const outgoing = new MediaStreamTrack({ kind });
      const transceiver = current.addTransceiver(outgoing, { direction: 'sendrecv' });
      transceiver.onTrack.subscribe(track => {
        let packets = 0;
        track.onReceiveRtp.subscribe(packet => { outgoing.writeRtp(packet); packets++; if (packets === 50) console.log(JSON.stringify({ route: active?.route, kind, received: packets, reflected: true })); });
      });
    }
    current.onicecandidate = event => { if (peer === current && event.candidate) send({ type: 'screenShareSignal', streamId: active.streamId, targetPeerId: active.ownerPeerId, signal: { kind: 'iceCandidate', ...event.candidate.toJSON() } }); };
    const offer = await current.createOffer(); await current.setLocalDescription(offer);
    if (peer === current) send({ type: 'screenShareSignal', streamId: active.streamId, targetPeerId: active.ownerPeerId, signal: { kind: 'offer', sdp: current.localDescription.sdp } });
  }
  if (m.type === 'screenShareSignal' && active?.streamId === m.streamId && peer) {
    const current = peer;
    if (m.signal.kind === 'answer') { await current.setRemoteDescription({ type: 'answer', sdp: m.signal.sdp }); for (const c of pendingIce.splice(0)) await current.addIceCandidate(c); }
    if (m.signal.kind === 'iceCandidate') { const c = { candidate: m.signal.candidate, sdpMid: m.signal.sdpMid, sdpMLineIndex: m.signal.sdpMLineIndex }; if (current.remoteDescription) await current.addIceCandidate(c); else pendingIce.push(c); }
  }
  if (m.type === 'screenShareStopped' && active?.streamId === m.streamId) { await closePeer(); if (++completed >= 2) await shutdown(); }
}
