import { createScreenShareController } from '/src/voice/screen-share.ts';
const state = document.querySelector('#state'), result = document.querySelector('#result');
const crossNetwork = location.hash === '#remote';
const bitrateCheck = location.hash === '#bitrate';
const cloudflareCheck = location.hash.includes('cloudflare');
const aliyunCheck = location.hash.includes('aliyun');
let networkScenario = null;
const cases = aliyunCheck ? [['aliyun','udp'],['aliyun','tcp'],['aliyun','tls'],['auto',null]] : cloudflareCheck ? [['cloudflare','udp'],['cloudflare','tcp'],['cloudflare','tls'],['auto',null]] : crossNetwork ? [['macau', 'udp'], ['macau', 'tcp']] : bitrateCheck ? [['p2p', null]] : [['p2p', null], ['shenzhen', 'udp'], ['shenzhen', 'tcp']];
document.querySelector('#start').textContent = aliyunCheck ? '开始阿里云与自动线路验收' : cloudflareCheck ? '开始 Cloudflare 与自动线路验收' : crossNetwork ? '开始澳门跨网往返测试' : bitrateCheck ? '开始实时码率验收' : '开始 P2P 与深圳线路测试';
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
async getStats(...args) {
  const report = await super.getStats(...args);
  if (!networkScenario || !this.getSenders().some(s => s.track?.kind === 'video')) return report;
  // Explicitly simulated congestion feedback; media still uses real WebRTC.
  return new Map([...report].map(([id, stats]) => [id, stats.type === 'candidate-pair'
    ? { ...stats, availableOutgoingBitrate: networkScenario === 'congested' ? 1_000_000 : 32_000_000 }
    : stats.type === 'outbound-rtp' ? { ...stats, qualityLimitationReason: 'none' } : stats]));
}
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
      m.relay.iceServers = m.relay.iceServers.map(s => ({ ...s, urls: [].concat(s.urls).filter(url => protocol === "tls" ? url.startsWith("turns:") && url.endsWith("transport=tcp") : url.startsWith("turn:") && url.endsWith(`transport=${protocol}`)) })).filter(s => s.urls.length);
    }
    controller.handleMessage(m);
  };
  return p;
}
document.querySelector('#start').onclick = async event => {
  event.target.disabled = true;
  const report = { status: 'running', checkedAt: new Date().toISOString(), scope: location.hash === '#local-cloudflare' ? 'Local production coordinator; real Cloudflare TURN, synthetic canvas and oscillator.' : crossNetwork ? 'Production WSS; Macau browser and Shenzhen RTP reflector; synthetic media crosses Macau TURN and returns for browser decoding.' : 'Production WSS and ICE configuration; two browser peers on one Macau Windows host; synthetic canvas and oscillator only.', cases: [] };
  const owner = participant(), viewer = crossNetwork ? null : participant();
  const canvas = document.createElement('canvas'); canvas.width = bitrateCheck ? 1920 : 960; canvas.height = bitrateCheck ? 1080 : 540;
  const ctx = canvas.getContext('2d'); let frame = 0, tracks = [], audio;
  const timer = setInterval(() => { ctx.fillStyle = '#123c40'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#92e3c4'; ctx.font = '42px sans-serif'; ctx.fillText('WebSpeak · '+state.textContent, 45, 100); ctx.fillRect(40 + frame++ % 800, 200, 80, 180); ctx.fillText('Frame '+frame, 45, 480);
    if (bitrateCheck) for (let i = 0; i < 400; i++) { ctx.fillStyle = `hsl(${(i * 37 + frame * 3) % 360} 70% 55%)`; ctx.fillRect((i * 73 + frame * 5) % 1920, 540 + i % 16 * 32, 24, 24); }
  }, bitrateCheck ? 16 : 66);
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => {
    const stream = canvas.captureStream(bitrateCheck ? 60 : 15); const dest = audio.createMediaStreamDestination(), osc = audio.createOscillator(), gain = audio.createGain();
    gain.gain.value = 0.03; osc.frequency.value = 440; osc.connect(gain).connect(dest); osc.start();
    stream.addTrack(dest.stream.getAudioTracks()[0]); tracks.push(...stream.getTracks());
    stream.getVideoTracks()[0].addEventListener('ended', () => osc.stop(), { once: true });
    document.querySelector('#preview').srcObject = stream; return stream;
  } });
  try {
    audio = new AudioContext(); await audio.resume();
    await wait(() => owner.connected && (!viewer || viewer.connected), 'Protected channel connection');
    if (aliyunCheck ? !owner.controller.api.screenShareRelays.value.includes('aliyun') : cloudflareCheck ? !owner.controller.api.screenShareRelays.value.includes('cloudflare') : !['macau','shenzhen'].every(r=>owner.controller.api.screenShareRelays.value.includes(r))) throw new Error('Required relays must be advertised');
    for (const [route, transport] of cases) {
      protocol = transport; state.textContent = `${route} ${transport ?? 'direct'}`;
      const start = peers.length;
      await owner.controller.api.startScreenShare(true, { route, maxWidth: canvas.width, maxHeight: canvas.height, maxFrameRate: bitrateCheck ? 60 : 15 });
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
      // Exceed Lucky's 30-second UDP idle timeout to exercise active consent traffic.
      await delay(aliyunCheck ? 45000 : 2200);
      const snapshots = await Promise.all(peers.slice(start).map(async p => {
        const stats = [...(await p.getStats()).values()];
        const selected = stats.find(s => s.type === 'transport' && s.selectedCandidatePairId);
        const pair = stats.find(s => s.id === selected?.selectedCandidatePairId);
        const local = stats.find(s => s.id === pair?.localCandidateId), remote = stats.find(s => s.id === pair?.remoteCandidateId);
        const inbound = stats.filter(s => s.type === 'inbound-rtp');
        const video = inbound.find(s => s.kind === 'video');
        return { policy: p.testConfig.iceTransportPolicy ?? 'all', local: { type: local?.candidateType, address: local?.address, relayProtocol: local?.relayProtocol, url: local?.url }, remote: { type: remote?.candidateType, address: remote?.address }, bytesSent: pair?.bytesSent, bytesReceived: pair?.bytesReceived, rtt: pair?.currentRoundTripTime, videoFrames: video?.framesDecoded ?? 0, videoWidth: video?.frameWidth, videoHeight: video?.frameHeight, videoFps: video?.framesPerSecond, videoPacketsLost: video?.packetsLost, audioPackets: inbound.find(s => s.kind === 'audio')?.packetsReceived ?? 0 };
      }));
      const receiver = snapshots.find(s => s.videoFrames > 0), publisher = snapshots.find(s => s.policy === 'relay');
      if (!receiver || receiver.audioPackets < 1) throw new Error('Video/audio did not decode');
      if (route !== 'p2p' && route !== 'auto' && (!publisher || publisher.local.type !== 'relay' || publisher.local.relayProtocol !== transport)) throw new Error('Selected TURN route was not used');
      if (route === 'p2p' && snapshots.some(s => s.local.type === 'relay')) throw new Error('P2P unexpectedly relayed');
      report.cases.push({ route, transport, passed: true, snapshots });
      if (bitrateCheck) {
        const publisherPeer = peers.slice(start).find(p => p.getSenders().some(s => s.track?.kind === 'video'));
        const sender = publisherPeer.getSenders().find(s => s.track?.kind === 'video');
        report.bitrate = { feedback: 'Congestion and recovery estimates are simulated; setter, peer lifetime and decoded media are real.', steps: [] };
        for (const mbps of [2, 16]) {
          state.textContent = '手动 '+mbps+' Mbps';
          if (!await owner.controller.api.updateScreenShareBitrateSettings({ bitrateMode: 'manual', bitrateMbps: mbps })) throw new Error('Manual control rejected');
          const p = sender.getParameters();
          if (p.encodings[0].maxBitrate !== mbps * 1_000_000 || p.degradationPreference !== 'maintain-resolution') throw new Error('Manual encoder settings not applied');
          report.bitrate.steps.push({ mode: 'manual', mbps, applied: true });
        }
        for (const [policy, degradation] of [['quality', 'maintain-resolution'], ['smooth', 'maintain-framerate'], ['balanced', 'balanced']]) {
          if (!await owner.controller.api.updateScreenShareBitrateSettings({ bitrateMode: 'auto', bitratePolicy: policy })) throw new Error('Adaptive policy rejected');
          if (sender.getParameters().degradationPreference !== degradation) throw new Error('Wrong degradation strategy');
          report.bitrate.steps.push({ mode: 'auto', policy, applied: true });
        }
        const initial = sender.getParameters().encodings[0].maxBitrate;
        networkScenario = 'congested'; state.textContent = '模拟拥塞：检查自动降码率';
        await wait(() => sender.getParameters().encodings[0].maxBitrate < initial * .7, 'Adaptive decrease', 16000);
        const reduced = sender.getParameters().encodings[0].maxBitrate;
        networkScenario = 'recovered'; state.textContent = '模拟恢复：检查自动升码率';
        await wait(() => sender.getParameters().encodings[0].maxBitrate > reduced * 1.1, 'Adaptive recovery', 20000);
        const recovered = sender.getParameters().encodings[0].maxBitrate;
        networkScenario = null;
        if (peers.length !== start + 2 || owner.controller.api.screenShareActiveStreamId.value !== streamId || publisherPeer.connectionState !== 'connected') throw new Error('Live update replaced the share');
        const finalStats = [...(await peers.slice(start).find(p => p !== publisherPeer).getStats()).values()].find(s => s.type === 'inbound-rtp' && s.kind === 'video');
        if (!finalStats?.framesDecoded || finalStats.frameWidth !== 1920 || finalStats.frameHeight !== 1080) throw new Error('1080p video did not decode');
        report.bitrate.adaptation = { initial, reduced, recovered, samePeerAndCapture: true, decodedWidth: finalStats.frameWidth, decodedHeight: finalStats.frameHeight, decodedFrames: finalStats.framesDecoded, framesPerSecond: finalStats.framesPerSecond };
      }
      result.textContent = JSON.stringify(report, null, 2);
      viewer?.controller.api.leaveScreenShare(); owner.controller.api.stopScreenShare();
      document.querySelector('#remote').srcObject = null;
      await wait(() => !owner.controller.api.screenShareStreams.some(s => s.streamId === streamId), 'Share cleanup');
    }
    report.status = 'passed'; state.textContent = bitrateCheck ? '手动、三种自动策略及实时升降码率全部通过' : `${cases.length} 条路径：视频及音频全部通过`;
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
