import { WebSocket } from "ws";
import type { ServerMessage } from "../shared/server-messages.js";
import type { AudioFlowStats } from "./audio-stats.js";
import type { TSClient, TSVoiceData } from "./ts-client.js";
import type { WebRtcAudioSession } from "./webrtc-audio.js";

// Fixed 20 ms frames at 48 kHz: mono Int16 or interleaved L/R Int16.
const MONO_FRAME_BYTES = 1_920;
const STEREO_FRAME_BYTES = 3_840;
// Keep the established byte guard; the browser also bounds playback by time.
const MAX_BUFFERED_BYTES = 4_096;

export interface VoiceEncoder {
  encode(frame: Buffer): Buffer;
  dispose(): void;
}

export interface SessionAudioOptions {
  audio: AudioFlowStats;
  socket: Pick<WebSocket, "readyState" | "bufferedAmount"> & { send(packet: Buffer): void };
  client: Pick<TSClient, "sendVoice" | "sendWhisper">;
  isCurrent(): boolean;
  isReady(): boolean;
  selfId(): number;
  peer(): Pick<WebRtcAudioSession, "pushTeamSpeakVoice"> | null;
  whisperTargets(): readonly number[] | null;
  sendJson(message: ServerMessage): void;
  directVoice?(clientId: number): "normal" | "fallback" | "suppress";
  createStereoEncoder?(): VoiceEncoder;
}

/** A session owns its encoders and one active audio route in each direction. */
export class SessionAudioTransport {
  private encoder: VoiceEncoder | null;
  private stereoEncoder: VoiceEncoder | null = null;
  private closed = false;
  private warnedAt: number | null = null;

  constructor(private readonly options: SessionAudioOptions, encoder: VoiceEncoder, private readonly clock: () => number = Date.now) {
    this.encoder = encoder;
  }

  private isCurrent(): boolean {
    return !this.closed && this.options.isCurrent() && this.options.socket.readyState === WebSocket.OPEN;
  }

  private recordIngress(): void {
    const stats = this.options.audio;
    const now = this.clock();
    if (stats.ingressLastAt !== null) stats.ingressMaxGapMs = Math.max(stats.ingressMaxGapMs, now - stats.ingressLastAt);
    stats.ingressFirstAt ??= now;
    stats.ingressLastAt = now;
    stats.ingressFrames++;
  }

  private sendVoice(data: Buffer, codec: number): void {
    const stats = this.options.audio;
    try {
      const targets = this.options.whisperTargets();
      if (targets?.length) this.options.client.sendWhisper(data, [...targets], codec);
      else this.options.client.sendVoice(data, codec);
      const now = this.clock();
      if (stats.tsSendLastAt !== null) stats.tsSendMaxGapMs = Math.max(stats.tsSendMaxGapMs, now - stats.tsSendLastAt);
      stats.tsSendFirstAt ??= now;
      stats.tsSendLastAt = now;
      stats.tsSendFrames++;
    } catch {
      stats.tsSendErrors++;
    }
  }

  private reportEncoderFailure(): void {
    const now = this.clock();
    if (this.warnedAt !== null && now - this.warnedAt < 5_000) return;
    this.warnedAt = now;
    try {
      this.options.sendJson({ type: "audioError", code: "AUDIO_ENCODER_UNAVAILABLE", detail: "Opus encoder unavailable" });
    } catch { /* the socket may have closed while reporting the failure */ }
  }

  receivePcm(frame: Buffer): void {
    if (!this.isCurrent()) return;
    const stats = this.options.audio;
    const stereo = frame.length === STEREO_FRAME_BYTES;
    if (frame.length !== MONO_FRAME_BYTES && !stereo) {
      stats.ingressDroppedFrames++;
      this.options.sendJson({ type: "error", error: { code: "INVALID_AUDIO_FRAME", message: "音频帧格式无效", recoverable: false } });
      return;
    }
    // Late TCP frames from before a WebRTC switch must not duplicate RTP audio.
    if (!this.options.isReady() || this.options.peer()) { stats.ingressDroppedFrames++; return; }
    this.recordIngress();
    const startedAt = this.clock();
    let encoded: Buffer;
    try {
      // Ordinary voice sessions never allocate the additional stereo codec.
      if (stereo && !this.stereoEncoder) this.stereoEncoder = this.options.createStereoEncoder?.() ?? null;
      const encoder = stereo ? this.stereoEncoder : this.encoder;
      if (!encoder) throw new Error("Encoder unavailable");
      encoded = encoder.encode(frame);
      stats.tsEncodeMaxMs = Math.max(stats.tsEncodeMaxMs, this.clock() - startedAt);
    } catch {
      stats.tsSendErrors++;
      stats.ingressDroppedFrames++;
      this.reportEncoderFailure();
      return;
    }
    this.sendVoice(encoded, stereo ? 5 : 4);
  }

  receiveWebRtc(data: Buffer, codec: number): void {
    if (!this.isCurrent() || !this.options.isReady()) return;
    this.recordIngress();
    this.sendVoice(data, codec);
  }

  receiveTeamSpeak(data: TSVoiceData): void {
    if (!this.isCurrent() || !this.options.isReady()) return;
    const stats = this.options.audio;
    const now = this.clock();
    if (stats.tsReceiveLastAt !== null) stats.tsReceiveMaxGapMs = Math.max(stats.tsReceiveMaxGapMs, now - stats.tsReceiveLastAt);
    stats.tsReceiveFirstAt ??= now;
    stats.tsReceiveLastAt = now;
    stats.tsReceiveFrames++;
    if (data.clientId === this.options.selfId()) return;
    if (!Number.isInteger(data.clientId) || data.clientId < 1 || data.clientId > 65_535
      || !Number.isInteger(data.codec) || data.codec < 0 || data.codec > 255 || !Buffer.isBuffer(data.data)) {
      stats.egressDroppedFrames++;
      return;
    }
    if (stats.egressLastAt !== null) stats.egressMaxGapMs = Math.max(stats.egressMaxGapMs, now - stats.egressLastAt);
    stats.egressFirstAt ??= now;
    stats.egressLastAt = now;
    const key = String(data.clientId);
    stats.egressFramesByClient[key] = (stats.egressFramesByClient[key] ?? 0) + 1;
    const peer = this.options.peer();
    if (peer) {
      try { peer.pushTeamSpeakVoice(data); stats.egressFrames++; }
      catch { stats.egressDroppedFrames++; }
      return;
    }
    const directRoute = this.options.directVoice?.(data.clientId) ?? "normal";
    if (directRoute === "suppress") return;
    const bufferedBytes = this.options.socket.bufferedAmount;
    stats.egressPeakBufferedBytes = Math.max(stats.egressPeakBufferedBytes, bufferedBytes);
    if (bufferedBytes > MAX_BUFFERED_BYTES) { stats.egressDroppedFrames++; return; }
    const packet = Buffer.allocUnsafe(3 + data.data.length);
    packet[0] = data.codec | (directRoute === "fallback" ? 0x80 : 0);
    packet.writeUInt16BE(data.clientId, 1);
    data.data.copy(packet, 3);
    try {
      this.options.socket.send(packet);
      stats.egressFrames++;
      const sentAt = this.clock();
      if (stats.egressSentLastAt !== null) stats.egressSentMaxGapMs = Math.max(stats.egressSentMaxGapMs, sentAt - stats.egressSentLastAt);
      stats.egressSentFirstAt ??= sentAt;
      stats.egressSentLastAt = sentAt;
    } catch { stats.egressDroppedFrames++; }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const encoder = this.encoder;
    const stereoEncoder = this.stereoEncoder;
    this.encoder = null;
    this.stereoEncoder = null;
    try { encoder?.dispose(); } catch { /* other session resources must still be released */ }
    try { stereoEncoder?.dispose(); } catch { /* other session resources must still be released */ }
  }
}
