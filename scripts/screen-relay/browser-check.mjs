import { createScreenShareController } from '/src/voice/screen-share.ts';
const state = document.querySelector('#state'), result = document.querySelector('#result');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(check, label, timeout = 25000) {
  const until = Date.now() + timeout;
  while (!check()) { if (Date.now() > until) throw new Error(label); await delay(100); }
}
const realPeer = window.RTCPeerConnection, peers = [];
window.RTCPeerConnection = class extends realPeer { constructor(config) { super(config); this.testConfig = config; peers.push(this); } };
let protocol;
function participant() {
  const socket = new WebSocket(`ws://${location.host}/screen-relay-check/ws`);
  const controller = createScreenShareController({ isOpen: () => socket.readyState === 1, send: message => socket.send(JSON.stringify(message)) });
  const p = { socket, controller, connected: false };
  socket.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.type === 'connected') { controller.setIceServers(m.screenShareIceServers); controller.setRelays(m.screenShareRelays); p.connected = true; }
    // Both protocols are deployed. Restrict the lease only in the test harness
    // to prove that UDP and TCP TURN listeners each carry actual media.
    if (m.type === 'screenShareStarted' && m.owner && m.relay && protocol) {
      m.relay.iceServers = m.relay.iceServers.map(s => ({ ...s, urls: [].concat(s.urls).filter(url => url.endsWith(`transport=${protocol}`)) }));
    }
    controller.handleMessage(m);
  };
  return p;
}
document.querySelector('#start').onclick = async event => {
  event.target.disabled = true;
  const report = { status: 'running', scope: 'Production WSS and TURN nodes; two browser peers on one Macau Windows host; synthetic canvas and oscillator only.', cases: [] };
  const owner = participant(), viewer = participant();
  const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 540;
  const ctx = canvas.getContext('2d'); let frame = 0, tracks = [], audio;
  const timer = setInterval(() => { ctx.fillStyle = '#123c40'; ctx.fillRect(0, 0, 960, 540); ctx.fillStyle = '#92e3c4'; ctx.font = '42px sans-serif'; ctx.fillText('WebSpeak · '+state.textContent, 45, 100); ctx.fillRect(40 + frame++ % 800, 200, 80, 180); ctx.fillText('Frame '+frame, 45, 480); }, 66);
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => {
    const stream = canvas.captureStream(15); const dest = audio.createMediaStreamDestination(), osc = audio.createOscillator(), gain = audio.createGain();
    gain.gain.value = 0.03; osc.frequency.value = 440; osc.connect(gain).connect(dest); osc.start();
    stream.addTrack(dest.stream.getAudioTracks()[0]); tracks.push(...stream.getTracks());
    stream.getVideoTracks()[0].addEventListener('ended', () => osc.stop(), { once: true });
    document.querySelector('#preview').srcObject = stream; return stream;
  } });
  try {
    audio = new AudioContext(); await audio.resume();
    await wait(() => owner.connected && viewer.connected, 'Protected channel connection');
    if (owner.controller.api.screenShareRelays.value.length !== 2) throw new Error('Both production nodes must be advertised');
    for (const [route, transport] of [['p2p', null], ['macau', 'udp'], ['shenzhen', 'udp'], ['macau', 'tcp'], ['shenzhen', 'tcp']]) {
      protocol = transport; state.textContent = `${route} ${transport ?? 'direct'}`;
      const start = peers.length;
      await owner.controller.api.startScreenShare(true, { route, maxWidth: 960, maxHeight: 540, maxFrameRate: 15 });
      await wait(() => owner.controller.api.screenShareActive.value, 'Publisher start: '+owner.controller.api.screenShareError.value);
      const streamId = owner.controller.api.screenShareActiveStreamId.value;
      await wait(() => viewer.controller.api.screenShareStreams.some(s => s.streamId === streamId), 'Share announcement');
      await viewer.controller.api.joinScreenShare(streamId);
      await wait(() => viewer.controller.api.screenShareRemoteStream.value, 'Remote media: '+viewer.controller.api.screenShareError.value);
      document.querySelector('#remote').srcObject = viewer.controller.api.screenShareRemoteStream.value;
      await document.querySelector('#remote').play();
      await wait(() => peers.slice(start).length === 2 && peers.slice(start).every(p => p.connectionState === 'connected'), 'ICE/DTLS connection');
      await delay(2200);
      const snapshots = await Promise.all(peers.slice(start).map(async p => {
        const stats = [...(await p.getStats()).values()];
        const selected = stats.find(s => s.type === 'transport' && s.selectedCandidatePairId);
        const pair = stats.find(s => s.id === selected?.selectedCandidatePairId);
        const local = stats.find(s => s.id === pair?.localCandidateId), remote = stats.find(s => s.id === pair?.remoteCandidateId);
        const inbound = stats.filter(s => s.type === 'inbound-rtp');
        return { policy: p.testConfig.iceTransportPolicy ?? 'all', local: { type: local?.candidateType, address: local?.address, relayProtocol: local?.relayProtocol }, remote: { type: remote?.candidateType, address: remote?.address }, bytesSent: pair?.bytesSent, bytesReceived: pair?.bytesReceived, videoFrames: inbound.find(s => s.kind === 'video')?.framesDecoded ?? 0, audioPackets: inbound.find(s => s.kind === 'audio')?.packetsReceived ?? 0 };
      }));
      const receiver = snapshots.find(s => s.videoFrames > 0), publisher = snapshots.find(s => s.policy === 'relay');
      if (!receiver || receiver.audioPackets < 1) throw new Error('Video/audio did not decode');
      if (route !== 'p2p' && (!publisher || publisher.local.type !== 'relay' || publisher.local.relayProtocol !== transport)) throw new Error('Selected TURN route was not used');
      if (route === 'p2p' && snapshots.some(s => s.local.type === 'relay')) throw new Error('P2P unexpectedly relayed');
      report.cases.push({ route, transport, passed: true, snapshots });
      result.textContent = JSON.stringify(report, null, 2);
      viewer.controller.api.leaveScreenShare(); owner.controller.api.stopScreenShare();
      await wait(() => !viewer.controller.api.screenShareStreams.some(s => s.streamId === streamId), 'Share cleanup');
    }
    report.status = 'passed'; state.textContent = '五条路径：视频及音频全部通过';
  } catch (error) { report.status = 'failed'; report.error = error.message; state.textContent = '验证失败：'+error.message; }
  finally {
    owner.controller.stopTransport(true); viewer.controller.stopTransport(true);
    owner.socket.close(); viewer.socket.close(); clearInterval(timer); tracks.forEach(t => t.stop()); await audio?.close();
    result.textContent = JSON.stringify(report, null, 2);
    await fetch('/screen-relay-check/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
  }
};
