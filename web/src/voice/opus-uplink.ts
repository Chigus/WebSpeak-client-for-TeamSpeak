import { VOICE_OPUS_HEADER, validVoiceOpusPacket } from "../../../src/shared/voice-quality.js";

/** One mono WebCodecs encoder owned by the current WSS session. Stereo raw
 * bypasses this path so its fixed 192 kbps TS Music contract remains intact. */
export function createOpusUplink(options: {
  send(packet: Uint8Array): void;
  canSend(): boolean;
  onFailure(): void;
}) {
  let encoder: AudioEncoder | null = null;
  let generation = 0, bitrate = 48_000, timestamp = 0, supported = false;
  const config = (rate: number): AudioEncoderConfig => ({ codec: "opus", sampleRate: 48000, numberOfChannels: 1,
    bitrate: rate, bitrateMode: "constant", opus: { frameDuration: 20_000 } });
  function retire(): void {
    generation++;
    const previous = encoder; encoder = null;
    try { previous?.close(); } catch { /* Optional encoder cleanup. */ }
  }
  function open(): void {
    retire();
    const current = generation;
    const fail = () => {
      if (current !== generation) return;
      supported = false; retire(); options.onFailure();
    };
    encoder = new AudioEncoder({
      output(chunk) {
        if (current !== generation || !options.canSend()) return;
        const packet = new Uint8Array(5 + chunk.byteLength);
        packet.set(VOICE_OPUS_HEADER); chunk.copyTo(packet.subarray(5));
        if (!validVoiceOpusPacket(packet)) { fail(); return; }
        options.send(packet);
      },
      error: fail,
    });
    try { encoder.configure(config(bitrate)); }
    catch { fail(); }
  }
  return {
    async prepare(kbps: number): Promise<boolean> {
      retire(); supported = false; bitrate = kbps * 1000;
      const current = generation;
      if (typeof AudioEncoder === "undefined" || typeof AudioData === "undefined") return false;
      try {
        const result = await AudioEncoder.isConfigSupported(config(bitrate));
        if (current !== generation || !result.supported) return false;
        supported = true; open(); return supported;
      } catch { return false; }
    },
    setBitrate(kbps: number): void {
      if (bitrate === kbps * 1000) return;
      bitrate = kbps * 1000;
      if (supported) open();
    },
    push(frame: Int16Array): boolean {
      if (!supported) return false;
      if (!encoder) open();
      if (!encoder || !supported) return false;
      if (encoder.encodeQueueSize >= 6 || !options.canSend()) return true;
      const data = new AudioData({ format: "s16", sampleRate: 48000, numberOfChannels: 1,
        numberOfFrames: 960, timestamp, data: frame });
      timestamp += 20_000;
      try { encoder.encode(data); }
      catch { supported = false; retire(); options.onFailure(); return false; }
      finally { data.close(); }
      return true;
    },
    invalidate(): void { if (encoder) retire(); },
    close(): void { supported = false; timestamp = 0; retire(); },
  };
}
