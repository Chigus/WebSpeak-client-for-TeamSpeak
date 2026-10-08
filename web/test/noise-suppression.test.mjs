import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../public/voice-noise-suppression-worklet.js", import.meta.url), "utf8");
const binary = await readFile(new URL("../node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise.wasm", import.meta.url));
const regularModule = await WebAssembly.compile(binary);
const simdBinary = await readFile(new URL("../node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise_simd.wasm", import.meta.url));

function harness(module = regularModule, rate = 48000) {
  let Processor;
  const messages = [];
  const metrics = { instances: 0, frames: 0, states: 0, freedStates: 0, buffers: 0, freedBuffers: 0, fail: false };
  const sandbox = {
    sampleRate: rate,
    WebAssembly: { Instance: class {
      constructor(compiled, imports) {
        metrics.instances++;
        const api = new WebAssembly.Instance(compiled, imports).exports;
        this.exports = {
          ...api,
          rnnoise_create(...args) { metrics.states++; return api.rnnoise_create(...args); },
          rnnoise_destroy(...args) { metrics.freedStates++; return api.rnnoise_destroy(...args); },
          malloc(...args) { metrics.buffers++; return api.malloc(...args); },
          free(...args) { metrics.freedBuffers++; return api.free(...args); },
          rnnoise_process_frame(...args) {
            metrics.frames++;
            if (metrics.fail) throw new Error("Synthetic processor failure");
            return api.rnnoise_process_frame(...args);
          },
        };
      }
    } },
    AudioWorkletProcessor: class {
      port = { onmessage: null, postMessage(message) { messages.push(message); } };
    },
    registerProcessor(name, implementation) {
      assert.equal(name, "webspeak-voice-noise-suppression");
      Processor = implementation;
    },
  };
  runInNewContext(source + "\nglobalThis.components = { HumFilter, PROFILES, DenoiseChannel };", sandbox);
  return {
    metrics, messages, components: sandbox.components,
    create(channels = 2, level = "medium", wasmModule = module) {
      return new Processor({ processorOptions: { channels, level, wasmModule } });
    },
  };
}
function render(processor, left, right, sizes = [128]) {
  const output = [new Float32Array(left.length), new Float32Array(left.length)];
  let offset = 0, quantum = 0;
  while (offset < left.length) {
    const size = Math.min(sizes[quantum++ % sizes.length], left.length - offset);
    const input = [left.subarray(offset, offset + size)];
    if (right) input.push(right.subarray(offset, offset + size));
    const block = [new Float32Array(size), new Float32Array(size)];
    assert.equal(processor.process([input], [block]), true);
    for (let channel = 0; channel < 2; channel++) output[channel].set(block[channel], offset);
    offset += size;
  }
  return output;
}
function rms(samples, start = 0) {
  let energy = 0;
  for (let index = start; index < samples.length; index++) energy += samples[index] ** 2;
  return Math.sqrt(energy / Math.max(1, samples.length - start));
}
const signal = Float32Array.from({ length: 14400 }, (_, index) =>
  0.15 * Math.sin(index * 0.031) + 0.05 * Math.sin(index * 0.11));

for (const [name, module] of [
  ["regular", regularModule],
  ["SIMD", WebAssembly.validate(simdBinary) ? await WebAssembly.compile(simdBinary) : null],
]) {
  test("real RNNoise " + name + " initializes independent stereo state and preserves a silent ear", t => {
    if (!module) { t.skip("This runtime does not support WASM SIMD"); return; }
    const scope = harness(module);
    const processor = scope.create();
    assert.deepEqual(scope.messages.map(message => message.type), ["ready"]);
    assert.equal(scope.metrics.states, 2);
    const output = render(processor, signal);
    assert.ok(output[0].every(Number.isFinite));
    assert.ok(rms(output[0], 1920) > 1e-8, "the actual model must produce audio");
    assert.ok(output[1].every(value => value === 0), "a silent right ear must not copy the left");
    processor.destroy(); processor.destroy();
    assert.equal(scope.metrics.freedStates, 2);
    assert.equal(scope.metrics.freedBuffers, 4);
    assert.equal(processor.process([], [[new Float32Array(128)]]), false);
  });
}
test("real model output is continuous across arbitrary render quantum boundaries", () => {
  const scope = harness();
  const right = signal.map(value => -value);
  const first = scope.create(), second = scope.create();
  const regular = render(first, signal, right);
  const variable = render(second, signal, right, [1, 127, 513, 2048, 65]);
  assert.equal(scope.metrics.instances, 1, "peers share a runtime, not a denoise state");
  for (let channel = 0; channel < 2; channel++) {
    for (let index = 0; index < signal.length; index++) {
      assert.ok(Math.abs(regular[channel][index] - variable[channel][index]) < 1e-6);
    }
  }
  first.destroy(); second.destroy();
});
test("prototype-named settings cannot change or break a medium processor", () => {
  const scope = harness();
  const medium = scope.create(1, "medium");
  const invalid = scope.create(1, "__proto__");
  for (const level of ["__proto__", "constructor", "toString"]) {
    invalid.port.onmessage({ data: { type: "level", level } });
  }
  assert.deepEqual(render(invalid, signal)[0], render(medium, signal)[0]);
  assert.ok(scope.messages.every(message => message.type === "ready"));
  medium.destroy(); invalid.destroy();
});
test("processor failures restore both original channels and release allocations", () => {
  const scope = harness();
  const processor = scope.create();
  scope.metrics.fail = true;
  const left = signal.subarray(0, 480), right = left.map(value => -value);
  const output = [[new Float32Array(480), new Float32Array(480)]];
  processor.process([[left, right]], output);
  assert.deepEqual(output[0][0], left);
  assert.deepEqual(output[0][1], right);
  assert.equal(scope.messages.at(-1).type, "failed");
  assert.equal(scope.metrics.freedStates, 2);
  assert.equal(scope.metrics.freedBuffers, 4);
  processor.destroy();
});
test("invalid module and incompatible sample rate report failure, never ready", () => {
  for (const [module, rate] of [[{}, 48000], [regularModule, 44100]]) {
    const scope = harness(module, rate), processor = scope.create();
    assert.deepEqual(scope.messages.map(message => message.type), ["failed"]);
    const left = signal.subarray(0, 128), right = left.map(value => -value);
    const output = [[new Float32Array(128), new Float32Array(128)]];
    processor.process([[left, right]], output);
    assert.deepEqual(output[0][0], left); assert.deepEqual(output[0][1], right);
    processor.destroy();
  }
});
test("idle peers stop inference after the silent tail and resume on actual samples", () => {
  const scope = harness(), processor = scope.create(1);
  render(processor, new Float32Array(60000));
  const before = scope.metrics.frames;
  render(processor, new Float32Array(24000));
  assert.equal(scope.metrics.frames, before);
  render(processor, signal);
  assert.ok(scope.metrics.frames > before);
  processor.destroy();
});
for (const frequency of [50, 60]) {
  test("hum filtering detects only the " + frequency + " Hz family and attenuates stable harmonics", () => {
    const { components } = harness();
    const filter = new components.HumFilter(components.PROFILES.heavy);
    let before = 0, after = 0;
    for (let index = 0; index < 96000; index++) {
      const phase = 2 * Math.PI * frequency * index / 48000;
      const value = 0.12 * Math.sin(phase) + 0.08 * Math.sin(2 * phase) + 0.04 * Math.sin(3 * phase);
      filter.observe(value, 0);
      const output = filter.process(value);
      if (index > 72000) { before += value * value; after += output * output; }
    }
    assert.equal(filter.family, frequency);
    assert.ok(10 * Math.log10(before / after) > 20, "isolated hum component reduction, not speech-quality proof");
    assert.equal(filter.filters[3].target, 0, "an absent harmonic must not get a blanket notch");
  });
}
test("voiced content does not train hum notches and light mode disables added notches", () => {
  const { components } = harness();
  const filter = new components.HumFilter(components.PROFILES.heavy);
  for (let index = 0; index < 24000; index++) {
    const value = Math.sin(2 * Math.PI * 50 * index / 48000) * 0.1;
    filter.observe(value, 1);
    assert.equal(filter.process(value), value);
  }
  assert.equal(filter.family, 0);
  filter.family = 50; filter.hits.fill(4);
  filter.setProfile(components.PROFILES.light);
  assert.ok(filter.filters.every(stage => stage.target === 0));
});
test("residual attenuation has three strengths while detected speech opens every grade", () => {
  const { components } = harness();
  const input = Float32Array.from({ length: 96000 }, (_, index) => 0.1 * Math.sin(2 * Math.PI * 700 * index / 48000));
  function levelRms(level, vad) {
    let pointer = 64;
    const memory = { buffer: new ArrayBuffer(16384) };
    const runtime = { memory, api: {
      rnnoise_create: () => 1, rnnoise_destroy() {}, free() {},
      malloc(size) { const result = pointer; pointer += size; return result; },
      // Controlled denoised audio/VAD isolates the residual envelope from the AI.
      rnnoise_process_frame(state, output, input) {
        new Float32Array(memory.buffer, output, 480).set(new Float32Array(memory.buffer, input, 480));
        return vad;
      },
    } };
    const channel = new components.DenoiseChannel(runtime, level);
    const output = new Float32Array(input.length);
    channel.render(input, output); channel.destroy();
    return rms(output, 72000);
  }
  const noise = ["light", "medium", "heavy"].map(level => levelRms(level, 0));
  assert.ok(noise[1] < noise[0] * 0.35);
  assert.ok(noise[2] < noise[1] * 0.3);
  const speech = ["light", "medium", "heavy"].map(level => levelRms(level, 1));
  assert.ok(Math.min(...speech) > 0.95 * Math.max(...speech));
});

class ParameterStub {
  value = 1;
  events = [];
  cancelScheduledValues(time) { this.events.push(["cancel", time]); }
  setValueAtTime(value, time) { this.events.push(["set", value, time]); this.value = value; }
  linearRampToValueAtTime(value, time) { this.events.push(["ramp", value, time]); this.value = value; }
}
class NodeStub {
  gain = new ParameterStub();
  connections = [];
  disconnects = 0;
  connect(target) { this.connections.push(target); return target; }
  disconnect(target) {
    this.disconnects++;
    this.connections = target ? this.connections.filter(value => value !== target) : [];
  }
}
class WorkletStub extends NodeStub {
  port = { onmessage: null, onmessageerror: null, sent: [], closed: false,
    postMessage(value) { this.sent.push(value); }, close() { this.closed = true; } };
  constructor(context, name, options) {
    super(); this.name = name; this.options = options;
    context.worklets.push(this); context.created(this);
  }
  emit(type) { this.port.onmessage?.({ data: { type } }); }
}
function contextStub(load = async () => {}) {
  let created;
  const nodeCreated = new Promise(resolve => { created = resolve; });
  const context = {
    sampleRate: 48000, currentTime: 0, state: "running", gains: [], worklets: [], loads: 0,
    created, nodeCreated,
    createGain() { const gain = new NodeStub(); this.gains.push(gain); return gain; },
    audioWorklet: { async addModule() { context.loads++; await load(); } },
  };
  return context;
}
function bypassRoute(context, graph) {
  return context.gains.find(node => graph.input.connections.includes(node) && node.connections.includes(graph.output));
}
async function createdNode(context, graph) {
  return Promise.race([context.nodeCreated, graph.ready.then(() => { throw new Error("no worklet was created"); })]);
}

test("shared noise graph readiness, fallback, caching and disposal", async t => {
  const { createServer } = await import("vite");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "AudioWorkletNode");
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  let fetchMode = "ready";
  Object.defineProperty(globalThis, "AudioWorkletNode", { configurable: true, writable: true, value: WorkletStub });
  globalThis.fetch = async () => {
    fetches++;
    if (fetchMode === "unavailable") throw new Error("Model download unavailable");
    return { arrayBuffer: async () => fetchMode === "invalid" ? new Uint8Array([60, 104, 116, 109, 108, 62]).buffer
      : binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength) };
  };
  const vite = await createServer({
    configFile: false, root: fileURLToPath(new URL("../", import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom",
  });
  t.after(async () => {
    globalThis.fetch = previousFetch;
    if (descriptor) Object.defineProperty(globalThis, "AudioWorkletNode", descriptor);
    else delete globalThis.AudioWorkletNode;
    await vite.close();
  });
  const { createNoiseSuppression } = await vite.ssrLoadModule("/src/voice/noise-suppression.ts");
  await t.test("network failures and invalid WASM keep original audio and allow a retry", async () => {
    for (const mode of ["unavailable", "invalid"]) {
      fetchMode = mode;
      const context = contextStub(), states = [];
      const graph = createNoiseSuppression(context, { channels: 2, level: "heavy", onState: state => states.push(state) });
      assert.equal(await graph.ready, false);
      assert.equal(bypassRoute(context, graph).gain.value, 1);
      assert.deepEqual(states, ["loading", "failed"]);
      assert.equal(context.worklets.length, 0);
      graph.destroy();
    }
    fetchMode = "ready";
  });
  await t.test("starts dry, waits for real readiness, and falls back on processorerror", async () => {
    const context = contextStub(), states = [];
    const graph = createNoiseSuppression(context, { channels: 2, level: "medium", onState: state => states.push(state) });
    const dry = bypassRoute(context, graph);
    assert.equal(dry.gain.value, 1);
    graph.setLevel("heavy");
    const node = await createdNode(context, graph);
    assert.equal(node.options.processorOptions.level, "heavy");
    assert.equal(node.options.channelInterpretation, "discrete");
    assert.deepEqual(node.options.outputChannelCount, [2]);
    assert.deepEqual(states, ["loading"]);
    node.emit("ready");
    assert.equal(await graph.ready, true);
    assert.equal(dry.gain.value, 0);
    assert.deepEqual(dry.gain.events, [
      ["cancel", 0], ["set", 1, 0], ["set", 1, 0.025], ["ramp", 0, 0.045],
    ], "keep original audio for 25 ms while RNNoise primes, then fade over 20 ms");
    assert.deepEqual(node.connections[0].gain.events, [
      ["cancel", 0], ["set", 0, 0], ["set", 0, 0.025], ["ramp", 1, 0.045],
    ]);
    graph.setLevel("light");
    assert.deepEqual(node.port.sent.at(-1), { type: "level", level: "light" });
    node.onprocessorerror();
    assert.equal(dry.gain.value, 1);
    assert.deepEqual(states, ["loading", "active", "failed"]);
    assert.equal(node.port.closed, true);
    graph.destroy(); graph.destroy();
    assert.ok(context.gains.every(gain => gain.disconnects > 0));
  });
  await t.test("caches assets globally and registers once per context", async () => {
    const context = contextStub();
    const first = createNoiseSuppression(context, { channels: 1, level: "light" });
    await createdNode(context, first);
    context.worklets[0].emit("ready"); await first.ready;
    const second = createNoiseSuppression(context, { channels: 2, level: "heavy" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.worklets.length, 2);
    context.worklets[1].emit("ready"); await second.ready;
    assert.equal(context.loads, 1);
    assert.equal(fetches, 3, "two failed downloads are retried; the successful model is then reused");
    first.destroy(); second.destroy();
  });
  await t.test("destroy during module loading settles immediately and ignores late readiness", async () => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const context = contextStub(() => pending), states = [];
    const graph = createNoiseSuppression(context, { channels: 1, level: "medium", onState: state => states.push(state) });
    graph.destroy();
    assert.equal(await graph.ready, false);
    finish(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.worklets.length, 0);
    assert.deepEqual(states, ["loading"]);
    assert.ok(context.gains.every(gain => gain.disconnects > 0));
  });
  await t.test("late worklet callbacks cannot reactivate a destroyed graph", async () => {
    const context = contextStub(), states = [];
    const graph = createNoiseSuppression(context, { channels: 1, level: "medium", onState: state => states.push(state) });
    const node = await createdNode(context, graph), queued = node.port.onmessage;
    graph.destroy(); queued({ data: { type: "ready" } });
    assert.equal(await graph.ready, false);
    assert.deepEqual(states, ["loading"]);
  });
  await t.test("partial endpoint allocation releases nodes independently", () => {
    const context = contextStub();
    const create = context.createGain;
    context.createGain = function () {
      if (this.gains.length === 2) throw new Error("Audio graph allocation failed");
      return create.call(this);
    };
    assert.throws(() => createNoiseSuppression(context, { channels: 1, level: "medium" }), /allocation failed/);
    assert.equal(context.gains.length, 2);
    assert.ok(context.gains.every(gain => gain.disconnects > 0));
    assert.equal(context.loads, 0);
  });
  await t.test("module failure and unsupported rate preserve original audio", async () => {
    const wrongRate = contextStub(); wrongRate.sampleRate = 44100;
    const failedModule = contextStub(async () => { throw new Error("missing worklet"); });
    for (const context of [failedModule, wrongRate]) {
      const states = [];
      const graph = createNoiseSuppression(context, { channels: 1, level: "heavy", onState: state => states.push(state) });
      assert.equal(await graph.ready, false);
      assert.equal(bypassRoute(context, graph).gain.value, 1);
      assert.deepEqual(states, ["loading", "failed"]);
      assert.equal(context.worklets.length, 0);
      graph.destroy();
    }
    assert.equal(wrongRate.loads, 0);
  });
  await t.test("a worklet that never acknowledges readiness times out safely", async child => {
    child.mock.timers.enable({ apis: ["setTimeout"] });
    const context = contextStub(), states = [];
    const graph = createNoiseSuppression(context, { channels: 1, level: "medium", onState: state => states.push(state) });
    await createdNode(context, graph);
    child.mock.timers.tick(8000);
    assert.equal(await graph.ready, false);
    assert.equal(bypassRoute(context, graph).gain.value, 1);
    assert.deepEqual(states, ["loading", "failed"]);
    graph.destroy();
  });
});
