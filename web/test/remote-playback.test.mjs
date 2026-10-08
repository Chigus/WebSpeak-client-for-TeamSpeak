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
  connect(node) { this.connections.push(node); }
  disconnect() { this.disconnectCount++; }
}

class TestSource extends EventTarget {
  connections = [];
  startTimes = [];
  stopCount = 0;
  disconnectCount = 0;
  connect(node) { this.connections.push(node); }
  start(time) { this.startTimes.push(time); }
  stop() { this.stopCount++; }
  disconnect() { this.disconnectCount++; }
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

function setup() {
  const state = { context: new TestContext(), volume: 0.7, errors: 0, drops: 0, contextReads: 0 };
  const playback = createRemotePlayback({
    getContext() { state.contextReads++; return state.context; },
    getVolume() { return state.volume; },
    onDecodeError() { state.errors++; },
    onDrop() { state.drops++; },
  });
  playbacks.add(playback);
  return { playback, state };
}

function audioFrame(channels = 2) {
  return new TestAudioData(Array.from({ length: channels }, (_, channel) => new Float32Array(960).fill(channel ? -0.75 : 0.25)));
}

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
  assert.deepEqual(source.connections, [gain]);
  assert.deepEqual(gain.connections, [state.context.destination]);
  assert.equal(gain.gain.value, 0.7);
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
