interface AudioEncoderConfig {
  codec: string; sampleRate: number; numberOfChannels: number; bitrate: number;
  bitrateMode?: "constant" | "variable"; opus?: { frameDuration: number };
}
interface EncodedAudioChunk { readonly byteLength: number; copyTo(destination: AllowSharedBufferSource): void }
declare class AudioEncoder {
  constructor(init: { output(chunk: EncodedAudioChunk): void; error(error: DOMException): void });
  static isConfigSupported(config: AudioEncoderConfig): Promise<{ supported: boolean; config: AudioEncoderConfig }>;
  readonly encodeQueueSize: number;
  configure(config: AudioEncoderConfig): void; encode(data: AudioData): void; close(): void;
}
