import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type NativeCodec = {
  encode(pcm: Buffer): Buffer;
  decode(data: Buffer): Buffer;
  setBitrate(bitrate: number): void;
  applyEncoderCTL(control: number, value: number): void;
};

type ScriptCodec = {
  encode(pcm: Buffer, frameSize: number): Buffer | Uint8Array;
  decode(data: Buffer): Buffer | Uint8Array;
  setBitrate(bitrate: number): void;
  encoderCTL(control: number, value: number): void;
  delete(): void;
};

type OpusScriptModule = {
  new (sampleRate: number, channels: number, application: number): ScriptCodec;
  Application: { AUDIO: number };
};

interface OpusEncoderOptions {
  bitrate?: number;
  forceChannels?: 1 | 2;
  vbr?: boolean;
}

const OPUS_SET_FORCE_CHANNELS_REQUEST = 4022;
const OPUS_SET_VBR_REQUEST = 4006;

/** Keep the existing native codec on servers; the Android bundle uses the WASM codec. */
export class OpusEncoder {
  private codec: NativeCodec | ScriptCodec | null;
  private readonly channels: number;
  private readonly mobile: boolean;

  constructor(sampleRate: number, channels: number, options: OpusEncoderOptions = {}) {
    this.channels = channels;
    this.mobile = process.env.WEBSPEAK_MOBILE === "1";
    if (this.mobile) {
      const OpusScript = require("opusscript") as OpusScriptModule;
      this.codec = new OpusScript(sampleRate, channels, OpusScript.Application.AUDIO);
    } else {
      const { OpusEncoder: NativeOpusEncoder } = require("@discordjs/opus") as {
        OpusEncoder: new (rate: number, channelCount: number) => NativeCodec;
      };
      this.codec = new NativeOpusEncoder(sampleRate, channels);
    }
    try {
      if (options.bitrate !== undefined) this.codec.setBitrate(options.bitrate);
      if (options.forceChannels !== undefined) {
        // Prevent the encoder from collapsing a stereo source to mono.
        if (this.mobile) (this.codec as ScriptCodec).encoderCTL(OPUS_SET_FORCE_CHANNELS_REQUEST, options.forceChannels);
        else (this.codec as NativeCodec).applyEncoderCTL(OPUS_SET_FORCE_CHANNELS_REQUEST, options.forceChannels);
      }
      if (options.vbr !== undefined) {
        const enabled = options.vbr ? 1 : 0;
        if (this.mobile) (this.codec as ScriptCodec).encoderCTL(OPUS_SET_VBR_REQUEST, enabled);
        else (this.codec as NativeCodec).applyEncoderCTL(OPUS_SET_VBR_REQUEST, enabled);
      }
    } catch (error) {
      try { this.dispose(); } catch { /* preserve the configuration failure */ }
      throw error;
    }
  }

  encode(pcm: Buffer): Buffer {
    const codec = this.codec;
    if (!codec) throw new Error("Opus codec is disposed");
    const encoded = this.mobile
      ? (codec as ScriptCodec).encode(pcm, pcm.length / (2 * this.channels))
      : (codec as NativeCodec).encode(pcm);
    return Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);
  }

  decode(data: Buffer): Buffer {
    if (!this.codec) throw new Error("Opus codec is disposed");
    const decoded = this.codec.decode(data);
    return Buffer.isBuffer(decoded) ? decoded : Buffer.from(decoded);
  }

  dispose(): void {
    const codec = this.codec;
    this.codec = null;
    // Native codec storage is released by its GC finalizer once this reference is gone.
    if (codec && this.mobile) (codec as ScriptCodec).delete();
  }
}
