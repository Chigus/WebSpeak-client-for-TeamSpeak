import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createRemotePlayback } from "../src/voice/remote-playback.ts";

// Execute the real playback lifecycle. Only WebCodecs and Web Audio are mocked;
// this verifies channel routing and cleanup, not hardware or Opus audio quality.
class TestDecoder {
  static instances = [];
  static failConfigure = false;
  decodeQueueSize = 0;
  closeCount = 0;
  decoded = [];
  queued = [];
  constructor(callbacks) { this.callbacks = callbacks; TestDecoder.instances.push(this); }
  configure(config) {
    if (TestDecoder.failConfigure) throw new Error("Decoder configuration failed");
    this.config = { ...config };
  }
  decode(chunk) { this.decoded.push(chunk); this.queued.push(chunk); this.decodeQueueSize++; }
  close() { this.closeCount++; }
  output(chunk) {
    const encoded = this.queued.shift();
    if (encoded) {
      chunk.timestamp ??= encoded.timestamp;
      this.decodeQueueSize = Math.max(0, this.decodeQueueSize - 1);
    }
    this.callbacks.output(chunk);
  }
  outputLater(chunk) { return Promise.resolve().then(() => this.output(chunk)); }
  errorLater() { return Promise.resolve().then(() => this.callbacks.error(new Error("Late decoder error"))); }
}

class TestEncodedChunk {
  constructor({ type, timestamp, duration, data }) {
    Object.assign(this, { type, timestamp, duration, data: new Uint8Array(data) });
  }
}

class TestGain {
  gain = { value: 1 };
  connections = [];
  disconnectCount = 0;
  failNextConnect = false;
  connect(node) {
    if (this.failNextConnect) { this.failNextConnect = false; throw new Error("Audio connection failed"); }
    if (!this.connections.includes(node)) this.connections.push(node);
  }
  disconnect() { this.disconnectCount++; this.connections.length = 0; }
}

class TestSource extends EventTarget {
  connections = [];
  startTimes = [];
  stopCount = 0;
  disconnectCount = 0;
  connect(node) { this.connections.push(node); }
  start(time) { this.startTimes.push(time); }
  stop() { this.stopCount++; }
  disconnect() { this.disconnectCount++; this.connections.length = 0; }
  end() { this.dispatchEvent(new Event("ended")); }
}

class TestContext {
  currentTime = 0;
  destination = {};
  buffers = [];
  sources = [];
  gains = [];
  advance(seconds, { audio = true } = {}) {
    clockTime += seconds * 1000;
    if (audio) this.currentTime += seconds;
    for (const source of this.sources) {
      if (source.startTimes[0] + source.buffer.duration <= this.currentTime + 1e-9) source.end();
    }
  }
  createGain() { const gain = new TestGain(); this.gains.push(gain); return gain; }
  createBufferSource() { const source = new TestSource(); this.sources.push(source); return source; }
  createBuffer(numberOfChannels, length, sampleRate) {
    const channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
    const buffer = {
      numberOfChannels, length, sampleRate, duration: length / sampleRate,
      copyToChannel(samples, channel) { channels[channel].set(samples); },
      getChannelData(channel) { return channels[channel]; },
    };
    this.buffers.push(buffer);
    return buffer;
  }
}

class TestAudioData {
  sampleRate = 48000;
  closeCount = 0;
  copyCalls = [];
  constructor(channels) {
    this.channels = channels.map(samples => Float32Array.from(samples));
    this.numberOfChannels = channels.length;
    this.numberOfFrames = channels[0].length;
  }
  copyTo(destination, { planeIndex, format }) {
    this.copyCalls.push({ planeIndex, format });
    destination.set(this.channels[planeIndex]);
  }
  close() { this.closeCount++; }
}

class TestNoiseSuppression {
  input = new TestGain();
  output = new TestGain();
  destroyCount = 0;
  failDestroy = false;
  failLevel = false;
  constructor(context, options) {
    this.context = context;
    this.options = options;
    this.levels = [options.level];
    this.input.connect(this.output); // Same stable, initially dry endpoints as the real factory.
    this.ready = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    options.onState?.("loading"); // Factories can report before returning the processor.
  }
  report(state) { this.options.onState?.(state); }
  activate() { this.report("active"); this.resolve(true); }
  setLevel(level) {
    if (this.failLevel) throw new Error("Level update failed");
    this.levels.push(level);
  }
  destroy() {
    this.destroyCount++;
    if (this.failDestroy) throw new Error("Processor cleanup failed");
    this.input.disconnect();
    this.output.disconnect();
  }
}

function audibleRoutes(node, destination, visited = new Set()) {
  if (node === destination) return 1;
  assert.ok(!visited.has(node), "the audio graph must not contain a feedback loop");
  return (node.connections ?? []).reduce((count, next) => count + audibleRoutes(next, destination, new Set([...visited, node])), 0);
}

const packet = Uint8Array.of(1, 2, 3, 4);
const globals = new Map();
const playbacks = new Set();
let clockTime = 0;

beforeEach(t => {
  clockTime = 0;
  t.mock.method(performance, "now", () => clockTime);
  TestDecoder.instances = [];
  TestDecoder.failConfigure = false;
  for (const [name, value] of [["AudioDecoder", TestDecoder], ["EncodedAudioChunk", TestEncodedChunk]]) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

afterEach(() => {
  for (const playback of playbacks) playback.clearAll();
  playbacks.clear();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  globals.clear();
});

function setup({ createNoiseSuppression = (context, options) => new TestNoiseSuppression(context, options) } = {}) {
  const state = { context: new TestContext(), volume: 0.7, errors: 0, drops: 0, contextReads: 0, noiseStates: [], denoisers: [] };
  const playback = createRemotePlayback({
    getContext() { state.contextReads++; return state.context; },
    getVolume() { return state.volume; },
    onDecodeError() { state.errors++; },
    onDrop() { state.drops++; },
    onNoiseSuppressionState(value) { state.noiseStates.push(value); },
  }, {
    createNoiseSuppression(context, options) {
      const processor = createNoiseSuppression(context, options);
      state.denoisers.push(processor);
      return processor;
    },
  });
  playbacks.add(playback);
  return { playback, state };
}

function audioFrame(channels = 2) {
  return new TestAudioData(Array.from({ length: channels }, (_, channel) => new Float32Array(960).fill(channel ? -0.75 : 0.25)));
}

test("direct PCM preserves independent ears, volume and the receive denoiser on route changes", () => {
  const { playback, state } = setup();
  playback.setNoiseSuppression(true, "heavy");
  const pcm = Int16Array.from({ length: 1920 }, (_, index) => index % 2 ? -8192 : 16384);
  assert.equal(playback.playPcm(7, pcm, 2), true);
  assert.equal(TestDecoder.instances.length, 0, "direct PCM must not require an Opus decoder");
  assert.equal(state.context.buffers[0].numberOfChannels, 2);
  assert.ok(state.context.buffers[0].getChannelData(0).every(sample => Math.abs(sample - 16384 / 32767) < 1e-6));
  assert.ok(state.context.buffers[0].getChannelData(1).every(sample => sample === -0.25));
  assert.equal(state.denoisers[0].options.channels, 2);
  assert.equal(state.denoisers[0].options.level, "heavy");
  assert.equal(state.context.gains[0].gain.value, state.volume);
  const directSource = state.context.sources[0];
  playback.play(7, packet, 5);
  assert.equal(directSource.stopCount, 1);
  assert.equal(state.denoisers[0].destroyCount, 1);
  assert.equal(TestDecoder.instances.length, 1);
  assert.equal(playback.playPcm(7, pcm, 2), true);
  assert.equal(TestDecoder.instances[0].closeCount, 1);
});

test("codec 4 defaults to mono while codec 5 configures stereo independently per speaker", () => {
  const { playback } = setup();
  playback.play(7, packet);
  playback.play(8, packet, 5);
  const [mono, stereo] = TestDecoder.instances;
  assert.deepEqual(mono.config, { codec: "opus", sampleRate: 48000, numberOfChannels: 1 });
  assert.deepEqual(stereo.config, { codec: "opus", sampleRate: 48000, numberOfChannels: 2 });
  playback.play(8, packet, 5);
  assert.equal(TestDecoder.instances.length, 2);
  assert.deepEqual(stereo.decoded.map(chunk => chunk.timestamp), [0, 20_000]);
  assert.deepEqual(stereo.decoded[0].data, packet);
  assert.equal(stereo.decoded[0].duration, 20_000);
});

test("unsupported codecs and truncated packets are dropped without disturbing a valid speaker", () => {
  const { playback, state } = setup();
  playback.play(7, packet, 5);
  const decoder = TestDecoder.instances[0];
  for (const codec of [0, 3, 6, -1, NaN]) playback.play(7, packet, codec);
  playback.play(8, packet, 6);
  playback.play(7, Uint8Array.of(1, 2), 5);
  assert.equal(state.drops, 7);
  assert.equal(state.errors, 0);
  assert.equal(state.contextReads, 1);
  assert.equal(TestDecoder.instances.length, 1);
  assert.equal(decoder.decoded.length, 1);
  assert.equal(decoder.closeCount, 0);
});

test("decoded stereo planes reach distinct AudioBuffer channels and the existing volume path", () => {
  const { playback, state } = setup();
  state.context.currentTime = 4;
  playback.play(7, packet, 5);
  const chunk = new TestAudioData([[0.25, 0.5, 0, -0.5], [-0.75, 0, 0.75, 1]]);
  TestDecoder.instances[0].output(chunk);
  const buffer = state.context.buffers[0];
  const source = state.context.sources[0];
  const gain = state.context.gains[0];
  const input = state.context.gains[1];
  assert.equal(buffer.numberOfChannels, 2);
  assert.equal(buffer.sampleRate, 48000);
  assert.deepEqual(buffer.getChannelData(0), chunk.channels[0]);
  assert.deepEqual(buffer.getChannelData(1), chunk.channels[1]);
  assert.deepEqual(chunk.copyCalls, [
    { planeIndex: 0, format: "f32-planar" },
    { planeIndex: 1, format: "f32-planar" },
  ]);
  assert.equal(source.buffer, buffer);
  assert.deepEqual(source.startTimes, [4.12]);
  assert.deepEqual(source.connections, [input]);
  assert.deepEqual(input.connections, [gain]);
  assert.equal(input.channelCount, 2);
  assert.equal(input.channelCountMode, "explicit");
  assert.equal(input.channelInterpretation, "discrete");
  assert.deepEqual(gain.connections, [state.context.destination]);
  assert.equal(gain.gain.value, 0.7);
  assert.equal(state.denoisers.length, 0, "receive processing is off by default");
  assert.equal(chunk.closeCount, 1);
  state.volume = 0.35;
  playback.updateVolume(7);
  assert.equal(gain.gain.value, 0.35);
  source.end();
  playback.clear(7);
  assert.equal(source.stopCount, 0, "ended sources must be released from the stream's live set");
});

test("changing mono to stereo and back closes queued playback and resets the decoder timeline", () => {
  const { playback, state } = setup();
  playback.play(7, packet, 4);
  const mono = TestDecoder.instances[0];
  mono.output(audioFrame(1));
  const oldSource = state.context.sources[0];
  playback.play(7, packet, 5);
  const stereo = TestDecoder.instances[1];
  assert.equal(mono.closeCount, 1);
  assert.equal(oldSource.stopCount, 1);
  assert.equal(oldSource.disconnectCount, 1);
  assert.equal(state.context.gains[0].disconnectCount, 1);
  assert.equal(stereo.config.numberOfChannels, 2);
  assert.equal(stereo.decoded[0].timestamp, 0);
  stereo.output(audioFrame(2));
  const stereoSource = state.context.sources[1];
  playback.play(7, packet, 4);
  const nextMono = TestDecoder.instances[2];
  assert.equal(stereo.closeCount, 1);
  assert.equal(stereoSource.stopCount, 1);
  assert.equal(nextMono.config.numberOfChannels, 1);
  assert.equal(nextMono.decoded[0].timestamp, 0);
  assert.equal(state.errors, 0);
});

test("late callbacks from a replaced codec close AudioData without playing or clearing its replacement", async () => {
  const { playback, state } = setup();
  playback.play(7, packet, 4);
  const oldDecoder = TestDecoder.instances[0];
  oldDecoder.output(audioFrame(1));
  const oldSource = state.context.sources[0];
  const staleChunk = audioFrame(1);
  const pending = [oldDecoder.outputLater(staleChunk), oldDecoder.errorLater()];
  playback.play(7, packet, 5);
  const replacement = TestDecoder.instances[1];
  const stereoChunk = audioFrame(2);
  replacement.output(stereoChunk);
  const newSource = state.context.sources[1];
  await Promise.all(pending);
  assert.equal(staleChunk.closeCount, 1);
  assert.equal(staleChunk.copyCalls.length, 0);
  assert.equal(state.context.buffers.length, 2);
  assert.equal(newSource.buffer.numberOfChannels, 2);
  assert.equal(replacement.closeCount, 0);
  assert.equal(state.errors, 0);
  oldSource.end();
  playback.clear(7);
  assert.equal(newSource.stopCount, 1, "an old ended event must not release a replacement's source");
  assert.equal(replacement.closeCount, 1);
});

for (const burstSize of [4, 10]) test(`${burstSize}-frame network bursts stay continuous without replacing stereo playback`, () => {
  const { playback, state } = setup();
  for (let frame = 0; frame < 6; frame++) {
    playback.play(7, packet, 5);
    TestDecoder.instances[0].output(audioFrame(2));
    state.context.advance(0.02);
  }
  const decoder = TestDecoder.instances[0];
  for (let burst = 0; burst < 3; burst++) {
    const previous = state.context.sources.at(-1);
    const previousEnd = previous.startTimes[0] + previous.buffer.duration;
    state.context.advance(burstSize * 0.02);
    const now = state.context.currentTime;
    const expectedStart = previousEnd > now ? previousEnd : now + 0.12;
    const sourceCount = state.context.sources.length;
    const decodedCount = decoder.decoded.length;
    for (let frame = 0; frame < burstSize; frame++) playback.play(7, packet, 5);
    assert.equal(decoder.decoded.length - decodedCount, burstSize);
    const chunks = Array.from({ length: burstSize }, () => audioFrame(2));
    for (const chunk of chunks) decoder.output(chunk);
    const sources = state.context.sources.slice(sourceCount);
    assert.equal(sources.length, burstSize);
    sources.forEach((source, index) => {
      assert.ok(Math.abs(source.startTimes[0] - (expectedStart + index * 0.02)) < 1e-9);
      assert.ok(source.startTimes[0] + source.buffer.duration <= now + 0.36 + 1e-9);
      assert.equal(source.buffer.numberOfChannels, 2);
    });
    assert.ok(chunks.every(chunk => chunk.closeCount === 1));
  }
  assert.equal(TestDecoder.instances.length, 1);
  assert.equal(decoder.closeCount, 0);
  assert.ok(state.context.sources.every(source => source.stopCount === 0));
  assert.equal(state.context.gains[0].disconnectCount, 0);
  assert.equal(state.drops, 0);
  assert.equal(state.errors, 0);
});

test("five speakers independently absorb ten-frame mono/stereo bursts", () => {
  const { playback, state } = setup();
  for (let speaker = 7; speaker < 12; speaker++) {
    for (let frame = 0; frame < 10; frame++) playback.play(speaker, packet, speaker % 2 ? 5 : 4);
  }
  for (const decoder of TestDecoder.instances) {
    assert.equal(decoder.decoded.length, 10);
    for (let frame = 0; frame < 10; frame++) decoder.output(audioFrame(decoder.config.numberOfChannels));
  }
  assert.equal(TestDecoder.instances.length, 5);
  assert.equal(state.context.sources.length, 50);
  assert.ok(state.context.sources.every(source => source.stopCount === 0));
  assert.equal(state.drops, 0);
  assert.equal(state.errors, 0);
});

test("sustained overload drops only excess frames and resumes as the bounded queue drains", () => {
  const { playback, state } = setup();
  for (let frame = 0; frame < 100; frame++) playback.play(7, packet, 5);
  const decoder = TestDecoder.instances[0];
  assert.equal(decoder.decoded.length, 12, "120ms prebuffer plus twelve 20ms frames fills the 360ms budget");
  assert.equal(state.drops, 88);
  const chunks = Array.from({ length: 12 }, () => audioFrame(2));
  for (const chunk of chunks) decoder.output(chunk);
  assert.equal(state.context.sources.length, 12);
  assert.ok(Math.abs(state.context.sources.at(-1).startTimes[0] + 0.02 - 0.36) < 1e-9);
  assert.ok(chunks.every(chunk => chunk.closeCount === 1));
  for (let frame = 0; frame < 100; frame++) playback.play(7, packet, 5);
  assert.equal(decoder.decoded.length, 12);
  assert.equal(state.drops, 188);
  state.context.advance(0.20);
  for (let frame = 0; frame < 10; frame++) playback.play(7, packet, 5);
  assert.equal(decoder.decoded.length, 22);
  for (let frame = 0; frame < 10; frame++) decoder.output(audioFrame(2));
  assert.ok(Math.abs(state.context.sources[12].startTimes[0] - 0.36) < 1e-9, "recovery joins existing scheduled audio");
  assert.ok(Math.abs(state.context.sources.at(-1).startTimes[0] + 0.02 - 0.56) < 1e-9);
  assert.equal(state.drops, 188);
  assert.equal(decoder.closeCount, 0);
  assert.equal(TestDecoder.instances.length, 1);
  assert.ok(state.context.sources.every(source => source.stopCount === 0));
});

test("completed decoding still counts against the fifteen-frame limit until outputs arrive", () => {
  const { playback, state } = setup();
  playback.play(7, packet, 5);
  const decoder = TestDecoder.instances[0];
  decoder.output(audioFrame(2));
  state.context.advance(0.13);
  for (let frame = 0; frame < 15; frame++) playback.play(7, packet, 5);
  assert.equal(decoder.decoded.length, 16);
  decoder.decodeQueueSize = 0; // Native codec work completed; main-thread outputs are still pending.
  playback.play(7, packet, 5);
  assert.equal(decoder.decoded.length, 16);
  assert.equal(state.drops, 1);
  for (let frame = 0; frame < 15; frame++) decoder.output(audioFrame(2));
  playback.play(7, packet, 5);
  assert.equal(decoder.decoded.length, 17);
  assert.equal(decoder.decoded.at(-1).timestamp - decoder.decoded.at(-2).timestamp, 40_000);
  decoder.output(audioFrame(2));
  assert.equal(state.context.sources.length, 17);
  assert.equal(decoder.closeCount, 0);
  assert.equal(state.drops, 1);
});

test("a native decoder queue overflow drops one packet while preserving existing stereo playback", () => {
  const { playback, state } = setup();
  playback.play(7, packet, 5);
  const initial = TestDecoder.instances[0];
  initial.output(audioFrame(2));
  initial.decodeQueueSize = 15;
  playback.play(7, packet, 5);
  assert.equal(TestDecoder.instances.length, 1);
  assert.equal(initial.closeCount, 0);
  assert.equal(state.context.sources[0].stopCount, 0);
  assert.equal(state.drops, 1);
  initial.decodeQueueSize = 0;
  playback.play(7, packet, 5);
  initial.output(audioFrame(2));
  assert.equal(state.context.sources.length, 2);
  assert.ok(Math.abs(state.context.sources[1].startTimes[0] - 0.14) < 1e-9);
  assert.equal(initial.config.numberOfChannels, 2);
});

test("late decoded frames are released instead of adding another prebuffer delay", () => {
  const { playback, state } = setup();
  for (let frame = 0; frame < 4; frame++) playback.play(7, packet, 5);
  const decoder = TestDecoder.instances[0];
  state.context.advance(0.35);
  const late = Array.from({ length: 4 }, () => audioFrame(2));
  for (const chunk of late) decoder.output(chunk);
  assert.ok(late.every(chunk => chunk.closeCount === 1 && chunk.copyCalls.length === 0));
  assert.equal(state.drops, 4);
  assert.equal(state.context.sources.length, 0);
  playback.play(7, packet, 5);
  decoder.output(audioFrame(2));
  assert.ok(Math.abs(state.context.sources[0].startTimes[0] - 0.47) < 1e-9);
  assert.equal(TestDecoder.instances.length, 1);
  assert.equal(decoder.closeCount, 0);
  assert.equal(state.errors, 0);
});

test("a decoder that stops delivering is replaced without stopping sources or accepting stale callbacks", async () => {
  const { playback, state } = setup();
  playback.play(7, packet, 5);
  const old = TestDecoder.instances[0];
  old.output(audioFrame(2));
  const source = state.context.sources[0];
  const gain = state.context.gains[0];
  state.context.advance(0.10);
  for (let frame = 0; frame < 3; frame++) playback.play(7, packet, 5);
  // A suspended AudioContext must not freeze the decoder's wall-clock deadline.
  state.context.advance(0.40, { audio: false });
  const stale = audioFrame(2);
  const pending = [old.outputLater(stale), old.errorLater()];
  playback.play(7, packet, 5);
  const replacement = TestDecoder.instances[1];
  assert.equal(old.closeCount, 1);
  assert.equal(source.stopCount, 0);
  assert.equal(source.disconnectCount, 0);
  assert.equal(gain.disconnectCount, 0);
  assert.equal(state.drops, 3);
  assert.equal(replacement.config.numberOfChannels, 2);
  replacement.output(audioFrame(2));
  await Promise.all(pending);
  assert.equal(stale.closeCount, 1);
  assert.equal(stale.copyCalls.length, 0);
  assert.equal(state.context.sources.length, 2);
  assert.ok(Math.abs(state.context.sources[1].startTimes[0] - 0.14) < 1e-9);
  assert.equal(replacement.closeCount, 0);
  assert.equal(state.drops, 3, "stale callbacks must not double-count frames discarded by recovery");
  assert.equal(state.errors, 0);
});

for (const codec of [4, 5]) test(`codec ${codec} accepts rounded and continuous output PTS after an input gap`, () => {
  const { playback, state } = setup();
  const channels = codec === 5 ? 2 : 1;
  for (let frame = 0; frame < 20; frame++) {
    playback.play(7, packet, codec);
    const chunk = audioFrame(channels);
    // Chrome Opus may round a nominal 260000 us timestamp down by one us.
    chunk.timestamp = frame === 13 ? 259_999 : frame * 20_000;
    TestDecoder.instances[0].output(chunk);
    state.context.advance(0.02);
  }
  const decoder = TestDecoder.instances[0];
  assert.equal(state.context.sources.length, 20);
  assert.equal(state.drops, 0);
  decoder.decodeQueueSize = 15;
  playback.play(7, packet, codec);
  decoder.decodeQueueSize = 0;
  state.context.advance(0.02);
  playback.play(7, packet, codec);
  assert.equal(decoder.decoded.at(-1).timestamp, 420_000);
  const recovered = audioFrame(channels);
  // The native decoder may synthesize continuous output PTS, ignoring the gap.
  recovered.timestamp = 400_000;
  decoder.output(recovered);
  assert.equal(recovered.closeCount, 1);
  assert.equal(state.context.sources.length, 21);
  assert.ok(state.context.sources.every(source => source.buffer.numberOfChannels === channels));
  assert.equal(state.drops, 1, "only the rejected input packet is a drop");
  assert.equal(state.errors, 0);
  assert.equal(TestDecoder.instances.length, 1);
  assert.equal(decoder.closeCount, 0);
});

test("FIFO receive times expire only old output while fresh audio survives PTS rounding", () => {
  const { playback, state } = setup();
  playback.play(7, packet, 5);
  const decoder = TestDecoder.instances[0];
  state.context.advance(0.20);
  playback.play(7, packet, 5);
  state.context.advance(0.10);
  const old = audioFrame(2);
  old.timestamp = 0;
  decoder.output(old);
  const fresh = audioFrame(2);
  fresh.timestamp = 19_999;
  decoder.output(fresh);
  assert.equal(state.drops, 1);
  assert.equal(old.copyCalls.length, 0);
  assert.equal(fresh.copyCalls.length, 2);
  assert.ok([old, fresh].every(chunk => chunk.closeCount === 1));
  assert.equal(state.context.sources.length, 1);
  assert.ok(Math.abs(state.context.sources[0].startTimes[0] - 0.42) < 1e-9);
  assert.equal(decoder.closeCount, 0);
  assert.equal(state.errors, 0);
});

test("context replacement preserves stereo while releasing the old context's resources", () => {
  const { playback, state } = setup();
  playback.play(7, packet, 5);
  const initial = TestDecoder.instances[0];
  initial.output(audioFrame(2));
  const previousContext = state.context;
  state.context = new TestContext();
  playback.play(7, packet, 5);
  const replacement = TestDecoder.instances[1];
  replacement.output(audioFrame(2));
  assert.equal(initial.closeCount, 1);
  assert.equal(previousContext.sources[0].stopCount, 1);
  assert.equal(previousContext.gains[0].disconnectCount, 1);
  assert.equal(replacement.config.numberOfChannels, 2);
  assert.equal(replacement.decoded[0].timestamp, 0);
  assert.equal(state.context.buffers[0].numberOfChannels, 2);
});

test("failed stereo configuration and clearAll clean up resources and invalidate late output", async () => {
  const { playback, state } = setup();
  TestDecoder.failConfigure = true;
  playback.play(7, packet, 5);
  assert.equal(state.errors, 1);
  assert.equal(TestDecoder.instances[0].closeCount, 1);
  assert.equal(state.context.gains[0].disconnectCount, 1);
  TestDecoder.failConfigure = false;
  playback.play(7, packet, 5);
  playback.play(8, packet, 4);
  const stereo = TestDecoder.instances[1];
  const mono = TestDecoder.instances[2];
  stereo.output(audioFrame(2));
  mono.output(audioFrame(1));
  const lateStereo = audioFrame(2);
  const lateMono = audioFrame(1);
  const pending = [stereo.outputLater(lateStereo), mono.outputLater(lateMono)];
  playback.clearAll();
  playback.clearAll();
  await Promise.all(pending);
  assert.ok(TestDecoder.instances.every(decoder => decoder.closeCount === 1));
  assert.ok(state.context.sources.every(source => source.stopCount === 1));
  assert.equal(lateStereo.closeCount, 1);
  assert.equal(lateMono.closeCount, 1);
  assert.equal(state.context.buffers.length, 2);
  assert.equal(state.errors, 1);
});

test("receive switches and all three levels preserve scheduled stereo, normal gain and one audible route", async () => {
  const { playback, state } = setup();
  playback.play(7, packet, 5);
  const decoder = TestDecoder.instances[0];
  decoder.output(audioFrame(2));
  const { context } = state;
  const [gain, input] = context.gains;
  const source = context.sources[0];
  assert.equal(audibleRoutes(source, context.destination), 1);

  playback.setNoiseSuppression(true, "light");
  const processor = state.denoisers[0];
  assert.equal(processor.options.channels, 2, "both stereo channels must enter the processor independently");
  assert.deepEqual(processor.levels, ["light"]);
  assert.deepEqual(input.connections, [processor.input]);
  assert.deepEqual(processor.output.connections, [gain]);
  assert.equal(state.noiseStates.at(-1), "loading");
  assert.equal(audibleRoutes(source, context.destination), 1, "model loading must retain one dry route");
  processor.activate();
  await Promise.resolve();
  assert.equal(state.noiseStates.at(-1), "active");
  playback.setNoiseSuppression(true, "medium");
  playback.setNoiseSuppression(true, "heavy");
  playback.setNoiseSuppression(true, "heavy");
  assert.deepEqual(processor.levels, ["light", "medium", "heavy"]);
  assert.equal(state.denoisers.length, 1, "level changes must not reload the model");

  state.volume = 0.35;
  playback.updateVolumes();
  assert.equal(gain.gain.value, 0.35);
  playback.play(7, packet, 5);
  decoder.output(audioFrame(2));
  playback.setNoiseSuppression(false, "heavy");
  assert.equal(state.noiseStates.at(-1), "off");
  assert.equal(processor.destroyCount, 1);
  assert.deepEqual(input.connections, [gain]);
  assert.equal(audibleRoutes(source, context.destination), 1);
  playback.setNoiseSuppression(false, "heavy");
  assert.equal(processor.destroyCount, 1);
  playback.play(7, packet, 5);
  decoder.output(audioFrame(2));

  assert.equal(TestDecoder.instances.length, 1);
  assert.equal(decoder.closeCount, 0);
  assert.deepEqual(decoder.decoded.map(chunk => chunk.timestamp), [0, 20_000, 40_000]);
  assert.deepEqual(context.sources.map(item => item.startTimes[0]), [0.12, 0.13999999999999999, 0.15999999999999998]);
  for (const scheduled of context.sources) {
    assert.equal(scheduled.stopCount, 0);
    assert.equal(scheduled.disconnectCount, 0);
    assert.deepEqual(scheduled.connections, [input]);
    assert.equal(audibleRoutes(scheduled, context.destination), 1);
    assert.equal(scheduled.buffer.numberOfChannels, 2);
    assert.equal(scheduled.buffer.getChannelData(0)[0], 0.25);
    assert.equal(scheduled.buffer.getChannelData(1)[0], -0.75);
  }
  assert.equal(gain.disconnectCount, 0);
  assert.equal(state.drops, 0);
  assert.equal(state.errors, 0);
});

test("every mono/stereo speaker has its own processor and failed status dominates pending peers", async () => {
  const { playback, state } = setup();
  playback.setNoiseSuppression(true, "heavy");
  assert.deepEqual(state.noiseStates, ["off"], "enabled with no speakers is waiting for audio");
  playback.play(7, packet, 4);
  playback.play(8, packet, 5);
  const [mono, stereo] = state.denoisers;
  assert.equal(mono.options.channels, 1);
  assert.equal(stereo.options.channels, 2);
  assert.notEqual(mono.input, stereo.input);
  assert.equal(state.noiseStates.at(-1), "loading");
  mono.activate();
  await Promise.resolve();
  assert.equal(state.noiseStates.at(-1), "loading");
  stereo.activate();
  await Promise.resolve();
  assert.equal(state.noiseStates.at(-1), "active");
  mono.report("failed");
  assert.equal(state.noiseStates.at(-1), "failed");
  assert.equal(mono.destroyCount, 1);
  assert.equal(stereo.destroyCount, 0);
  assert.deepEqual(state.context.gains[1].connections, [state.context.gains[0]]);
  playback.play(9, packet, 5);
  assert.equal(state.noiseStates.at(-1), "failed", "a new loading peer must not hide a failure");
  playback.clear(7);
  assert.equal(state.noiseStates.at(-1), "loading");
  state.denoisers[2].activate();
  await Promise.resolve();
  assert.equal(state.noiseStates.at(-1), "active");
  playback.clearAll();
  assert.equal(state.noiseStates.at(-1), "off");
  playback.play(10, packet, 4);
  assert.equal(state.denoisers.length, 4, "receive preference survives a period with no speakers");
  assert.equal(state.noiseStates.at(-1), "loading");
});

for (const failure of ["factory", "output-connect", "input-connect", "ready-false", "ready-rejection", "synchronous-state", "runtime-state", "level-update"]) {
  test(`receive ${failure} failure restores original audio without losing its decoder`, async () => {
    let attempts = 0;
    const { playback, state } = setup({
      createNoiseSuppression(context, options) {
        attempts++;
        if (attempts === 1 && failure === "factory") throw new Error("No denoising support");
        const processor = new TestNoiseSuppression(context, options);
        if (attempts === 1 && failure === "output-connect") processor.output.failNextConnect = true;
        if (attempts === 1 && failure === "synchronous-state") processor.report("failed");
        return processor;
      },
    });
    playback.play(7, packet, 5);
    const decoder = TestDecoder.instances[0];
    decoder.output(audioFrame(2));
    const { context } = state;
    const [gain, input] = context.gains;
    const source = context.sources[0];
    if (failure === "input-connect") input.failNextConnect = true;
    playback.setNoiseSuppression(true, "medium");
    const failed = state.denoisers[0];
    if (failure === "ready-false") failed.resolve(false);
    if (failure === "ready-rejection") failed.reject(new Error("Model loading rejected"));
    if (failure === "runtime-state") { failed.activate(); failed.report("failed"); }
    if (failure === "level-update") { failed.failLevel = true; playback.setNoiseSuppression(true, "heavy"); }
    await Promise.resolve();
    assert.equal(state.noiseStates.at(-1), "failed");
    assert.deepEqual(input.connections, [gain]);
    assert.equal(audibleRoutes(source, context.destination), 1);
    assert.equal(gain.gain.value, 0.7);
    assert.equal(source.stopCount, 0);
    assert.equal(source.disconnectCount, 0);
    assert.equal(decoder.closeCount, 0);
    if (failed) assert.equal(failed.destroyCount, 1);
    playback.play(7, packet, 5);
    decoder.output(audioFrame(2));
    assert.equal(TestDecoder.instances.length, 1);
    assert.equal(decoder.decoded.at(-1).timestamp, 20_000);
    assert.ok(Math.abs(context.sources[1].startTimes[0] - 0.14) < 1e-9);
    assert.equal(state.errors, 0, "an optional model failure is not a decoder error");
    assert.equal(state.drops, 0);

    playback.setNoiseSuppression(false, "heavy");
    playback.setNoiseSuppression(true, "heavy");
    const retry = state.denoisers.at(-1);
    assert.notEqual(retry, failed);
    retry.activate();
    await Promise.resolve();
    assert.equal(state.noiseStates.at(-1), "active");
    assert.equal(audibleRoutes(source, context.destination), 1);
  });
}

test("synchronous ready state from a factory is published only after its audible route is connected", () => {
  const { playback, state } = setup({
    createNoiseSuppression(context, options) {
      const processor = new TestNoiseSuppression(context, options);
      processor.activate();
      return processor;
    },
  });
  playback.setNoiseSuppression(true, "light");
  playback.play(7, packet, 5);
  TestDecoder.instances[0].output(audioFrame(2));
  assert.equal(state.noiseStates.at(-1), "active");
  assert.equal(audibleRoutes(state.context.sources[0], state.context.destination), 1);
  assert.deepEqual(state.context.gains[1].connections, [state.denoisers[0].input]);
});

test("late model callbacks after disable and re-enable cannot change the new graph or status", async () => {
  const { playback, state } = setup();
  playback.setNoiseSuppression(true, "light");
  playback.play(7, packet, 5);
  const old = state.denoisers[0];
  playback.setNoiseSuppression(false, "light");
  playback.setNoiseSuppression(true, "heavy");
  const current = state.denoisers[1];
  const statusCount = state.noiseStates.length;
  old.report("active");
  old.report("failed");
  old.reject(new Error("Retired processor rejected"));
  await Promise.resolve();
  assert.equal(state.noiseStates.length, statusCount);
  assert.equal(state.noiseStates.at(-1), "loading");
  assert.equal(old.destroyCount, 1);
  assert.equal(current.destroyCount, 0);
  assert.deepEqual(state.context.gains[1].connections, [current.input]);
  current.activate();
  await Promise.resolve();
  assert.equal(state.noiseStates.at(-1), "active");
});

for (const replacement of ["member", "codec", "context"]) {
  test(`receive ${replacement} replacement releases its model and ignores stale model callbacks`, async () => {
    const { playback, state } = setup();
    playback.setNoiseSuppression(true, "medium");
    playback.play(7, packet, 4);
    TestDecoder.instances[0].output(audioFrame(1));
    const previousContext = state.context;
    const old = state.denoisers[0];
    if (replacement === "member") playback.clear(7);
    if (replacement === "context") state.context = new TestContext();
    playback.play(7, packet, replacement === "codec" ? 5 : 4);
    const current = state.denoisers[1];
    const statusCount = state.noiseStates.length;
    assert.equal(old.destroyCount, 1);
    assert.equal(previousContext.sources[0].stopCount, 1);
    assert.equal(previousContext.gains[0].disconnectCount, 1);
    old.report("active");
    old.resolve(true);
    old.report("failed");
    await Promise.resolve();
    assert.equal(state.noiseStates.length, statusCount);
    assert.equal(state.noiseStates.at(-1), "loading");
    assert.equal(current.destroyCount, 0);
    assert.equal(current.context, state.context);
    assert.equal(current.options.channels, replacement === "codec" ? 2 : 1);
    current.activate();
    await Promise.resolve();
    assert.equal(state.noiseStates.at(-1), "active");
  });
}

test("a failed cleanup cannot retain other speakers, endpoints, decoders or scheduled sources", async () => {
  const { playback, state } = setup();
  playback.setNoiseSuppression(true, "heavy");
  playback.play(7, packet, 5);
  playback.play(8, packet, 4);
  TestDecoder.instances[0].output(audioFrame(2));
  TestDecoder.instances[1].output(audioFrame(1));
  const [first, second] = state.denoisers;
  first.failDestroy = true;
  const throwCleanup = () => { throw new Error("Already released resource"); };
  TestDecoder.instances[0].close = throwCleanup;
  state.context.sources[0].stop = throwCleanup;
  state.context.sources[0].disconnect = throwCleanup;
  state.context.gains[0].disconnect = throwCleanup;
  assert.doesNotThrow(() => playback.clearAll());
  assert.equal(first.destroyCount, 1);
  assert.equal(second.destroyCount, 1);
  assert.deepEqual(first.input.connections, []);
  assert.deepEqual(first.output.connections, []);
  assert.deepEqual(state.context.gains[1].connections, []);
  assert.equal(TestDecoder.instances[1].closeCount, 1);
  assert.equal(state.context.sources[1].stopCount, 1);
  assert.equal(state.context.sources[1].disconnectCount, 1);
  assert.equal(state.context.gains[2].disconnectCount, 1);
  assert.equal(state.noiseStates.at(-1), "off");
  first.report("failed");
  second.resolve(true);
  await Promise.resolve();
  assert.equal(state.noiseStates.at(-1), "off");
  playback.clearAll();
  assert.equal(first.destroyCount, 1);
  assert.equal(second.destroyCount, 1);
});

test("input-node allocation failure releases the volume node before a later speaker can recover", () => {
  const { playback, state } = setup();
  const createGain = state.context.createGain.bind(state.context);
  let allocations = 0;
  state.context.createGain = () => {
    if (++allocations === 2) throw new Error("Cannot allocate input");
    return createGain();
  };
  playback.play(7, packet, 5);
  assert.equal(state.errors, 1);
  assert.equal(state.context.gains[0].disconnectCount, 1);
  assert.equal(TestDecoder.instances.length, 0);
  playback.play(7, packet, 5);
  TestDecoder.instances[0].output(audioFrame(2));
  assert.equal(state.context.sources.length, 1);
  assert.equal(audibleRoutes(state.context.sources[0], state.context.destination), 1);
});

test("enabled receive processing preserves the 120ms prebuffer, 360ms budget and overload recovery", async () => {
  const { playback, state } = setup();
  playback.setNoiseSuppression(true, "heavy");
  for (let frame = 0; frame < 100; frame++) playback.play(7, packet, 5);
  const decoder = TestDecoder.instances[0];
  const processor = state.denoisers[0];
  assert.equal(decoder.decoded.length, 12);
  assert.equal(state.drops, 88);
  for (let frame = 0; frame < 12; frame++) decoder.output(audioFrame(2));
  assert.equal(state.context.sources[0].startTimes[0], 0.12);
  assert.ok(Math.abs(state.context.sources.at(-1).startTimes[0] + 0.02 - 0.36) < 1e-9);
  processor.activate();
  await Promise.resolve();
  state.context.advance(0.20);
  for (let frame = 0; frame < 10; frame++) playback.play(7, packet, 5);
  playback.setNoiseSuppression(true, "light");
  for (let frame = 0; frame < 10; frame++) decoder.output(audioFrame(2));
  assert.equal(decoder.decoded.length, 22);
  assert.ok(Math.abs(state.context.sources[12].startTimes[0] - 0.36) < 1e-9);
  assert.ok(Math.abs(state.context.sources.at(-1).startTimes[0] + 0.02 - 0.56) < 1e-9);
  assert.equal(TestDecoder.instances.length, 1);
  assert.equal(state.denoisers.length, 1);
  assert.equal(decoder.closeCount, 0);
  assert.equal(processor.destroyCount, 0);
  assert.ok(state.context.sources.every(source => source.stopCount === 0 && source.buffer.numberOfChannels === 2));
  assert.equal(state.drops, 88);
  assert.equal(state.errors, 0);
});

test("stalled decoder replacement preserves the active receive model and already scheduled audio", async () => {
  const { playback, state } = setup();
  playback.setNoiseSuppression(true, "heavy");
  playback.play(7, packet, 5);
  const old = TestDecoder.instances[0];
  old.output(audioFrame(2));
  const processor = state.denoisers[0];
  processor.activate();
  await Promise.resolve();
  state.context.advance(0.10);
  for (let frame = 0; frame < 3; frame++) playback.play(7, packet, 5);
  state.context.advance(0.40, { audio: false });
  playback.play(7, packet, 5);
  assert.equal(TestDecoder.instances.length, 2);
  assert.equal(old.closeCount, 1);
  assert.equal(state.denoisers.length, 1);
  assert.equal(processor.destroyCount, 0);
  assert.equal(state.noiseStates.at(-1), "active");
  const source = state.context.sources[0];
  assert.equal(source.stopCount, 0);
  assert.equal(source.disconnectCount, 0);
  assert.equal(audibleRoutes(source, state.context.destination), 1);
  assert.equal(state.drops, 3);
  assert.equal(state.errors, 0);
});
