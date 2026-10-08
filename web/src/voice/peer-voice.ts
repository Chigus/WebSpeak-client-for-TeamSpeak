import { ref } from "vue";
import type { PeerVoiceClientMessage, PeerVoiceServerMessage, VoicePeer } from "../../../src/shared/peer-voice.js";
import { normalizeScreenShareIceServers, type ScreenSharePeerSignal } from "../../../src/shared/screen-share.js";

interface Peer {
  descriptor: VoicePeer;
  connectionId: string;
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  pendingIce: RTCIceCandidateInit[];
  localIce: ScreenSharePeerSignal[];
  descriptionSent: boolean;
  serial: Promise<void>;
  sequence: number | null;
  receivedAt: number;
  deadline: ReturnType<typeof setTimeout>;
}
interface Options {
  send(message: PeerVoiceClientMessage): void;
  onPcm(clientId: number, pcm: Int16Array, channels: 1 | 2): boolean;
  onRetired(clientId: number): void;
}
const LABEL = "webspeak-pcm-v1";
const STALE_MS = 250;

/** Small opt-in mesh; 20 ms PCM retains independent ears without browser RTP mixing. */
export function createPeerVoice(options: Options, dependencies: {
  createPeer?: (configuration: RTCConfiguration) => RTCPeerConnection;
  now?: () => number;
} = {}) {
  const supported = ref(typeof RTCPeerConnection !== "undefined" || Boolean(dependencies.createPeer));
  const enabled = ref(false);
  const available = ref(false);
  const status = ref<"off" | "waiting" | "connecting" | "active" | "fallback" | "limited">("off");
  const connectedPeers = ref(0);
  const peers = new Map<string, Peer>();
  const retryAfter = new Map<string, number>();
  const now = dependencies.now ?? (() => performance.now());
  let selfPeerId = "", active = false, sequence = 0, generation = 0;
  let iceServers: RTCIceServer[] = normalizeScreenShareIceServers();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticks = 0;
  let limited = false;
  let roster: VoicePeer[] = [];
  const createPeer = dependencies.createPeer ?? (configuration => new RTCPeerConnection(configuration));
  const clean = (operation: () => void) => { try { operation(); } catch { /* Release independent resources. */ } };
  const current = (peer: Peer) => active && enabled.value && peers.get(peer.descriptor.peerId) === peer;
  function send(message: PeerVoiceClientMessage): void { if (active) options.send(message); }
  function updateStatus() {
    connectedPeers.value = [...peers.values()].filter(peer => peer.channel?.readyState === "open").length;
    status.value = !enabled.value ? "off" : limited ? "limited" : !active || !roster.length ? "waiting"
      : connectedPeers.value ? "active" : peers.size ? "connecting" : "fallback";
  }
  function retire(peerId: string, retry = false) {
    const peer = peers.get(peerId);
    if (!peer) return;
    peers.delete(peerId);
    if (retry) retryAfter.set(peerId, now() + 15_000);
    clearTimeout(peer.deadline);
    peer.pc.onicecandidate = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.ondatachannel = null;
    if (peer.channel) {
      peer.channel.onopen = null; peer.channel.onmessage = null;
      peer.channel.onclose = null; peer.channel.onerror = null;
      clean(() => peer.channel!.close());
    }
    clean(() => peer.pc.close());
    clean(() => options.onRetired(peer.descriptor.clientId));
    updateStatus();
  }
  function fail(peer: Peer) {
    if (!current(peer)) return;
    clean(() => signal(peer, { kind: "close" }));
    retire(peer.descriptor.peerId, true);
  }
  function signal(peer: Peer, value: ScreenSharePeerSignal) {
    if (current(peer)) send({ type: "peerVoiceSignal", targetPeerId: peer.descriptor.peerId, connectionId: peer.connectionId, signal: value });
  }
  function publishDescription(peer: Peer, kind: "offer" | "answer") {
    signal(peer, { kind, sdp: peer.pc.localDescription!.sdp });
    peer.descriptionSent = true;
    for (const candidate of peer.localIce.splice(0)) signal(peer, candidate);
  }
  function attachChannel(peer: Peer, channel: RTCDataChannel) {
    if (!current(peer) || peer.channel || channel.label !== LABEL || channel.ordered || channel.maxRetransmits !== 0) {
      clean(() => channel.close()); return;
    }
    peer.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => { if (current(peer)) { clearTimeout(peer.deadline); updateStatus(); } };
    channel.onclose = channel.onerror = () => fail(peer);
    channel.onmessage = event => {
      if (!current(peer) || !(event.data instanceof ArrayBuffer)) return;
      const packet = event.data;
      if (packet.byteLength !== 1928 && packet.byteLength !== 3848) return;
      const view = new DataView(packet);
      const channels = view.getUint8(1);
      if (view.getUint8(0) !== 1 || (channels !== 1 && channels !== 2) || packet.byteLength !== 8 + channels * 1920) return;
      const incoming = view.getUint32(4, true);
      // Wrap-safe latest-packet ordering. Late datagrams never grow a queue.
      if (peer.sequence !== null && now() - peer.receivedAt < 1000) {
        const difference = (incoming - peer.sequence) >>> 0;
        if (difference === 0 || difference >= 0x80000000) return;
      }
      const pcm = new Int16Array(channels * 960);
      for (let index = 0; index < pcm.length; index++) pcm[index] = view.getInt16(8 + index * 2, true);
      try {
        if (!options.onPcm(peer.descriptor.clientId, pcm, channels)) { fail(peer); return; }
        peer.sequence = incoming;
        peer.receivedAt = now();
      } catch { fail(peer); }
    };
  }
  function makePeer(descriptor: VoicePeer, connectionId: string): Peer {
    const pc = createPeer({ iceServers });
    const peer: Peer = { descriptor, connectionId, pc, channel: null, pendingIce: [], localIce: [], descriptionSent: false,
      sequence: null, receivedAt: -Infinity, serial: Promise.resolve(), deadline: setTimeout(() => fail(peer), 12_000) };
    peers.set(descriptor.peerId, peer);
    pc.onicecandidate = event => {
      if (!current(peer) || !event.candidate) return;
      try {
        const value: ScreenSharePeerSignal = { kind: "iceCandidate", ...event.candidate.toJSON(), candidate: event.candidate.candidate };
        if (peer.descriptionSent) signal(peer, value);
        else if (peer.localIce.length < 64) peer.localIce.push(value);
        else fail(peer);
      } catch { fail(peer); }
    };
    pc.onconnectionstatechange = () => {
      if (current(peer) && ["failed", "closed", "disconnected"].includes(pc.connectionState)) fail(peer);
    };
    pc.ondatachannel = event => attachChannel(peer, event.channel);
    updateStatus();
    return peer;
  }
  async function offer(descriptor: VoicePeer) {
    let peer: Peer | undefined;
    try {
      peer = makePeer(descriptor, crypto.randomUUID());
      attachChannel(peer, peer.pc.createDataChannel(LABEL, { ordered: false, maxRetransmits: 0 }));
      const description = await peer.pc.createOffer();
      if (!current(peer)) return;
      await peer.pc.setLocalDescription(description);
      if (current(peer)) publishDescription(peer, "offer");
    } catch { if (peer) fail(peer); else retryAfter.set(descriptor.peerId, now() + 15_000); }
  }
  function syncRoster() {
    for (const [id, peer] of peers) {
      if (!roster.some(other => other.peerId === id && other.clientId === peer.descriptor.clientId)) retire(id);
    }
    for (const descriptor of roster) {
      if (selfPeerId < descriptor.peerId && !peers.has(descriptor.peerId) && (retryAfter.get(descriptor.peerId) ?? 0) <= now()) void offer(descriptor);
    }
    updateStatus();
  }
  function stop() {
    active = false; generation++;
    clearInterval(timer); timer = undefined;
    for (const id of peers.keys()) retire(id);
    retryAfter.clear(); roster = []; selfPeerId = ""; limited = false;
    updateStatus();
  }
  function begin() {
    if (!available.value || !supported.value || !enabled.value) return;
    active = true;
    try { send({ type: "peerVoiceJoin", enabled: true }); }
    catch { stop(); status.value = "fallback"; return; }
    const ownGeneration = generation;
    timer = setInterval(() => {
      if (!active || generation !== ownGeneration) return;
      try {
        send({ type: "peerVoiceReceiving", peerIds: [...peers.values()].filter(peer => now() - peer.receivedAt < STALE_MS).map(peer => peer.descriptor.peerId) });
        if (++ticks % 5 === 0) { send({ type: "peerVoiceJoin", enabled: true }); syncRoster(); }
      } catch { stop(); status.value = "fallback"; }
    }, 200);
    updateStatus();
  }
  function handleMessage(message: PeerVoiceServerMessage) {
    if (!active || !enabled.value) return;
    if (message.type === "peerVoiceRoster") {
      if (selfPeerId && selfPeerId !== message.selfPeerId) {
        for (const id of peers.keys()) retire(id);
        retryAfter.clear();
      }
      selfPeerId = message.selfPeerId; limited = message.limited;
      roster = message.peers.filter(peer => peer.peerId !== selfPeerId);
      syncRoster();
      return;
    }
    const descriptor = roster.find(peer => peer.peerId === message.fromPeerId);
    if (!descriptor) return;
    let peer = peers.get(message.fromPeerId);
    const value = message.signal;
    if (value.kind === "offer") {
      if (selfPeerId < descriptor.peerId) return; // One deterministic offerer; no glare.
      if (peer && peer.connectionId !== message.connectionId) { retire(descriptor.peerId); peer = undefined; }
      try { peer ??= makePeer(descriptor, message.connectionId); }
      catch { updateStatus(); return; }
    }
    if (!peer || peer.connectionId !== message.connectionId) return;
    const owned = peer;
    owned.serial = owned.serial.then(async () => {
      if (!current(owned)) return;
      if (value.kind === "close") { retire(descriptor.peerId, true); return; }
      if (value.kind === "iceCandidate") {
        const { kind: _, ...candidate } = value;
        if (!owned.pc.remoteDescription) {
          if (owned.pendingIce.length >= 64) { fail(owned); return; }
          owned.pendingIce.push(candidate);
        } else await owned.pc.addIceCandidate(candidate);
        return;
      }
      await owned.pc.setRemoteDescription({ type: value.kind, sdp: value.sdp });
      if (!current(owned)) return;
      for (const candidate of owned.pendingIce.splice(0)) {
        await owned.pc.addIceCandidate(candidate);
        if (!current(owned)) return;
      }
      if (value.kind === "offer") {
        const answer = await owned.pc.createAnswer();
        if (!current(owned)) return;
        await owned.pc.setLocalDescription(answer);
        if (current(owned)) publishDescription(owned, "answer");
      }
    }).catch(() => fail(owned));
  }
  return {
    enabled, supported, available, status, connectedPeers,
    connect(isAvailable: boolean, configuration?: readonly unknown[]) {
      stop(); available.value = isAvailable; iceServers = normalizeScreenShareIceServers(configuration);
      begin();
    },
    disconnect() { stop(); available.value = false; },
    setEnabled(value: boolean) {
      if (enabled.value === value) return;
      if (active) clean(() => send({ type: "peerVoiceJoin", enabled: false }));
      stop(); enabled.value = value && supported.value; begin(); updateStatus();
    },
    handleMessage,
    receiving(clientId: number) { return [...peers.values()].some(peer => peer.descriptor.clientId === clientId && now() - peer.receivedAt < STALE_MS); },
    sendPcm(pcm: Int16Array, channels: 1 | 2) {
      if (!active || pcm.length !== 960 * channels) return;
      const packet = new ArrayBuffer(8 + pcm.byteLength);
      const view = new DataView(packet);
      view.setUint8(0, 1); view.setUint8(1, channels); view.setUint32(4, sequence++ >>> 0, true);
      for (let index = 0; index < pcm.length; index++) view.setInt16(8 + index * 2, pcm[index]!, true);
      for (const peer of peers.values()) {
        if (peer.channel?.readyState !== "open" || peer.channel.bufferedAmount > pcm.byteLength * 3) continue;
        try { peer.channel.send(packet); } catch { fail(peer); }
      }
    },
  };
}
