import { createNoiseSuppression, type NoiseSuppression, type NoiseSuppressionLevel, type NoiseSuppressionState } from "./noise-suppression.js";

interface RemotePlaybackOptions {
  getContext(): AudioContext;
  getVolume(clientId: number): number;
  onDecodeError(): void;
  onDrop(): void;
  onNoiseSuppressionState?(state: NoiseSuppressionState | "off"): void;
}

type OpusCodec = 4 | 5;

interface SpeakerNoiseSuppression {
  processor: NoiseSuppression | null;
  state: NoiseSuppressionState;
  rerouted: boolean;
}

interface SpeakerPlayback {
  codec: OpusCodec;
  pcm: boolean;
  context: AudioContext;
  decoder: AudioDecoder | null;
  gain: GainNode;
  input: GainNode;
  noise: SpeakerNoiseSuppression | null;
  sources: Set<AudioBufferSourceNode>;
  pendingFrames: number[];
  playTime: number;
  timestamp: number;
}

// WSS can deliver several 20 ms packets together after a network/main-thread stall.
// Reserve a short prebuffer, then bound scheduled AND not-yet-delivered audio.
const PREBUFFER_SECONDS = 0.12;
const MAX_PLAY_AHEAD_SECONDS = 0.36;
const MAX_DECODE_QUEUE_FRAMES = 15;
const FRAME_DURATION_US = 20_000;
const FRAME_DURATION_SECONDS = FRAME_DURATION_US / 1_000_000;
const SCHEDULE_EPSILON_SECONDS = 0.000001;

export function createRemotePlayback(
  options: RemotePlaybackOptions,
  dependencies: { createNoiseSuppression?: typeof createNoiseSuppression } = {},
) {
  const speakers = new Map<number, SpeakerPlayback>();
  const createDenoiser = dependencies.createNoiseSuppression ?? createNoiseSuppression;
  let noiseEnabled = false;
  let noiseLevel: NoiseSuppressionLevel = "medium";
  let reportedNoiseState: NoiseSuppressionState | "off" | undefined;

  function clean(operation: () => void): void {
    try { operation(); } catch { /* Release the other independently owned resources. */ }
  }

  function reportNoiseState(): void {
    let state: NoiseSuppressionState | "off" = "off";
    if (noiseEnabled && speakers.size) {
      state = "active";
      for (const stream of speakers.values()) {
        if (stream.noise?.state === "failed") { state = "failed"; break; }
        if (!stream.noise || stream.noise.state === "loading") state = "loading";
      }
    }
    if (reportedNoiseState === state) return;
    reportedNoiseState = state;
    clean(() => options.onNoiseSuppressionState?.(state));
  }

  function releaseDenoiser(processor: NoiseSuppression | null): void {
    if (!processor) return;
    clean(() => processor.destroy());
    // Also disconnect endpoints if a partially initialized processor cannot destroy itself.
    clean(() => processor.input.disconnect());
    clean(() => processor.output.disconnect());
  }

  function releaseNoise(stream: SpeakerPlayback, restoreDry: boolean): void {
    const noise = stream.noise;
    if (!noise) return;
    // A synchronously delivered destroy callback cannot publish into this stream.
    stream.noise = null;
    if (restoreDry && noise.rerouted) {
      clean(() => stream.input.disconnect());
      clean(() => stream.input.connect(stream.gain));
    }
    releaseDenoiser(noise.processor);
    noise.processor = null;
  }

  function attachNoise(clientId: number, stream: SpeakerPlayback): void {
    const noise: SpeakerNoiseSuppression = { processor: null, state: "loading", rerouted: false };
    stream.noise = noise;
    const isCurrent = () => noiseEnabled && speakers.get(clientId) === stream && stream.noise === noise;
    function fail(): void {
      if (!isCurrent()) return;
      const processor = noise.processor;
      noise.processor = null;
      noise.state = "failed";
      if (noise.rerouted) {
        noise.rerouted = false;
        clean(() => stream.input.disconnect());
        clean(() => stream.input.connect(stream.gain));
      }
      releaseDenoiser(processor);
      reportNoiseState();
    }
    reportNoiseState();
    if (!isCurrent()) return;
    try {
      const processor = createDenoiser(stream.context, {
        channels: stream.codec === 5 ? 2 : 1,
        level: noiseLevel,
        onState(state) {
          if (!isCurrent() || noise.state === "failed") return;
          noise.state = state;
          // The factory may report synchronously, before its endpoints are returned.
          if (!noise.processor) return;
          if (state === "failed") fail();
          else if (noise.rerouted) reportNoiseState();
        },
      });
      if (!isCurrent()) { releaseDenoiser(processor); return; }
      noise.processor = processor;
      void processor.ready.then(success => {
        if (!isCurrent() || noise.processor !== processor || noise.state === "failed") return;
        if (!success) { fail(); return; }
        noise.state = "active";
        reportNoiseState();
      }, () => {
        if (isCurrent() && noise.processor === processor) fail();
      });
      if (noise.state === "failed") { fail(); return; }
      // Stable endpoints initially pass dry audio. Only the speaker's input is
      // rerouted; already scheduled sources, decoder and timing remain intact.
      processor.output.connect(stream.gain);
      noise.rerouted = true;
      stream.input.disconnect();
      stream.input.connect(processor.input);
      reportNoiseState();
    } catch { fail(); }
  }

  function clear(clientId: number): void {
    const stream = speakers.get(clientId);
    if (!stream) return;
    // Invalidate callbacks before closing their resources.
    speakers.delete(clientId);
    stream.pendingFrames.length = 0;
    clean(() => stream.decoder?.close());
    for (const source of stream.sources) {
      clean(() => source.stop());
      clean(() => source.disconnect());
    }
    stream.sources.clear();
    clean(() => stream.input.disconnect());
    releaseNoise(stream, false);
    clean(() => stream.gain.disconnect());
    reportNoiseState();
  }

  function output(clientId: number, stream: SpeakerPlayback, decoder: AudioDecoder | null, chunk: Pick<AudioData, "sampleRate" | "numberOfChannels" | "numberOfFrames" | "copyTo" | "close">): void {
    try {
      if (speakers.get(clientId) !== stream || stream.decoder !== decoder) return;
      // Each 20 ms Opus packet yields one output in decode order. Browsers may
      // round output PTS or synthesize a continuous timeline across input gaps.
      const receivedAt = stream.pendingFrames.shift();
      if (receivedAt === undefined) { options.onDrop(); return; }
      const { context, input, sources } = stream;
      const { sampleRate, numberOfChannels, numberOfFrames } = chunk;
      const now = context.currentTime;
      const playTime = stream.playTime > now ? stream.playTime : now + PREBUFFER_SECONDS;
      const duration = numberOfFrames / sampleRate;
      const playAhead = playTime + duration - now;
      const decodeAge = (performance.now() - receivedAt) / 1000;
      if (playAhead + Math.max(0, decodeAge) > MAX_PLAY_AHEAD_SECONDS + SCHEDULE_EPSILON_SECONDS) {
        // Keep already scheduled audio continuous; discard only this late frame.
        options.onDrop();
        return;
      }
      const buffer = context.createBuffer(numberOfChannels, numberOfFrames, sampleRate);
      for (let channel = 0; channel < numberOfChannels; channel++) {
        const samples = new Float32Array(numberOfFrames);
        chunk.copyTo(samples, { planeIndex: channel, format: "f32-planar" });
        buffer.copyToChannel(samples, channel);
      }
      const source = context.createBufferSource();
      sources.add(source);
      source.buffer = buffer;
      source.connect(input);
      source.addEventListener("ended", () => {
        clean(() => source.disconnect());
        // The old stream owns this set; never delete a replacement's resources.
        sources.delete(source);
      }, { once: true });
      source.start(playTime);
      stream.playTime = playTime + duration;
    } catch {
      if (speakers.get(clientId) === stream && stream.decoder === decoder) {
        options.onDecodeError();
        clear(clientId);
      }
    } finally {
      chunk.close();
    }
  }

  function configureDecoder(clientId: number, stream: SpeakerPlayback): void {
    const decoder = new AudioDecoder({
      output: chunk => output(clientId, stream, decoder, chunk),
      error: () => {
        if (speakers.get(clientId) !== stream || stream.decoder !== decoder) return;
        options.onDecodeError();
        clear(clientId);
      },
    });
    stream.decoder = decoder;
    // TeamSpeak Opus Voice is mono; Opus Music preserves both audio channels.
    decoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: stream.codec === 5 ? 2 : 1 });
  }

  function create(clientId: number, context: AudioContext, codec: OpusCodec, pcm = false): SpeakerPlayback {
    const gain = context.createGain();
    let input: GainNode;
    try { input = context.createGain(); }
    catch (error) { clean(() => gain.disconnect()); throw error; }
    const stream: SpeakerPlayback = {
      codec, pcm, context, decoder: null, gain, input, noise: null, sources: new Set(),
      pendingFrames: [],
      playTime: context.currentTime, timestamp: 0,
    };
    speakers.set(clientId, stream);
    stream.gain.gain.value = options.getVolume(clientId);
    stream.gain.connect(context.destination);
    stream.input.channelCount = codec === 5 ? 2 : 1;
    stream.input.channelCountMode = "explicit";
    stream.input.channelInterpretation = "discrete";
    stream.input.connect(stream.gain);
    if (!pcm) configureDecoder(clientId, stream);
    if (noiseEnabled) attachNoise(clientId, stream);
    return stream;
  }

  function play(clientId: number, opusData: Uint8Array, codec: number = 4): void {
    if ((codec !== 4 && codec !== 5) || opusData.length < 3) { options.onDrop(); return; }
    try {
      const context = options.getContext();
      let stream = speakers.get(clientId);
      if (stream && (stream.pcm || stream.codec !== codec || stream.context !== context)) {
        clear(clientId);
        stream = undefined;
      }
      stream ??= create(clientId, context, codec);
      if (speakers.get(clientId) !== stream) return;
      const receivedAt = performance.now();
      const oldestPending = stream.pendingFrames[0];
      if (oldestPending !== undefined && receivedAt - oldestPending > MAX_PLAY_AHEAD_SECONDS * 1000) {
        // A decoder that never delivers output must not block this speaker forever.
        // Retire only that decoder; its late callbacks cannot touch its replacement.
        const oldDecoder = stream.decoder;
        stream.decoder = null;
        try { oldDecoder?.close(); } catch { /* decoder may already be closed */ }
        for (const _ of stream.pendingFrames) options.onDrop();
        stream.pendingFrames.length = 0;
        configureDecoder(clientId, stream);
      }
      const timestamp = stream.timestamp;
      stream.timestamp += FRAME_DURATION_US;
      const playAhead = stream.playTime > context.currentTime
        ? stream.playTime - context.currentTime : PREBUFFER_SECONDS;
      // decodeQueueSize may be zero while output callbacks are still queued.
      if (stream.pendingFrames.length >= MAX_DECODE_QUEUE_FRAMES
        || (stream.decoder?.decodeQueueSize ?? 0) >= MAX_DECODE_QUEUE_FRAMES
        || playAhead + (stream.pendingFrames.length + 1) * FRAME_DURATION_SECONDS > MAX_PLAY_AHEAD_SECONDS + SCHEDULE_EPSILON_SECONDS) {
        options.onDrop();
        return;
      }
      stream.pendingFrames.push(receivedAt);
      stream.decoder?.decode(new EncodedAudioChunk({ type: "key", timestamp, duration: FRAME_DURATION_US, data: opusData }));
    } catch {
      options.onDecodeError();
      clear(clientId);
    }
  }

  function playPcm(clientId: number, samples: Int16Array, channels: 1 | 2): boolean {
    if (samples.length !== 960 * channels) return false;
    try {
      const context = options.getContext();
      const codec = channels === 2 ? 5 : 4;
      let stream = speakers.get(clientId);
      if (stream && (!stream.pcm || stream.codec !== codec || stream.context !== context)) {
        clear(clientId); stream = undefined;
      }
      stream ??= create(clientId, context, codec, true);
      stream.pendingFrames.push(performance.now());
      output(clientId, stream, null, {
        sampleRate: 48000, numberOfChannels: channels, numberOfFrames: 960,
        copyTo(destination, layout) {
          const target = destination as Float32Array;
          for (let index = 0; index < target.length; index++) {
            const sample = samples[index * channels + (layout?.planeIndex ?? 0)]!;
            target[index] = sample / (sample < 0 ? 32768 : 32767);
          }
        },
        close() {},
      });
      return speakers.get(clientId) === stream;
    } catch { clear(clientId); options.onDecodeError(); return false; }
  }

  return {
    playPcm,
    play,
    clear,
    clearAll() { for (const id of speakers.keys()) clear(id); },
    setNoiseSuppression(enabled: boolean, level: NoiseSuppressionLevel = noiseLevel) {
      const previousLevel = noiseLevel;
      noiseEnabled = enabled;
      noiseLevel = level === "light" || level === "heavy" ? level : "medium";
      for (const [id, stream] of speakers) {
        if (!enabled) releaseNoise(stream, true);
        else if (!stream.noise) attachNoise(id, stream);
        else if (previousLevel !== noiseLevel && stream.noise.processor) {
          try { stream.noise.processor.setLevel(noiseLevel); }
          catch {
            releaseNoise(stream, true);
            stream.noise = { processor: null, state: "failed", rerouted: false };
          }
        }
      }
      reportNoiseState();
    },
    updateVolume(clientId: number) {
      const stream = speakers.get(clientId);
      if (stream) stream.gain.gain.value = options.getVolume(clientId);
    },
    updateVolumes() { for (const [id, stream] of speakers) stream.gain.gain.value = options.getVolume(id); },
  };
}
