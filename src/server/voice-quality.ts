import { OpusEncoder } from "./opus-codec.js";
import { adaptVoiceQuality, DEFAULT_VOICE_QUALITY, initialVoiceAdaptation, type VoiceNetworkFeedback, type VoiceQualitySettings, type VoiceQualityStatus } from "../shared/voice-quality.js";

interface Codec { encode(pcm: Buffer): Buffer; decode(packet: Buffer): Buffer; setBitrate(bitrate: number): void; dispose(): void }
type DecoderRecord = { codec: 4 | 5; decoder: Codec; encoder: Codec; lastAt: number; bitrate: number };
/** Receiver-owned transcoding never changes another listener's stream or the
 * original TeamSpeak stereo encoder. Allocate only for active, over-budget audio. */
export class SessionVoiceQuality {
  private settings = { ...DEFAULT_VOICE_QUALITY };
  private state = initialVoiceAdaptation(this.settings);
  private streams = new Map<number, DecoderRecord>();
  private enabled = false;
  private compressed = false;
  private closed = false;
  constructor(private readonly create: (channels: 1 | 2, bitrate: number) => Codec = (channels, bitrate) => new OpusEncoder(48000, channels, { bitrate, forceChannels: channels, vbr: false })) {}
  configure(settings: VoiceQualitySettings, compressed: boolean): VoiceQualityStatus {
    if (this.closed || process.env.WEBSPEAK_MOBILE === "1") throw new Error("Audio quality unavailable");
    this.settings = { ...settings }; this.state = initialVoiceAdaptation(settings);
    this.enabled = true; this.compressed = compressed;
    return this.snapshot();
  }
  feedback(sample: VoiceNetworkFeedback, now: number, bufferedBytes: number): VoiceQualityStatus {
    if (this.enabled && !this.closed) {
      this.sweep(now);
      const bufferedMs = bufferedBytes * 8 / Math.max(16, this.state.downlink * Math.max(1, this.streams.size));
      this.state = adaptVoiceQuality(this.state, this.settings, sample, now, bufferedMs);
    }
    return { ...this.snapshot(), sequence: sample.sequence };
  }
  snapshot(): VoiceQualityStatus {
    return { ...this.settings, uplinkKbps: this.state.uplink, downlinkKbps: this.state.downlink, reason: this.state.reason, compressedUplink: this.enabled && this.compressed && !this.closed };
  }
  encodeForListener(clientId: number, packet: Buffer, codec: number, now: number): Buffer {
    if (!this.enabled || this.closed || (codec !== 4 && codec !== 5)) return packet;
    const target = this.state.downlink * 1000;
    let stream = this.streams.get(clientId);
    if (stream && stream.codec !== codec) { this.release(clientId); stream = undefined; }
    if (!stream && packet.length * 400 <= target) return packet;
    if (!stream) {
      this.sweep(now);
      if (this.streams.size >= 64) throw new Error("Receiver codec limit");
      const channels = codec === 5 ? 2 : 1;
      const decoder = this.create(channels, target);
      let encoder: Codec;
      try { encoder = this.create(channels, target); }
      catch (error) { decoder.dispose(); throw error; }
      stream = { codec, decoder, encoder, lastAt: now, bitrate: target };
      this.streams.set(clientId, stream);
    }
    stream.lastAt = now;
    const pcm = stream.decoder.decode(packet);
    if (pcm.length !== (codec === 5 ? 3840 : 1920)) throw new Error("Unexpected voice frame duration");
    if (stream.bitrate !== target) { stream.encoder.setBitrate(target); stream.bitrate = target; }
    // Once active, keep one continuous encoder history until the speaker retires.
    return stream.encoder.encode(pcm);
  }
  private sweep(now: number): void {
    for (const [id, stream] of this.streams) if (now - stream.lastAt > 5000) this.release(id);
  }
  private release(id: number): void {
    const stream = this.streams.get(id); this.streams.delete(id);
    try { stream?.decoder.dispose(); } finally { stream?.encoder.dispose(); }
  }
  close(): void {
    this.closed = true;
    for (const id of this.streams.keys()) try { this.release(id); } catch { /* Release each speaker independently. */ }
  }
}
