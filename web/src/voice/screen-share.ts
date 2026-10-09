import { reactive, ref } from "vue";
import { createScreenShareEncoder, normalizeScreenShareBitrate, type ScreenShareBitrateSettings, type ScreenShareBitrateMode, type ScreenShareBitratePolicy, type ScreenShareBitrateReason } from "./screen-share-bitrate.js";
import { isScreenShareRelayId, MAX_SCREEN_SHARE_ICE_SERVERS, parseScreenShareRelayCredentials, type ScreenShareRelayCredentials, type ScreenShareRelayId, type ScreenShareRoute } from "../../../src/shared/screen-share.js";
import { parseScreenShareStream, parseScreenShareViewers, type ServerMessage } from "../../../src/shared/server-messages.js";
import { normalizeScreenShareIceServers, type ScreenShareIceServer, type ScreenShareClientMessage, type ScreenShareStreamDescription as ScreenShareStream, type ScreenSharePeerSignal as ScreenShareSignal } from "../../../src/shared/screen-share.js";

const SCREEN_SHARE_NEGOTIATION_TIMEOUT_MS = 15_000;

export interface ScreenShareOutputSettings extends ScreenShareBitrateSettings {
  route?: ScreenShareRoute;
  maxWidth?: number;
  maxHeight?: number;
  maxFrameRate?: number;
}

export interface ScreenShareCaptureStats {
  width: number | null;
  height: number | null;
  frameRate: number | null;
}

export interface ScreenSharePeerStats {
  peerId: string;
  role: "owner" | "viewer";
  direction: "outbound" | "inbound";
  connectionState: string;
  iceConnectionState: string;
  codec: string | null;
  candidateType: string | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  bitrateKbps: number | null;
  packetsLost: number | null;
  packetsTotal: number | null;
  lossPercent: number | null;
  framesDropped: number | null;
  jitterMs: number | null;
  roundTripTimeMs: number | null;
  availableOutgoingBitrateKbps: number | null;
  qualityLimitationReason: string | null;
  intervalLossPercent?: number | null;
  targetBitrateKbps?: number | null;
  bitrateMode?: ScreenShareBitrateMode;
  bitratePolicy?: ScreenShareBitratePolicy;
  bitrateReason?: ScreenShareBitrateReason;
  bitrateControlSupported?: boolean | null;
  bitrateStrategySupported?: boolean;
}

export interface ScreenShareWebRtcStats {
  updatedAt: number | null;
  capture: ScreenShareCaptureStats | null;
  peers: ScreenSharePeerStats[];
}

interface ScreenShareTransport {
  isOpen(): boolean;
  send(message: ScreenShareClientMessage): void;
}

/** Owns one session's capture tracks, peers, signaling and diagnostics. */
export function createScreenShareController(transport: ScreenShareTransport) {
  let screenShareIceServers: RTCIceServer[] = normalizeScreenShareIceServers();
  const screenShareRelays = ref<ScreenShareRelayId[]>([]);
  let screenShareOwnerRelay: ScreenShareRelayCredentials | null = null;
  let screenShareViewerRelay: ScreenShareRelayCredentials | null = null;
  const screenShareStreams = reactive<ScreenShareStream[]>([]);
  const screenShareActive = ref(false);
  const screenShareStarting = ref(false);
  const screenShareActiveStreamId = ref("");
  const screenShareViewing = ref(false);
  const screenShareViewingStreamId = ref("");
  const screenShareRemoteStream = ref<MediaStream | null>(null);
  const screenShareError = ref("");
  const screenShareErrorCode = ref("");
  const screenShareRemoteVolume = ref(1);
  let screenShareLocalStream: MediaStream | null = null;
  // These are encoder/output limits. The display track itself must keep the
  // source resolution so selecting a high-resolution desktop or game window
  // never changes that source before capture.
  let screenShareOutputSettings: ScreenShareOutputSettings | null = null;
  const screenSharePeers = new Map<string, RTCPeerConnection>();
  const screenSharePeerRoles = new Map<string, "owner" | "viewer">();
  const screenShareEncoders = new Map<string, ReturnType<typeof createScreenShareEncoder>>();
  const screenShareWebRtcStats = reactive<ScreenShareWebRtcStats>({ updatedAt: null, capture: null, peers: [] });
  const screenShareStatsPrevious = new Map<string, { sampledAt: number; mediaId: string | null; bytes: number | null; frames: number | null; lost: number | null; packets: number | null }>();
  let screenShareStatsTimer: ReturnType<typeof setInterval> | null = null;
  let screenShareStatsCollecting = false;
  let screenShareStatsGeneration = 0;
  const screenSharePendingIce = new Map<string, RTCIceCandidateInit[]>();
  const screenSharePeerStreams = new Map<string, MediaStream>();
  const screenSharePeerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let screenShareRequestSequence = 0;
  let screenSharePendingStartId = "";
  let screenShareStartCancelled = false;
  let screenShareStartGeneration = 0;

  function sendScreenShareMessage(message: ScreenShareClientMessage): void {
    if (transport.isOpen()) transport.send(message);
  }

  type ScreenShareStatsRecord = Record<string, unknown>;

  function screenShareStatsRecord(value: unknown): ScreenShareStatsRecord {
    return value && typeof value === "object" ? value as ScreenShareStatsRecord : {};
  }

  function screenShareStatsNumber(stats: ScreenShareStatsRecord | undefined, key: string): number | null {
    const value = stats?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function screenShareStatsString(stats: ScreenShareStatsRecord | undefined, key: string): string | null {
    const value = stats?.[key];
    return typeof value === "string" && value ? value : null;
  }

  function screenShareVideoStatsKind(stats: ScreenShareStatsRecord): string {
    return screenShareStatsString(stats, "kind") ?? screenShareStatsString(stats, "mediaType") ?? "";
  }

  function screenShareStatsCapture(): ScreenShareCaptureStats | null {
    const track = screenShareLocalStream?.getVideoTracks()[0];
    if (!track) return null;
    const settings = track.getSettings();
    return {
      width: typeof settings.width === "number" ? settings.width : null,
      height: typeof settings.height === "number" ? settings.height : null,
      frameRate: typeof settings.frameRate === "number" ? settings.frameRate : null,
    };
  }

  async function collectScreenSharePeerStats(peerId: string, peer: RTCPeerConnection, role: "owner" | "viewer"): Promise<ScreenSharePeerStats | null> {
    try {
      const report = await peer.getStats();
      if (!isCurrentPeer(peerId, peer)) return null;
      const records = new Map<string, ScreenShareStatsRecord>();
      let mediaStats: ScreenShareStatsRecord | undefined;
      let remoteInboundStats: ScreenShareStatsRecord | undefined;
      let trackStats: ScreenShareStatsRecord | undefined;
      let candidatePairStats: ScreenShareStatsRecord | undefined;
      report.forEach((raw) => {
        const stats = screenShareStatsRecord(raw);
        const id = screenShareStatsString(stats, "id");
        if (id) records.set(id, stats);
        const type = screenShareStatsString(stats, "type");
        const kind = screenShareVideoStatsKind(stats);
        if (type === "outbound-rtp" && kind === "video" && role === "owner") mediaStats = stats;
        if (type === "inbound-rtp" && kind === "video" && role === "viewer") mediaStats = stats;
        if (type === "remote-inbound-rtp" && kind === "video" && role === "owner") remoteInboundStats = stats;
        if (type === "track" && kind === "video") trackStats = stats;
        if (type === "candidate-pair" && (stats.selected === true || stats.nominated === true || screenShareStatsString(stats, "state") === "succeeded")) candidatePairStats = stats;
      });

      const mediaCandidates = [...records.values()].filter(stats => stats.type === (role === "owner" ? "outbound-rtp" : "inbound-rtp") && screenShareVideoStatsKind(stats) === "video"
        && screenShareStatsString(records.get(String(stats.codecId)), "mimeType")?.toLowerCase() !== "video/rtx");
      mediaStats = mediaCandidates.sort((a, b) => (screenShareStatsNumber(b, role === "owner" ? "bytesSent" : "bytesReceived") ?? 0) - (screenShareStatsNumber(a, role === "owner" ? "bytesSent" : "bytesReceived") ?? 0))[0] ?? mediaStats;
      if (role === "owner") remoteInboundStats = records.get(String(mediaStats?.remoteId))
        ?? [...records.values()].find(stats => stats.type === "remote-inbound-rtp" && stats.localId === mediaStats?.id);
      const transportStats = records.get(String(mediaStats?.transportId)) ?? [...records.values()].find(stats => stats.type === "transport" && stats.selectedCandidatePairId);
      candidatePairStats = records.get(String(transportStats?.selectedCandidatePairId)) ?? candidatePairStats;
      const codecId = screenShareStatsString(mediaStats, "codecId");
      const codecStats = codecId ? records.get(codecId) : undefined;
      const localCandidateId = screenShareStatsString(candidatePairStats, "localCandidateId");
      const localCandidate = localCandidateId ? records.get(localCandidateId) : undefined;
      const remoteCandidateId = screenShareStatsString(candidatePairStats, "remoteCandidateId");
      const remoteCandidate = remoteCandidateId ? records.get(remoteCandidateId) : undefined;
      const remoteStats = role === "owner" ? remoteInboundStats : undefined;
      const frames = screenShareStatsNumber(mediaStats, role === "owner" ? "framesEncoded" : "framesDecoded")
        ?? screenShareStatsNumber(mediaStats, role === "owner" ? "framesSent" : "framesReceived");
      const bytes = screenShareStatsNumber(mediaStats, role === "owner" ? "bytesSent" : "bytesReceived");
      const now = performance.now();
      const prior = screenShareStatsPrevious.get(peerId);
      const mediaId = screenShareStatsString(mediaStats, "id");
      const previous = prior?.mediaId === mediaId ? prior : undefined;
      const elapsedMs = previous ? now - previous.sampledAt : 0;
      const derivedFrameRate = previous && elapsedMs >= 250 && frames !== null && previous.frames !== null
        ? Math.max(0, ((frames - previous.frames) * 1_000) / elapsedMs)
        : null;
      const derivedBitrateKbps = previous && elapsedMs >= 250 && bytes !== null && previous.bytes !== null
        ? Math.max(0, ((bytes - previous.bytes) * 8) / elapsedMs)
        : null;
      const packetsLost = screenShareStatsNumber(remoteStats ?? mediaStats, "packetsLost");
      const packetsTransferred = screenShareStatsNumber(mediaStats, role === "owner" ? "packetsSent" : "packetsReceived");
      const packetsTotal = packetsTransferred === null || packetsLost === null ? null : packetsTransferred + (role === "viewer" ? Math.max(0, packetsLost) : 0);
      const lossPercent = packetsTotal && packetsTotal > 0 && packetsLost !== null ? Math.min(100, Math.max(0, packetsLost / packetsTotal * 100)) : null;
      const lostDelta = previous?.lost != null && packetsLost !== null ? packetsLost - previous.lost : null;
      const packetDelta = previous?.packets != null && packetsTransferred !== null ? packetsTransferred - previous.packets : null;
      const intervalTotal = packetDelta === null ? null : packetDelta + (role === "viewer" ? Math.max(0, lostDelta ?? 0) : 0);
      const intervalLossPercent = elapsedMs >= 750 && intervalTotal !== null && intervalTotal > 0 && lostDelta !== null && lostDelta >= 0
        ? Math.min(100, lostDelta / intervalTotal * 100) : null;
      screenShareStatsPrevious.set(peerId, { sampledAt: now, mediaId, bytes, frames, lost: packetsLost, packets: packetsTransferred });
      const currentRoundTripTime = screenShareStatsNumber(remoteStats, "roundTripTime") ?? screenShareStatsNumber(candidatePairStats, "currentRoundTripTime");
      const jitter = screenShareStatsNumber(remoteStats ?? mediaStats, "jitter");
      const directFrameRate = screenShareStatsNumber(mediaStats, "framesPerSecond") ?? screenShareStatsNumber(trackStats, "framesPerSecond");
      const directBitrateKbps = screenShareStatsNumber(mediaStats, "bitrate") !== null ? (screenShareStatsNumber(mediaStats, "bitrate") as number) / 1_000 : null;
      const sample: ScreenSharePeerStats = {
        peerId,
        role,
        direction: role === "owner" ? "outbound" : "inbound",
        connectionState: peer.connectionState,
        iceConnectionState: peer.iceConnectionState,
        codec: screenShareStatsString(codecStats, "mimeType"),
        candidateType: screenShareStatsString(localCandidate, "candidateType") ?? screenShareStatsString(remoteCandidate, "candidateType"),
        width: screenShareStatsNumber(mediaStats, "frameWidth") ?? screenShareStatsNumber(trackStats, "frameWidth"),
        height: screenShareStatsNumber(mediaStats, "frameHeight") ?? screenShareStatsNumber(trackStats, "frameHeight"),
        frameRate: directFrameRate !== null && directFrameRate > 0 ? directFrameRate : derivedFrameRate,
        bitrateKbps: directBitrateKbps ?? derivedBitrateKbps,
        packetsLost,
        packetsTotal,
        lossPercent,
        intervalLossPercent,
        framesDropped: screenShareStatsNumber(mediaStats, "framesDropped") ?? screenShareStatsNumber(trackStats, "framesDropped"),
        jitterMs: jitter === null ? null : jitter * 1_000,
        roundTripTimeMs: currentRoundTripTime === null ? null : currentRoundTripTime * 1_000,
        availableOutgoingBitrateKbps: screenShareStatsNumber(candidatePairStats, "availableOutgoingBitrate") === null
          ? null
          : (screenShareStatsNumber(candidatePairStats, "availableOutgoingBitrate") as number) / 1_000,
        qualityLimitationReason: screenShareStatsString(mediaStats, "qualityLimitationReason"),
      };
      const encoder = screenShareEncoders.get(peerId);
      if (role === "owner" && encoder) {
        if (peer.connectionState === "connected") encoder.sample({ ...sample, intervalLossPercent, sampledAt: now });
        Object.assign(sample, encoder.snapshot());
      }
      return sample;
    } catch {
      return null;
    }
  }

  async function collectScreenShareWebRtcStats(): Promise<void> {
    if (screenShareStatsCollecting || !screenSharePeers.size) return;
    screenShareStatsCollecting = true;
    const generation = screenShareStatsGeneration;
    try {
      const peers = await Promise.all([...screenSharePeers.entries()].map(async ([peerId, peer]) => {
        const role = screenSharePeerRoles.get(peerId) ?? "viewer";
        return collectScreenSharePeerStats(peerId, peer, role);
      }));
      if (generation !== screenShareStatsGeneration) return;
      screenShareWebRtcStats.capture = screenShareStatsCapture();
      screenShareWebRtcStats.peers = peers.filter((stats): stats is ScreenSharePeerStats => stats !== null);
      screenShareWebRtcStats.updatedAt = Date.now();
    } finally {
      if (generation === screenShareStatsGeneration) screenShareStatsCollecting = false;
    }
  }

  function startScreenShareStatsPolling(): void {
    if (screenShareStatsTimer) return;
    void collectScreenShareWebRtcStats();
    screenShareStatsTimer = setInterval(() => { void collectScreenShareWebRtcStats(); }, 1_000);
  }

  function stopScreenShareStatsPolling(): void {
    screenShareStatsGeneration++;
    screenShareStatsCollecting = false;
    if (screenShareStatsTimer) {
      clearInterval(screenShareStatsTimer);
      screenShareStatsTimer = null;
    }
    screenShareStatsPrevious.clear();
    screenShareWebRtcStats.updatedAt = null;
    screenShareWebRtcStats.capture = null;
    screenShareWebRtcStats.peers = [];
  }

  function clearScreenSharePeerTimer(peerId: string): void {
    const timer = screenSharePeerTimers.get(peerId);
    if (!timer) return;
    clearTimeout(timer);
    screenSharePeerTimers.delete(peerId);
  }

  function armScreenSharePeerTimer(peerId: string): void {
    if (!screenSharePeers.has(peerId)) return;
    clearScreenSharePeerTimer(peerId);
    screenSharePeerTimers.set(peerId, setTimeout(() => {
      screenSharePeerTimers.delete(peerId);
      if (!screenSharePeers.has(peerId)) return;
      failScreenSharePeer(peerId, "屏幕共享直连协商超时，请确认双方网络允许浏览器直连");
    }, SCREEN_SHARE_NEGOTIATION_TIMEOUT_MS));
  }

  function closeScreenSharePeer(peerId: string): void {
    clearScreenSharePeerTimer(peerId);
    const peer = screenSharePeers.get(peerId);
    screenSharePeers.delete(peerId);
    screenSharePeerRoles.delete(peerId);
    screenShareEncoders.get(peerId)?.dispose();
    screenShareEncoders.delete(peerId);
    screenShareStatsPrevious.delete(peerId);
    screenSharePendingIce.delete(peerId);
    screenSharePeerStreams.get(peerId)?.getTracks().forEach(track => track.stop());
    screenSharePeerStreams.delete(peerId);
    if (peer) {
      peer.onicecandidate = null;
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
    }
    try { peer?.close(); } catch { /* closing an already closed peer is harmless */ }
    if (!screenSharePeers.size) stopScreenShareStatsPolling();
  }

  function closeAllScreenSharePeers(): void {
    for (const peerId of [...screenSharePeers.keys()]) closeScreenSharePeer(peerId);
    for (const timer of screenSharePeerTimers.values()) clearTimeout(timer);
    screenSharePeerTimers.clear();
    screenSharePendingIce.clear();
    stopScreenShareStatsPolling();
  }

  function isCurrentPeer(peerId: string, peer: RTCPeerConnection): boolean {
    return transport.isOpen() && screenSharePeers.get(peerId) === peer;
  }

  function setScreenShareP2PError(message = "直连 P2P 失败，当前网络无法建立浏览器之间的直接连接") {
    screenShareErrorCode.value = "";
    screenShareError.value = message;
  }

  const autoRetries = new WeakMap<RTCPeerConnection, number>();
  const autoRetrying = new WeakSet<RTCPeerConnection>();
  function retryAutomaticPeer(peerId: string): boolean {
    const peer = screenSharePeers.get(peerId);
    const role = screenSharePeerRoles.get(peerId);
    const streamId = role === "owner" ? screenShareActiveStreamId.value : screenShareViewingStreamId.value;
    const stream = screenShareStreams.find(item => item.streamId === streamId);
    if (!peer || stream?.route !== "auto") return false;
    if (autoRetrying.has(peer)) return true;
    const lease = role === "owner" ? screenShareOwnerRelay : screenShareViewerRelay;
    const servers = lease?.iceServers.slice(0, MAX_SCREEN_SHARE_ICE_SERVERS) ?? [];
    if (!servers.length) return false;
    const attempts = autoRetries.get(peer) ?? 0;
    // Try all TURN candidates, then each credential/transport group once. Every
    // configured node remains reachable without letting failed ICE retry forever.
    if (attempts >= servers.length + 1) return false;
    autoRetries.set(peer, attempts + 1);
    // The publisher owns retries; the viewer keeps its video and answers.
    if (role !== "owner") { armScreenSharePeerTimer(peerId); return true; }
    autoRetrying.add(peer);
    void (async () => {
      try {
        peer.setConfiguration({ iceServers: attempts === 0 ? servers : [servers[attempts - 1]!], iceTransportPolicy: "relay" });
        const offer = await peer.createOffer({ iceRestart: true });
        if (!isCurrentPeer(peerId, peer)) return;
        await peer.setLocalDescription(offer);
        if (!isCurrentPeer(peerId, peer)) return;
        armScreenSharePeerTimer(peerId);
        sendScreenShareMessage({ type: "screenShareSignal", streamId: stream.streamId, targetPeerId: peerId,
          signal: { kind: "offer", sdp: peer.localDescription?.sdp ?? offer.sdp ?? "" } });
      } catch { if (isCurrentPeer(peerId, peer)) armScreenSharePeerTimer(peerId); }
      finally { autoRetrying.delete(peer); }
    })();
    return true;
  }
  function failScreenSharePeer(peerId: string, message?: string): void {
    if (retryAutomaticPeer(peerId)) return;
    const viewingStream = screenShareStreams.find((stream) => stream.streamId === screenShareViewingStreamId.value && stream.ownerPeerId === peerId);
    const relay = viewingStream?.route ?? screenShareStreams.find(stream => stream.streamId === screenShareActiveStreamId.value)?.route;
    if (viewingStream) sendScreenShareMessage({ type: "screenShareLeave", streamId: viewingStream.streamId });
    closeScreenSharePeer(peerId);
    if (viewingStream) {
      screenShareViewing.value = false;
      screenShareViewingStreamId.value = "";
      screenShareRemoteStream.value = null;
    }
    setScreenShareP2PError(message);
    if (relay && relay !== "p2p") {
      screenShareErrorCode.value = "SCREEN_SHARE_RELAY_FAILED";
      screenShareError.value = "屏幕共享服务器连接失败，请结束共享后选择另一条线路";
    }
  }

  function createScreenSharePeer(streamId: string, peerId: string, role: "owner" | "viewer"): RTCPeerConnection | null {
    const existing = screenSharePeers.get(peerId);
    if (existing) return existing;
    const route = screenShareStreams.find(stream => stream.streamId === streamId)?.route ?? "p2p";
    // Viewers also need a TURN candidate when their own network blocks UDP.
    // Keep ordinary ICE preferred on viewers, allocating relay only as needed.
    const relay = route === "p2p" ? null : role === "owner" ? screenShareOwnerRelay : screenShareViewerRelay;
    if (role === "owner" && route !== "p2p" && (!relay || relay.route !== route || relay.expiresAt <= Date.now())) {
      stopScreenShare();
      screenShareErrorCode.value = "SCREEN_SHARE_RELAY_UNAVAILABLE";
      screenShareError.value = "共享服务器授权已失效，请重新开始共享";
      return null;
    }
    const peer = new RTCPeerConnection(relay
      ? { iceServers: [...(route === "auto" || role === "viewer" ? screenShareIceServers : []), ...relay.iceServers], iceTransportPolicy: route === "auto" || role === "viewer" ? "all" : "relay" }
      : { iceServers: screenShareIceServers });
    screenSharePeers.set(peerId, peer);
    screenSharePeerRoles.set(peerId, role);
    startScreenShareStatsPolling();
    if (role === "owner") {
      for (const track of screenShareLocalStream?.getTracks() ?? []) {
        const sender = peer.addTrack(track, screenShareLocalStream!);
        if (track.kind === "video") {
          const encoder = createScreenShareEncoder(sender, track, () => isCurrentPeer(peerId, peer));
          screenShareEncoders.set(peerId, encoder);
          void encoder.configure(screenShareOutputSettings ?? {});
        }
      }
    } else {
      peer.addTransceiver("video", { direction: "recvonly" });
      const stream = screenShareStreams.find((candidate) => candidate.streamId === streamId);
      if (stream?.audio) peer.addTransceiver("audio", { direction: "recvonly" });
    }
    preferScreenShareCodecs(peer);
    peer.onicecandidate = (event) => {
      if (!isCurrentPeer(peerId, peer) || !event.candidate) return;
      const candidate = event.candidate;
      sendScreenShareMessage({
        type: "screenShareSignal",
        streamId,
        targetPeerId: peerId,
        signal: {
          kind: "iceCandidate",
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
        },
      });
    };
    peer.ontrack = (event) => {
      if (!isCurrentPeer(peerId, peer) || role !== "viewer") return;
      clearScreenSharePeerTimer(peerId);
      const remote = event.streams[0] ?? screenSharePeerStreams.get(peerId) ?? new MediaStream();
      if (!event.streams[0]) remote.addTrack(event.track);
      screenSharePeerStreams.set(peerId, remote);
      screenShareRemoteStream.value = remote;
      screenShareViewing.value = true;
    };
    peer.onconnectionstatechange = () => {
      if (!isCurrentPeer(peerId, peer)) return;
      // `completed` belongs to RTCIceConnectionState, not the aggregate
      // RTCPeerConnection.connectionState. Treating it as a connection state
      // both trips the type checker and can hide the actual failed/closed
      // transitions we need to handle here.
      if (peer.connectionState === "connected") {
        clearScreenSharePeerTimer(peerId);
      } else if (peer.connectionState === "failed") {
        failScreenSharePeer(peerId);
      }
      if (peer.connectionState === "closed" && screenSharePeers.get(peerId) === peer) closeScreenSharePeer(peerId);
    };
    return peer;
  }

  function applyScreenShareContentHint(): void {
    const track = screenShareLocalStream?.getVideoTracks()[0];
    if (!track || !("contentHint" in track)) return;
    const settings = normalizeScreenShareBitrate(screenShareOutputSettings ?? {});
    try { track.contentHint = settings.bitrateMode === "auto" && settings.bitratePolicy === "smooth" ? "motion" : "detail"; }
    catch { /* Content hints are optional; bitrate control remains independent. */ }
  }

  async function updateScreenShareBitrateSettings(settings: ScreenShareBitrateSettings): Promise<boolean> {
    if (!screenShareActive.value) return false;
    const generation = screenShareStartGeneration;
    screenShareOutputSettings = { ...screenShareOutputSettings, ...normalizeScreenShareBitrate(settings) };
    applyScreenShareContentHint();
    const results = await Promise.all([...screenShareEncoders.values()].map(encoder => encoder.configure(screenShareOutputSettings!)));
    return generation === screenShareStartGeneration && screenShareActive.value && results.every(Boolean);
  }

  function preferScreenShareCodecs(peer: RTCPeerConnection): void {
    const transceiver = peer.getTransceivers().find((candidate) => candidate.sender.track?.kind === "video" || candidate.receiver.track?.kind === "video");
    const capabilities = typeof RTCRtpReceiver !== "undefined" ? RTCRtpReceiver.getCapabilities?.("video") : null;
    if (!transceiver?.setCodecPreferences || !capabilities?.codecs?.length) return;
    const vp8 = capabilities.codecs.filter((codec) => codec.mimeType.toLowerCase() === "video/vp8");
    if (!vp8.length) return;
    const remaining = capabilities.codecs.filter((codec) => codec.mimeType.toLowerCase() !== "video/vp8");
    try { transceiver.setCodecPreferences([...vp8, ...remaining]); } catch { /* older browsers may reject codec preference changes */ }
  }

  async function flushScreenShareCandidates(peerId: string, peer: RTCPeerConnection): Promise<void> {
    const pending = screenSharePendingIce.get(peerId) ?? [];
    screenSharePendingIce.delete(peerId);
    for (const candidate of pending) {
      if (!isCurrentPeer(peerId, peer)) return;
      try { await peer.addIceCandidate(candidate); } catch { /* an obsolete candidate can be ignored */ }
    }
  }

  async function startScreenShareViewer(stream: ScreenShareStream): Promise<void> {
    closeAllScreenSharePeers();
    screenShareRemoteStream.value = null;
    screenShareViewing.value = true;
    screenShareViewingStreamId.value = stream.streamId;
    screenShareErrorCode.value = "";
    screenShareError.value = "";
    const peer = createScreenSharePeer(stream.streamId, stream.ownerPeerId, "viewer");
    if (!peer) return;
    if (stream.source === "teamspeak") {
      armScreenSharePeerTimer(stream.ownerPeerId);
      return;
    }
    try {
      const offer = await peer.createOffer();
      if (!isCurrentPeer(stream.ownerPeerId, peer)) return;
      await peer.setLocalDescription(offer);
      if (!isCurrentPeer(stream.ownerPeerId, peer)) return;
      armScreenSharePeerTimer(stream.ownerPeerId);
      sendScreenShareMessage({
        type: "screenShareSignal",
        streamId: stream.streamId,
        targetPeerId: stream.ownerPeerId,
        signal: { kind: "offer", sdp: peer.localDescription?.sdp ?? offer.sdp ?? "" },
      });
    } catch {
      if (isCurrentPeer(stream.ownerPeerId, peer)) failScreenSharePeer(stream.ownerPeerId, "无法创建屏幕共享直连请求，请重试");
    }
  }

  async function startNativeScreenShareViewer(streamId: string, peerId: string): Promise<void> {
    const stream = screenShareStreams.find((candidate) => candidate.streamId === streamId);
    if (!stream || stream.source !== "browser" || screenShareActiveStreamId.value !== streamId || stream.ownerPeerId !== screenShareLocalPeerId()) return;
    closeScreenSharePeer(peerId);
    const peer = createScreenSharePeer(streamId, peerId, "owner");
    if (!peer) return;
    try {
      const offer = await peer.createOffer();
      if (!isCurrentPeer(peerId, peer)) return;
      await peer.setLocalDescription(offer);
      if (!isCurrentPeer(peerId, peer)) return;
      void screenShareEncoders.get(peerId)?.retry();
      armScreenSharePeerTimer(peerId);
      sendScreenShareMessage({
        type: "screenShareSignal",
        streamId,
        targetPeerId: peerId,
        signal: { kind: "offer", sdp: peer.localDescription?.sdp ?? offer.sdp ?? "" },
      });
    } catch {
      if (isCurrentPeer(peerId, peer)) failScreenSharePeer(peerId, "无法为 TeamSpeak 观看端创建屏幕共享直连");
    }
  }

  async function handleScreenShareSignal(streamId: string, fromPeerId: string, signal: ScreenShareSignal): Promise<void> {
    const stream = screenShareStreams.find((candidate) => candidate.streamId === streamId);
    if (!stream) return;
    if (signal.kind === "close") {
      closeScreenSharePeer(fromPeerId);
      if (screenShareViewingStreamId.value === streamId) {
        screenShareViewing.value = false;
        screenShareViewingStreamId.value = "";
        screenShareRemoteStream.value = null;
      }
      return;
    }
    if (signal.kind === "iceCandidate") {
      if (!signal.candidate) return;
      const peer = screenSharePeers.get(fromPeerId);
      const candidate: RTCIceCandidateInit = {
        candidate: signal.candidate,
        ...(signal.sdpMid !== undefined ? { sdpMid: signal.sdpMid } : {}),
        ...(signal.sdpMLineIndex !== undefined ? { sdpMLineIndex: signal.sdpMLineIndex } : {}),
      };
      if (!peer?.remoteDescription) {
        screenSharePendingIce.set(fromPeerId, [...(screenSharePendingIce.get(fromPeerId) ?? []), candidate]);
        return;
      }
      try { await peer.addIceCandidate(candidate); } catch { /* stale ICE is not fatal */ }
      return;
    }

    if (screenShareViewingStreamId.value === streamId && fromPeerId === stream.ownerPeerId && signal.kind === "offer") {
      const peer = screenSharePeers.get(fromPeerId) ?? createScreenSharePeer(streamId, fromPeerId, "viewer");
      if (!peer) return;
      if (!signal.sdp) return;
      armScreenSharePeerTimer(fromPeerId);
      try {
        await peer.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        if (!isCurrentPeer(fromPeerId, peer)) return;
        await flushScreenShareCandidates(fromPeerId, peer);
        if (!isCurrentPeer(fromPeerId, peer)) return;
        const answer = await peer.createAnswer();
        if (!isCurrentPeer(fromPeerId, peer)) return;
        await peer.setLocalDescription(answer);
        if (!isCurrentPeer(fromPeerId, peer)) return;
        void screenShareEncoders.get(fromPeerId)?.retry();
        sendScreenShareMessage({ type: "screenShareSignal", streamId, targetPeerId: fromPeerId, signal: { kind: "answer", sdp: answer.sdp ?? "" } });
      } catch {
        if (isCurrentPeer(fromPeerId, peer)) failScreenSharePeer(fromPeerId, "无法回复 TeamSpeak 屏幕共享的直连请求");
      }
      return;
    }

    if (stream.source === "browser" && screenShareActiveStreamId.value === streamId && stream.ownerPeerId === screenShareLocalPeerId() && signal.kind === "answer") {
      const peer = screenSharePeers.get(fromPeerId);
      if (!peer || !signal.sdp) return;
      try {
        await peer.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        if (!isCurrentPeer(fromPeerId, peer)) return;
        await flushScreenShareCandidates(fromPeerId, peer);
        if (!isCurrentPeer(fromPeerId, peer)) return;
      } catch {
        if (isCurrentPeer(fromPeerId, peer)) failScreenSharePeer(fromPeerId, "TeamSpeak 观看端无法完成屏幕共享直连协商");
      }
      return;
    }

    if (stream.source === "browser" && stream.ownerPeerId === fromPeerId && signal.kind === "answer") {
      const peer = screenSharePeers.get(fromPeerId);
      if (!peer || !signal.sdp) return;
      try {
        await peer.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        if (!isCurrentPeer(fromPeerId, peer)) return;
        await flushScreenShareCandidates(fromPeerId, peer);
        if (!isCurrentPeer(fromPeerId, peer)) return;
      } catch {
        if (isCurrentPeer(fromPeerId, peer)) failScreenSharePeer(fromPeerId, "观看端无法完成屏幕共享直连协商");
      }
      return;
    }

    if (screenShareActiveStreamId.value === streamId && stream.ownerPeerId === screenShareLocalPeerId()) {
      const peer = screenSharePeers.get(fromPeerId) ?? createScreenSharePeer(streamId, fromPeerId, "owner");
      if (!peer) return;
      if (signal.kind !== "offer" || !signal.sdp) return;
      armScreenSharePeerTimer(fromPeerId);
      try {
        await peer.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        if (!isCurrentPeer(fromPeerId, peer)) return;
        await flushScreenShareCandidates(fromPeerId, peer);
        if (!isCurrentPeer(fromPeerId, peer)) return;
        const answer = await peer.createAnswer();
        if (!isCurrentPeer(fromPeerId, peer)) return;
        await peer.setLocalDescription(answer);
        if (!isCurrentPeer(fromPeerId, peer)) return;
        void screenShareEncoders.get(fromPeerId)?.retry();
        sendScreenShareMessage({ type: "screenShareSignal", streamId, targetPeerId: fromPeerId, signal: { kind: "answer", sdp: answer.sdp ?? "" } });
      } catch {
        if (isCurrentPeer(fromPeerId, peer)) failScreenSharePeer(fromPeerId, "共享端无法完成观看者的直连协商");
      }
    }
  }

  // The owner peer id is generated by the gateway and is returned in the
  // screenShareStarted event; the active stream's owner id is therefore the
  // only stable local-owner marker available to the browser.
  function screenShareLocalPeerId(): string {
    const active = screenShareStreams.find((stream) => stream.streamId === screenShareActiveStreamId.value);
    return active?.ownerPeerId ?? "";
  }

  async function startScreenShare(audio = true, settings?: ScreenShareOutputSettings): Promise<void> {
    if (!transport.isOpen() || screenShareActive.value || screenShareStarting.value) return;
    if (settings?.route && settings.route !== "p2p" && settings.route !== "auto" && !screenShareRelays.value.includes(settings.route)) {
      screenShareErrorCode.value = "SCREEN_SHARE_RELAY_UNAVAILABLE";
      screenShareError.value = "所选屏幕共享服务器未配置，请选择其他线路";
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      screenShareError.value = "当前浏览器不支持屏幕共享";
      return;
    }
    screenShareErrorCode.value = "";
    screenShareError.value = "";
    const startGeneration = ++screenShareStartGeneration;
    screenShareStarting.value = true;
    screenShareStartCancelled = false;
    screenShareOutputSettings = { ...settings, ...normalizeScreenShareBitrate(settings) };
    let acquiredStream: MediaStream | null = null;
    try {
      const stream = acquiredStream = await navigator.mediaDevices.getDisplayMedia({
        // Capture the selected surface at its native browser-provided size.
        // Output resolution/FPS are applied later on each RTCRtpSender so the
        // user's desktop or application window is never resized or sampled at
        // the output limit.
        video: true,
        audio,
        // These are preferences: when the selected surface is a window, ask
        // for that window's audio; when it is a monitor, allow system audio.
        // The browser/OS may still return no audio or ignore the preference.
        systemAudio: "include",
        windowAudio: "window",
        selfBrowserSurface: "exclude",
      } as unknown as DisplayMediaStreamOptions);
      if (startGeneration !== screenShareStartGeneration || !screenShareStarting.value || screenShareStartCancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) throw new Error("NO_VIDEO_TRACK");
      screenShareLocalStream = stream;
      applyScreenShareContentHint();
      screenShareRequestSequence = (screenShareRequestSequence + 1) % 1_000_000;
      screenSharePendingStartId = `screen-start-${screenShareRequestSequence}`;
      for (const track of stream.getTracks()) track.addEventListener("ended", () => {
        if (screenShareLocalStream === stream) stopScreenShare();
      }, { once: true });
      sendScreenShareMessage({ type: "screenShareStart", requestId: screenSharePendingStartId, audio: stream.getAudioTracks().length > 0, name: "我的屏幕", ...(settings?.route ? { route: settings.route } : {}) });
    } catch (error: unknown) {
      acquiredStream?.getTracks().forEach(track => track.stop());
      if (startGeneration !== screenShareStartGeneration) return;
      screenShareLocalStream = null;
      screenShareOutputSettings = null;
      screenShareStarting.value = false;
      screenSharePendingStartId = "";
      screenShareStartCancelled = false;
      if (error instanceof DOMException && error.name === "NotAllowedError") screenShareError.value = "你取消了屏幕共享或浏览器未授予权限";
      else screenShareError.value = "无法开始屏幕共享，请检查浏览器权限";
    }
  }

  function stopScreenShare(): void {
    screenShareOwnerRelay = null;
    screenShareStartGeneration += 1;
    if (screenShareStarting.value) screenShareStartCancelled = true;
    if (screenShareActive.value && screenShareActiveStreamId.value) sendScreenShareMessage({ type: "screenShareStop", streamId: screenShareActiveStreamId.value });
    closeAllScreenSharePeers();
    screenShareLocalStream?.getTracks().forEach((track) => track.stop());
    screenShareLocalStream = null;
    screenShareOutputSettings = null;
    screenShareStarting.value = false;
    screenSharePendingStartId = "";
    screenShareStartCancelled = false;
    screenShareActive.value = false;
    screenShareActiveStreamId.value = "";
  }

  function joinScreenShare(streamId: string): void {
    screenShareErrorCode.value = "";
    screenShareError.value = "";
    if (screenShareViewingStreamId.value && screenShareViewingStreamId.value !== streamId) leaveScreenShare();
    screenShareRequestSequence = (screenShareRequestSequence + 1) % 1_000_000;
    sendScreenShareMessage({ type: "screenShareJoin", streamId, requestId: `screen-join-${screenShareRequestSequence}` });
  }

  function leaveScreenShare(): void {
    screenShareViewerRelay = null;
    if (screenShareViewingStreamId.value) sendScreenShareMessage({ type: "screenShareLeave", streamId: screenShareViewingStreamId.value });
    closeAllScreenSharePeers();
    screenShareViewing.value = false;
    screenShareViewingStreamId.value = "";
    screenShareRemoteStream.value = null;
  }

  function stopScreenShareTransport(sendStop: boolean): void {
    screenShareViewerRelay = null;
    screenShareOwnerRelay = null;
    screenShareStartGeneration += 1;
    if (sendStop && screenShareActive.value && screenShareActiveStreamId.value) sendScreenShareMessage({ type: "screenShareStop", streamId: screenShareActiveStreamId.value });
    if (screenShareStarting.value) screenShareStartCancelled = true;
    closeAllScreenSharePeers();
    screenShareLocalStream?.getTracks().forEach((track) => track.stop());
    screenShareLocalStream = null;
    screenShareOutputSettings = null;
    screenShareStarting.value = false;
    screenSharePendingStartId = "";
    screenShareStartCancelled = false;
    screenShareActive.value = false;
    screenShareActiveStreamId.value = "";
    screenShareViewing.value = false;
    screenShareViewingStreamId.value = "";
    screenShareRemoteStream.value = null;
    screenShareStreams.length = 0;
  }

  function upsertScreenShareStream(raw: unknown): ScreenShareStream | null {
    const stream = parseScreenShareStream(raw);
    if (!stream) return null;
    const index = screenShareStreams.findIndex((candidate) => candidate.streamId === stream.streamId);
    if (index >= 0) screenShareStreams.splice(index, 1, stream);
    else screenShareStreams.push(stream);
    return stream;
  }

  function handleMessage(msg: ServerMessage): boolean {
    switch (msg.type) {
      case "screenShareList":
        screenShareStreams.length = 0;
        if (Array.isArray(msg.streams)) for (const raw of msg.streams) upsertScreenShareStream(raw);
        break;
      case "screenShareStarted": {
        const stream = upsertScreenShareStream(msg.stream);
        if (!stream) break;
        if (msg.owner === true) {
          const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
          const isCurrentStart = Boolean(screenSharePendingStartId) && requestId === screenSharePendingStartId && !screenShareStartCancelled;
          if (!isCurrentStart) {
            sendScreenShareMessage({ type: "screenShareStop", streamId: stream.streamId });
            const staleIndex = screenShareStreams.findIndex((candidate) => candidate.streamId === stream.streamId);
            if (staleIndex >= 0) screenShareStreams.splice(staleIndex, 1);
            break;
          }
          const route = screenShareOutputSettings?.route ?? "p2p";
          const relay = parseScreenShareRelayCredentials(msg.relay);
          if ((stream.route ?? "p2p") !== route || (route !== "p2p" && (!relay || relay.route !== route || relay.expiresAt <= Date.now()))) {
            sendScreenShareMessage({ type: "screenShareStop", streamId: stream.streamId });
            stopScreenShare();
            screenShareErrorCode.value = "SCREEN_SHARE_RELAY_UNAVAILABLE";
            screenShareError.value = "共享服务器授权无效，请重新选择线路";
            break;
          }
          screenShareOwnerRelay = route !== "p2p" ? relay : null;
          screenSharePendingStartId = "";
          screenShareStarting.value = false;
          screenShareActive.value = true;
          screenShareActiveStreamId.value = stream.streamId;
        }
        break;
      }
      case "screenShareViewerCount": {
        const stream = screenShareStreams.find((candidate) => candidate.streamId === String(msg.streamId || ""));
        if (stream) {
          if (typeof msg.viewerCount === "number") stream.viewerCount = Math.max(0, Math.floor(msg.viewerCount));
          if (Array.isArray(msg.viewers)) stream.viewers = parseScreenShareViewers(msg.viewers);
        }
        break;
      }
      case "screenShareStopped": {
        const streamId = String(msg.streamId || "");
        const index = screenShareStreams.findIndex((candidate) => candidate.streamId === streamId);
        if (index >= 0) screenShareStreams.splice(index, 1);
        if (screenShareActiveStreamId.value === streamId) {
          screenShareOwnerRelay = null;
          closeAllScreenSharePeers();
          screenShareStarting.value = false;
          screenSharePendingStartId = "";
          screenShareStartCancelled = false;
          screenShareActive.value = false;
          screenShareActiveStreamId.value = "";
          screenShareLocalStream?.getTracks().forEach((track) => track.stop());
          screenShareLocalStream = null;
          screenShareOutputSettings = null;
        }
        if (screenShareViewingStreamId.value === streamId) {
          closeAllScreenSharePeers();
          screenShareViewing.value = false;
          screenShareViewingStreamId.value = "";
          screenShareRemoteStream.value = null;
        }
        break;
      }
      case "screenShareJoined": {
        const stream = upsertScreenShareStream(msg.stream);
        if (!stream) break;
        const lease = parseScreenShareRelayCredentials(msg.relay);
        screenShareViewerRelay = lease && lease.route === stream.route && lease.expiresAt > Date.now() ? lease : null;
        void startScreenShareViewer(stream);
        break;
      }
      case "screenShareNativeViewerJoined":
        if (typeof msg.streamId === "string" && typeof msg.viewerPeerId === "string") {
          void startNativeScreenShareViewer(msg.streamId, msg.viewerPeerId);
        }
        break;
      case "screenShareSignal":
        if (typeof msg.streamId === "string" && typeof msg.fromPeerId === "string" && msg.signal) {
          void handleScreenShareSignal(msg.streamId, msg.fromPeerId, msg.signal as ScreenShareSignal);
        }
        break;
      case "screenShareViewerLeft":
        if (msg.streamId === screenShareActiveStreamId.value && typeof msg.viewerPeerId === "string") closeScreenSharePeer(msg.viewerPeerId);
        break;
      case "screenShareLeft":
        if (screenShareViewingStreamId.value === String(msg.streamId || "")) leaveScreenShare();
        break;
      case "screenShareError":
        screenShareErrorCode.value = typeof msg.code === "string" ? msg.code : "";
        screenShareError.value = String(msg.message || "屏幕共享操作失败");
        if (screenShareStarting.value) {
          screenShareStarting.value = false;
          screenSharePendingStartId = "";
          screenShareStartCancelled = false;
          screenShareLocalStream?.getTracks().forEach((track) => track.stop());
          screenShareLocalStream = null;
          screenShareOutputSettings = null;
        }
        if (screenShareViewing.value) {
          if (screenShareViewingStreamId.value) sendScreenShareMessage({ type: "screenShareLeave", streamId: screenShareViewingStreamId.value });
          closeAllScreenSharePeers();
          screenShareViewing.value = false;
          screenShareViewingStreamId.value = "";
          screenShareRemoteStream.value = null;
        }
        break;
      default: return false;
    }
    return true;
  }

  return {
    api: {
      screenShareRelays,
      screenShareStreams,
      screenShareActive,
      screenShareStarting,
      screenShareActiveStreamId,
      screenShareViewing,
      screenShareViewingStreamId,
      screenShareRemoteStream,
      screenShareError,
      screenShareErrorCode,
      screenShareRemoteVolume,
      screenShareWebRtcStats,
      startScreenShare,
      updateScreenShareBitrateSettings,
      stopScreenShare,
      joinScreenShare,
      leaveScreenShare,
    },
    handleMessage,
    setIceServers(servers?: ScreenShareIceServer[]): void {
      screenShareIceServers = normalizeScreenShareIceServers(servers);
    },
    setRelays(routes?: ScreenShareRelayId[]): void {
      screenShareRelays.value = [...new Set((routes ?? []).filter(isScreenShareRelayId))];
    },
    refreshStreams(): void { sendScreenShareMessage({ type: "screenShareList" }); },
    stopTransport: stopScreenShareTransport,
  };
}
