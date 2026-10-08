interface RemotePlaybackOptions {
  getContext(): AudioContext;
  getVolume(clientId: number): number;
  onDecodeError(): void;
  onDrop(): void;
}

type OpusCodec = 4 | 5;

interface SpeakerPlayback {
  codec: OpusCodec;
  context: AudioContext;
  decoder: AudioDecoder | null;
  gain: GainNode;
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

export function createRemotePlayback(options: RemotePlaybackOptions) {
  const speakers = new Map<number, SpeakerPlayback>();

  function clear(clientId: number): void {
    const stream = speakers.get(clientId);
    if (!stream) return;
    // Invalidate callbacks before closing their resources.
    speakers.delete(clientId);
    stream.pendingFrames.length = 0;
    try { stream.decoder?.close(); } catch { /* decoder may already be closed */ }
    for (const source of stream.sources) {
      try { source.stop(); } catch { /* not started or already ended */ }
      source.disconnect();
    }
    stream.sources.clear();
    stream.gain.disconnect();
  }

  function output(clientId: number, stream: SpeakerPlayback, decoder: AudioDecoder, chunk: AudioData): void {
    try {
      if (speakers.get(clientId) !== stream || stream.decoder !== decoder) return;
      // Each 20 ms Opus packet yields one output in decode order. Browsers may
      // round output PTS or synthesize a continuous timeline across input gaps.
      const receivedAt = stream.pendingFrames.shift();
      if (receivedAt === undefined) { options.onDrop(); return; }
      const { context, gain, sources } = stream;
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
      source.connect(gain);
      source.addEventListener("ended", () => {
        source.disconnect();
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

  function create(clientId: number, context: AudioContext, codec: OpusCodec): SpeakerPlayback {
    const stream: SpeakerPlayback = {
      codec, context, decoder: null, gain: context.createGain(), sources: new Set(),
      pendingFrames: [],
      playTime: context.currentTime, timestamp: 0,
    };
    speakers.set(clientId, stream);
    stream.gain.gain.value = options.getVolume(clientId);
    stream.gain.connect(context.destination);
    configureDecoder(clientId, stream);
    return stream;
  }

  function play(clientId: number, opusData: Uint8Array, codec: number = 4): void {
    if ((codec !== 4 && codec !== 5) || opusData.length < 3) { options.onDrop(); return; }
    try {
      const context = options.getContext();
      let stream = speakers.get(clientId);
      if (stream && (stream.codec !== codec || stream.context !== context)) {
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

  return {
    play,
    clear,
    clearAll() { for (const id of speakers.keys()) clear(id); },
    updateVolume(clientId: number) {
      const stream = speakers.get(clientId);
      if (stream) stream.gain.gain.value = options.getVolume(clientId);
    },
    updateVolumes() { for (const [id, stream] of speakers) stream.gain.gain.value = options.getVolume(id); },
  };
}
