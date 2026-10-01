import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type NativeCodec = {
  encode(pcm: Buffer): Buffer;
  decode(data: Buffer): Buffer;
};

type ScriptCodec = {
  encode(pcm: Buffer, frameSize: number): Buffer | Uint8Array;
  decode(data: Buffer): Buffer | Uint8Array;
  delete(): void;
};

type OpusScriptModule = {
  new (sampleRate: number, channels: number, application: number): ScriptCodec;
  Application: { AUDIO: number };
};

/** Keep the existing native codec on servers; the Android bundle uses the WASM codec. */
export class OpusEncoder {
  private readonly codec: NativeCodec | ScriptCodec;
  private readonly channels: number;
  private readonly mobile: boolean;

  constructor(sampleRate: number, channels: number) {
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
  }

  encode(pcm: Buffer): Buffer {
    const encoded = this.mobile
      ? (this.codec as ScriptCodec).encode(pcm, pcm.length / (2 * this.channels))
      : (this.codec as NativeCodec).encode(pcm);
    return Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);
  }

  decode(data: Buffer): Buffer {
    const decoded = this.codec.decode(data);
    return Buffer.isBuffer(decoded) ? decoded : Buffer.from(decoded);
  }

  dispose(): void {
    if (this.mobile) (this.codec as ScriptCodec).delete();
  }
}
