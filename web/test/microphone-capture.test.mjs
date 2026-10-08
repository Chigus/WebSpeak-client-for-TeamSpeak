import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const workletSource = await readFile(new URL("../public/mic-capture-worklet.js", import.meta.url), "utf8");

// Run the real processor with synthetic samples. No microphone, audio device,
// or remote session is opened by these tests.
function createProcessor(channels, onMessage = () => {}) {
  let Processor;
  const messages = [];
  runInNewContext(workletSource, {
    Float32Array,
    AudioWorkletProcessor: class {
      port = { postMessage(message, transfer) {
        const copy = structuredClone(message, { transfer });
        messages.push(copy);
        onMessage(copy);
      } };
    },
    registerProcessor(name, implementation) {
      assert.equal(name, "webspeak-mic-capture");
      Processor = implementation;
    },
  });
  return { processor: new Processor(channels ? { processorOptions: { channels } } : undefined), messages };
}

function feed(processor, left, right, quantumSizes = [128]) {
  let offset = 0;
  let quantum = 0;
  while (offset < left.length) {
    const count = Math.min(quantumSizes[quantum++ % quantumSizes.length], left.length - offset);
    const input = [left.subarray(offset, offset + count)];
    if (right) input.push(right.subarray(offset, offset + count));
    const output = [new Float32Array(count).fill(1), new Float32Array(count).fill(1)];
    assert.equal(processor.process([input], [output]), true);
    for (const samples of output) assert.ok(samples.every(value => value === 0), "capture must not play its input locally");
    offset += count;
  }
}

function energyLevel(samples) {
  return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
}

function closeTo(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} should equal ${expected}`);
}

function assertStereoFrame(message, left, right) {
  assert.equal(message.samples.length, left.length * 2);
  for (let index = 0; index < left.length; index++) {
    assert.equal(message.samples[index * 2], left[index], `left frame ${index}`);
    assert.equal(message.samples[index * 2 + 1], right[index], `right frame ${index}`);
  }
  closeTo(message.levels[0], energyLevel(left));
  closeTo(message.levels[1], energyLevel(right));
  closeTo(message.rms, Math.sqrt((energyLevel(left) ** 2 + energyLevel(right) ** 2) / 2));
}

for (const signal of ["left only", "right only", "opposite phase"]) {
  test(`worklet preserves ${signal} stereo across 128-frame render boundaries`, () => {
    const tone = Float32Array.from({ length: 1920 }, (_, index) => 0.25 * Math.sin(2 * Math.PI * 440 * index / 48000));
    const silence = new Float32Array(tone.length);
    const left = signal === "right only" ? silence : tone;
    const right = signal === "left only" ? silence : signal === "opposite phase" ? tone.map(value => -value) : tone;
    const { processor, messages } = createProcessor(2);
    feed(processor, left, right);
    assert.equal(messages.length, 2, "960 frames per channel must produce one 20 ms packet");
    messages.forEach((message, index) => assertStereoFrame(message,
      left.subarray(index * 960, (index + 1) * 960), right.subarray(index * 960, (index + 1) * 960)));
    assert.ok(messages[0].rms > 0, "opposite-phase ears must not cancel during metering");
  });
}

test("worklet retains both channels through partial and multiple-frame input chunks", () => {
  const left = Float32Array.from({ length: 3840 }, (_, index) => (index % 997) / 2048);
  const right = Float32Array.from({ length: 3840 }, (_, index) => -(index % 613) / 1024);
  const { processor, messages } = createProcessor(2);
  feed(processor, left, right, [127, 1, 513, 17, 2048, 64]);
  assert.equal(messages.length, 4);
  messages.forEach((message, index) => assertStereoFrame(message,
    left.subarray(index * 960, (index + 1) * 960), right.subarray(index * 960, (index + 1) * 960)));
});

test("worklet defaults to the original 960-sample mono format", () => {
  const input = Float32Array.from({ length: 1920 }, (_, index) => 0.5 * Math.sin(index / 13));
  const { processor, messages } = createProcessor();
  feed(processor, input);
  assert.equal(messages.length, 2);
  messages.forEach((message, index) => {
    const expected = input.subarray(index * 960, (index + 1) * 960);
    assert.deepEqual(message.samples, expected);
    assert.equal(message.levels.length, 1);
    closeTo(message.rms, energyLevel(expected));
    closeTo(message.levels[0], message.rms);
  });
});

test("worklet leaves an unavailable right channel silent and silences every output", () => {
  const { processor, messages } = createProcessor(2);
  const outputs = [[new Float32Array(128).fill(1), new Float32Array(128).fill(1)]];
  assert.equal(processor.process([], outputs), true);
  assert.equal(messages.length, 0);
  assert.ok(outputs.flat().every(samples => samples.every(value => value === 0)));
  const left = new Float32Array(960).fill(0.25);
  feed(processor, left);
  assertStereoFrame(messages[0], left, new Float32Array(960));
});

function makeStream(settings = {}) {
  const track = {
    readyState: "live", stopped: 0,
    getSettings: () => ({ ...settings }),
    stop() { this.readyState = "ended"; this.stopped++; },
  };
  return { track, getAudioTracks: () => [track], getTracks: () => [track] };
}

class AudioNodeStub {
  gain = { value: 1 };
  connections = [];
  disconnects = 0;
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.disconnects++; this.connections.length = 0; }
}

class WorkletNodeStub extends AudioNodeStub {
  port = { onmessage: null, closed: false, close() { this.closed = true; } };
  constructor(context, name, options) {
    super();
    this.options = options;
    this.name = name;
    context.worklets.push(this);
    context.nodes.push(this);
    this.processor = createProcessor(options.processorOptions.channels,
      message => this.port.onmessage?.({ data: message })).processor;
  }
}

function makeContext({ worklet = true, loadModule } = {}) {
  const context = {
    destination: new AudioNodeStub(), nodes: [], sources: [], destinations: [], gains: [], scripts: [], worklets: [], modules: [],
    createMediaStreamSource(stream) {
      const node = Object.assign(new AudioNodeStub(), { stream });
      this.nodes.push(node); this.sources.push(node); return node;
    },
    createMediaStreamDestination() {
      const node = Object.assign(new AudioNodeStub(), { stream: makeStream() });
      this.nodes.push(node); this.destinations.push(node); return node;
    },
    createGain() {
      const node = new AudioNodeStub();
      this.nodes.push(node); this.gains.push(node); return node;
    },
    createScriptProcessor(size, inputs, outputs) {
      const node = Object.assign(new AudioNodeStub(), { size, inputs, outputs });
      this.nodes.push(node); this.scripts.push(node); return node;
    },
  };
  if (worklet) context.audioWorklet = { async addModule(url) {
    context.modules.push(url);
    await loadModule?.(url);
  } };
  return context;
}

function captureOptions(context, stream, overrides = {}) {
  const controller = new AbortController();
  const received = [];
  return {
    controller, received,
    options: {
      context, stream, noiseSuppression: false, volume: 1, signal: controller.signal,
      assertCurrent() { if (controller.signal.aborted) throw new DOMException("Capture cancelled", "AbortError"); },
      onSamples(samples, rms, levels) { received.push({ samples: samples.slice(), rms, levels }); },
      ...overrides,
    },
  };
}

function scriptInput(left, right) {
  return { inputBuffer: {
    numberOfChannels: right ? 2 : 1,
    getChannelData: channel => channel === 0 ? left : right,
  } };
}

test("capture factory preserves stereo and capture ownership", async t => {
  // Vite resolves the real factory's WASM URL imports, as in voice-session tests.
  const { createServer } = await import("vite");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "AudioWorkletNode");
  Object.defineProperty(globalThis, "AudioWorkletNode", { configurable: true, writable: true, value: WorkletNodeStub });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "AudioWorkletNode", descriptor);
    else delete globalThis.AudioWorkletNode;
  });
  const vite = await createServer({
    configFile: false, root: fileURLToPath(new URL("../", import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom",
  });
  t.after(() => vite.close());
  const { createMicrophoneCaptureFactory } = await vite.ssrLoadModule("/src/voice/microphone-capture.ts");

  await t.test("stereo bypasses RNNoise, reports source metadata, and meters the gained capture path", async () => {
    const context = makeContext();
    const stream = makeStream({ channelCount: 2, sampleRate: 44100, echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    const { options, received } = captureOptions(context, stream, { channels: 2, noiseSuppression: true, volume: 0.4 });
    const capture = await createMicrophoneCaptureFactory().prepare(options);
    try {
      assert.deepEqual(context.modules, ["/mic-capture-worklet.js"]);
      assert.deepEqual(capture.processing, { echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        rnnoise: false, sourceChannelCount: 2, sourceSampleRate: 44100, captureChannelCount: 2 });
      assert.equal(context.destinations[0].channelCount, 2);
      assert.equal(context.gains[0].gain.value, 0.4);
      assert.ok(context.sources[0].connections.includes(context.gains[0]));
      assert.ok(context.gains[0].connections.includes(context.worklets[0]));
      assert.equal(context.gains[0].channelInterpretation, "discrete");
      assert.deepEqual(context.worklets[0].options.outputChannelCount, [2]);
      const left = new Float32Array(960).fill(0.2);
      const right = new Float32Array(960).fill(-0.1);
      feed(context.worklets[0].processor, left, right);
      assert.equal(received.length, 0, "a prepared graph must not publish samples");
      capture.activate();
      feed(context.worklets[0].processor, left, right);
      assert.equal(received.length, 1);
      assertStereoFrame(received[0], left, right);
      capture.setVolume(0.7);
      assert.equal(context.gains[0].gain.value, 0.7);
    } finally { capture.dispose(); }
    assert.equal(stream.track.stopped, 1);
  });

  for (const sourceChannels of [1, 4]) {
    await t.test(`rejects a reported ${sourceChannels}-channel source before fabricating stereo`, async () => {
      const context = makeContext();
      const stream = makeStream({ channelCount: sourceChannels, sampleRate: 48000 });
      const { options } = captureOptions(context, stream, { channels: 2 });
      await assert.rejects(createMicrophoneCaptureFactory().prepare(options), { name: "StereoInputUnavailableError" });
      assert.equal(stream.track.stopped, 1);
      assert.equal(context.nodes.length, 0);
    });
  }

  await t.test("keeps unreported source channels unknown instead of claiming a stereo source", async () => {
    const context = makeContext();
    const stream = makeStream();
    const { options } = captureOptions(context, stream, { channels: 2 });
    const capture = await createMicrophoneCaptureFactory().prepare(options);
    try {
      assert.equal(capture.processing.sourceChannelCount, null);
      assert.equal(capture.processing.sourceSampleRate, null);
      assert.equal(capture.processing.captureChannelCount, 2);
    } finally { capture.dispose(); }
  });

  await t.test("ScriptProcessor fallback interleaves one-sided and opposite-phase stereo with independent levels", async () => {
    const context = makeContext({ worklet: false });
    const stream = makeStream({ channelCount: 2, sampleRate: 48000 });
    const { options, received } = captureOptions(context, stream, { channels: 2 });
    const capture = await createMicrophoneCaptureFactory().prepare(options);
    const script = context.scripts[0];
    const left = new Float32Array(1024).fill(0.25);
    const silent = new Float32Array(1024);
    const right = left.map(sample => -sample);
    assert.equal(script.inputs, 2);
    assert.equal(script.outputs, 2);
    script.onaudioprocess(scriptInput(left, right));
    assert.equal(received.length, 0);
    capture.activate();
    for (const pair of [[left, silent], [silent, right], [left, right]]) {
      script.onaudioprocess(scriptInput(...pair));
      assertStereoFrame(received.at(-1), ...pair);
    }
    capture.dispose();
    capture.activate();
    script.onaudioprocess({ inputBuffer: { getChannelData() { throw new Error("released buffer must not be read"); } } });
    assert.equal(received.length, 3);
    assert.ok(script.disconnects > 0);
  });

  await t.test("mono fallback retains its original sample sequence and reports one channel", async () => {
    const context = makeContext({ worklet: false });
    const stream = makeStream({ channelCount: 1, sampleRate: 48000 });
    const { options, received } = captureOptions(context, stream);
    const capture = await createMicrophoneCaptureFactory().prepare(options);
    try {
      capture.activate();
      const samples = Float32Array.from({ length: 1024 }, (_, index) => Math.sin(index / 17));
      context.scripts[0].onaudioprocess(scriptInput(samples));
      assert.deepEqual(received[0].samples, samples);
      assert.equal(received[0].levels.length, 1);
      closeTo(received[0].levels[0], energyLevel(samples));
      assert.equal(capture.processing.captureChannelCount, 1);
      assert.equal(context.destinations[0].channelCount, 1);
    } finally { capture.dispose(); }
  });

  await t.test("cancellation while loading the worklet releases only the pending graph", async () => {
    const factory = createMicrophoneCaptureFactory();
    const oldContext = makeContext({ worklet: false });
    const oldStream = makeStream({ channelCount: 1, sampleRate: 48000 });
    const current = captureOptions(oldContext, oldStream);
    const oldCapture = await factory.prepare(current.options);
    oldCapture.activate();
    let finishModule;
    const module = new Promise(resolve => { finishModule = resolve; });
    const context = makeContext({ loadModule: () => module });
    const stream = makeStream({ channelCount: 2, sampleRate: 48000 });
    const candidate = captureOptions(context, stream, { channels: 2 });
    const pending = factory.prepare(candidate.options);
    candidate.controller.abort();
    assert.equal(stream.track.readyState, "ended");
    assert.equal(context.destinations[0].stream.track.readyState, "ended");
    assert.ok(context.nodes.every(node => node.disconnects > 0));
    finishModule();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(context.worklets.length, 0);
    assert.equal(context.scripts.length, 0);
    assert.equal(candidate.received.length, 0);
    assert.equal(oldStream.track.readyState, "live");
    oldContext.scripts[0].onaudioprocess(scriptInput(new Float32Array(960).fill(0.25)));
    assert.equal(current.received.length, 1);
    oldCapture.dispose();
  });

  await t.test("worklet teardown suppresses queued samples and cannot be reactivated", async () => {
    const context = makeContext();
    const stream = makeStream({ channelCount: 2 });
    const { options, received } = captureOptions(context, stream, { channels: 2 });
    const capture = await createMicrophoneCaptureFactory().prepare(options);
    const worklet = context.worklets[0];
    const queuedMessage = worklet.port.onmessage;
    capture.activate();
    queuedMessage({ data: { samples: new Float32Array(1920), rms: 0, levels: [0, 0] } });
    assert.equal(received.length, 1);
    capture.stopCapture();
    capture.activate();
    queuedMessage({ data: { samples: new Float32Array(1920), rms: 0, levels: [0, 0] } });
    assert.equal(received.length, 1);
    assert.equal(worklet.port.closed, true);
    assert.ok(worklet.disconnects > 0);
    assert.equal(stream.track.readyState, "live", "stopping PCM must preserve the stream for its owner");
    capture.dispose();
    capture.dispose();
    assert.equal(stream.track.stopped, 1);
  });
});
