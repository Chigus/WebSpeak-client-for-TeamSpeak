import { createScreenShareController } from '/src/voice/screen-share.ts';
const state = document.querySelector('#state'), result = document.querySelector('#result');
const crossNetwork = location.hash === '#remote';
const cases = crossNetwork ? [['macau', 'udp'], ['macau', 'tcp']] : [['p2p', null], ['shenzhen', 'udp'], ['shenzhen', 'tcp']];
document.querySelector('#start').textContent = crossNetwork ? '开始澳门跨网往返测试' : '开始 P2P 与深圳线路测试';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(check, label, timeout = 25000) {
  const until = Date.now() + timeout;
  while (!check()) { if (Date.now() > until) throw new Error(label); await delay(100); }
}
const realPeer = window.RTCPeerConnection, peers = [];
const diagnosticKeys = new Set(['id', 'type', 'localCandidateId', 'remoteCandidateId', 'address', 'port', 'candidateType', 'state', 'requestsSent', 'responsesReceived', 'requestsReceived', 'bytesSent', 'bytesReceived', 'relayProtocol']);
window.RTCPeerConnection = class extends realPeer { constructor(config) {
  super(config); this.testConfig = config; this.candidates = []; this.errors = []; this.samples = []; this.remoteCandidates = []; peers.push(this);
  this.sampleTimer = setInterval(async () => { try {
    this.samples = [[...(await this.getStats()).values()]
      .filter(s => ['candidate-pair', 'local-candidate', 'remote-candidate'].includes(s.type))
      .map(s => Object.fromEntries(Object.entries(s).filter(([key]) => diagnosticKeys.has(key))))];
  } catch {} }, 2000);
  this.addEventListener('icecandidate', e => { if (e.candidate) this.candidates.push({ type: e.candidate.type, address: e.candidate.address, port: e.candidate.port, protocol: e.candidate.protocol, relayProtocol: e.candidate.relayProtocol }); });
  this.addEventListener('icecandidateerror', e => this.errors.push({ code: e.errorCode, text: e.errorText, url: e.url }));
  if (crossNetwork) this.addEventListener('track', e => {
    const video = document.querySelector('#remote');
    const stream = video.srcObject ?? new MediaStream(); stream.addTrack(e.track); video.srcObject = stream;
    void video.play().catch(() => {});
  });
}
async addIceCandidate(c) { this.remoteCandidates.push(c?.candidate?.replace(/ ufrag .*/,'')); return super.addIceCandidate(c); }
close() { clearInterval(this.sampleTimer); return super.close(); }
};
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
  const report = { status: 'running', checkedAt: new Date().toISOString(), scope: crossNetwork ? 'Production WSS; Macau browser and Shenzhen RTP reflector; synthetic media crosses Macau TURN and returns for browser decoding.' : 'Production WSS and ICE configuration; two browser peers on one Macau Windows host; synthetic canvas and oscillator only.', cases: [] };
  const owner = participant(), viewer = crossNetwork ? null : participant();
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
    await wait(() => owner.connected && (!viewer || viewer.connected), 'Protected channel connection');
    if (owner.controller.api.screenShareRelays.value.length !== 2) throw new Error('Both production nodes must be advertised');
    for (const [route, transport] of cases) {
      protocol = transport; state.textContent = `${route} ${transport ?? 'direct'}`;
      const start = peers.length;
      await owner.controller.api.startScreenShare(true, { route, maxWidth: 960, maxHeight: 540, maxFrameRate: 15 });
      await wait(() => owner.controller.api.screenShareActive.value, 'Publisher start: '+owner.controller.api.screenShareError.value);
      const streamId = owner.controller.api.screenShareActiveStreamId.value;
      if (viewer) {
        await wait(() => viewer.controller.api.screenShareStreams.some(s => s.streamId === streamId), 'Share announcement');
        await viewer.controller.api.joinScreenShare(streamId);
        await wait(() => viewer.controller.api.screenShareRemoteStream.value, 'Remote media: '+viewer.controller.api.screenShareError.value);
        document.querySelector('#remote').srcObject = viewer.controller.api.screenShareRemoteStream.value;
      } else await wait(() => document.querySelector('#remote').srcObject, 'Cross-network return stream');
      await document.querySelector('#remote').play();
      await wait(() => peers.slice(start).length === (crossNetwork ? 1 : 2) && peers.slice(start).every(p => p.connectionState === 'connected'), 'ICE/DTLS connection');
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
      viewer?.controller.api.leaveScreenShare(); owner.controller.api.stopScreenShare();
      document.querySelector('#remote').srcObject = null;
      await wait(() => !owner.controller.api.screenShareStreams.some(s => s.streamId === streamId), 'Share cleanup');
    }
    report.status = 'passed'; state.textContent = `${cases.length} 条路径：视频及音频全部通过`;
  } catch (error) {
    report.status = 'failed'; report.error = error.message; state.textContent = '验证失败：'+error.message;
    report.debug = peers.map(p => ({ policy: p.testConfig.iceTransportPolicy ?? 'all', connection: p.connectionState, ice: p.iceConnectionState, gathering: p.iceGatheringState, candidates: p.candidates, remoteCandidates:p.remoteCandidates,samples:p.samples, errors: p.errors }));
  }
  finally {
    owner.controller.stopTransport(true); viewer?.controller.stopTransport(true);
    owner.socket.close(); viewer?.socket.close(); clearInterval(timer); tracks.forEach(t => t.stop()); await audio?.close();
    result.textContent = JSON.stringify(report, null, 2);
    await fetch('/screen-relay-check/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
  }
};
