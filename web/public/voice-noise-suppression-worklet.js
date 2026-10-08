// RNNoise model/ABI: @sapphi-red/web-noise-suppressor 0.4.0,
// @shiguredo/rnnoise-wasm 2022.2.0. Model assets remain in that dependency.
// This host acknowledges readiness, exposes model VAD, handles arbitrary render
// quanta, and shares one WASM runtime per AudioContext. Profiles need listening QA.
const FRAME_SIZE = 480;
const SAMPLE_RATE = 48000;
const PROFILES = {
  light: { highpass: 70, floor: 0.5, hold: 0.18, release: 0.18, harmonics: 0 },
  medium: { highpass: 85, floor: 0.126, hold: 0.22, release: 0.16, harmonics: 3 },
  heavy: { highpass: 100, floor: 0.016, hold: 0.26, release: 0.14, harmonics: 6 },
};
let sharedRuntime;

function getRuntime(module) {
  if (sharedRuntime) return sharedRuntime;
  let memory, bytes;
  function refresh() {
    if (!bytes || bytes.buffer !== memory.buffer) bytes = new Uint8Array(memory.buffer);
    return bytes;
  }
  const env = {
    __assert_fail() { throw new Error("RNNoise WASM assertion failed"); },
    emscripten_memcpy_big(destination, source, length) {
      refresh().copyWithin(destination, source, source + length);
      return destination;
    },
    emscripten_resize_heap(requested) {
      if (!memory || requested > 64 * 1024 * 1024) return 0;
      try {
        const pages = Math.ceil((requested - memory.buffer.byteLength) / 65536);
        if (pages > 0) memory.grow(pages);
        refresh();
        return 1;
      } catch { return 0; }
    },
  };
  const instance = new WebAssembly.Instance(module, { env, wasi_snapshot_preview1: env });
  const api = instance.exports;
  memory = api.memory;
  if (!memory || typeof api.rnnoise_process_frame !== "function"
    || typeof api.rnnoise_create !== "function" || typeof api.rnnoise_destroy !== "function"
    || typeof api.malloc !== "function" || typeof api.free !== "function") {
    throw new Error("Unsupported RNNoise WASM ABI");
  }
  api.emscripten_stack_init();
  api.__wasm_call_ctors();
  if (api.rnnoise_get_frame_size() !== FRAME_SIZE) throw new Error("Unsupported RNNoise frame size");
  sharedRuntime = { api, memory };
  return sharedRuntime;
}

class Biquad {
  constructor() { this.z1 = 0; this.z2 = 0; this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; }
  configure(kind, frequency, q) {
    const omega = 2 * Math.PI * frequency / SAMPLE_RATE;
    const cosine = Math.cos(omega);
    const alpha = Math.sin(omega) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (kind === "highpass" ? (1 + cosine) / 2 : 1) / a0;
    this.b1 = (kind === "highpass" ? -(1 + cosine) : -2 * cosine) / a0;
    this.b2 = this.b0;
    this.a1 = -2 * cosine / a0;
    this.a2 = (1 - alpha) / a0;
  }
  process(input) {
    const output = this.b0 * input + this.z1;
    this.z1 = this.b1 * input - this.a1 * output + this.z2;
    this.z2 = this.b2 * input - this.a2 * output;
    return output;
  }
}

// Detect stable mains peaks in 100 ms windows, where 50 and 60 Hz are distinct
// bins. Require three non-speech windows. Never blanket-notch both harmonic sets.
class HumFilter {
  constructor(profile) {
    this.profile = profile;
    this.bins = Array.from({ length: 12 }, (_, index) => ({
      coefficient: 2 * Math.cos(2 * Math.PI * (index < 6 ? 50 : 60) * (index % 6 + 1) / SAMPLE_RATE),
      s1: 0, s2: 0,
    }));
    this.powers = new Float64Array(12);
    this.hits = new Uint8Array(6);
    this.filters = Array.from({ length: 6 }, () => ({ filter: new Biquad(), wet: 0, target: 0 }));
    this.count = 0; this.energy = 0; this.vad = 0;
    this.family = 0; this.candidate = 0; this.confirmations = 0; this.absent = 0;
  }
  setProfile(profile) { this.profile = profile; this.updateTargets(); }
  updateTargets() {
    for (let index = 0; index < 6; index++) {
      this.filters[index].target = this.family && index < this.profile.harmonics && this.hits[index] >= 3 ? 1 : 0;
    }
  }
  analyse() {
    const energy = this.energy / this.count;
    for (let index = 0; index < 12; index++) {
      const bin = this.bins[index];
      this.powers[index] = Math.max(0, 2 * (bin.s1 * bin.s1 + bin.s2 * bin.s2
        - bin.coefficient * bin.s1 * bin.s2) / (this.count * this.count));
      bin.s1 = 0; bin.s2 = 0;
    }
    const vad = this.vad;
    this.count = 0; this.energy = 0; this.vad = 0;
    if (vad > 0.35) return;
    const first = this.powers[0], second = this.powers[6];
    const candidate = first > second * 1.8 ? 50 : second > first * 1.8 ? 60 : 0;
    if (!candidate || energy < 1e-10 || Math.max(first, second) < energy * 0.02) {
      this.confirmations = 0;
      if (++this.absent >= 5) { this.hits.fill(0); this.updateTargets(); }
      return;
    }
    this.absent = 0;
    if (this.candidate !== candidate) {
      this.candidate = candidate; this.confirmations = 0; this.hits.fill(0);
    }
    this.confirmations++;
    const offset = candidate === 50 ? 0 : 6;
    for (let index = 0; index < 6; index++) {
      this.hits[index] = this.powers[offset + index] > energy * 0.03
        ? Math.min(4, this.hits[index] + 1) : Math.max(0, this.hits[index] - 1);
    }
    if (this.confirmations < 3) return;
    if (this.family !== candidate) {
      this.family = candidate;
      for (let index = 0; index < 6; index++) {
        const stage = this.filters[index];
        stage.wet = 0;
        stage.filter.z1 = 0; stage.filter.z2 = 0;
        stage.filter.configure("notch", candidate * (index + 1), 35);
      }
    }
    this.updateTargets();
  }
  observe(input, vad) {
    this.energy += input * input;
    this.vad = Math.max(this.vad, vad);
    for (let index = 0; index < 12; index++) {
      const bin = this.bins[index];
      const next = input + bin.coefficient * bin.s1 - bin.s2;
      bin.s2 = bin.s1; bin.s1 = next;
    }
    if (++this.count === 4800) this.analyse();
  }
  process(input) {
    for (let index = 0; index < 6; index++) {
      const stage = this.filters[index];
      const filtered = stage.filter.process(input);
      stage.wet += (stage.target - stage.wet) * 0.001;
      input += (filtered - input) * stage.wet;
    }
    return input;
  }
}

class DenoiseChannel {
  constructor(runtime, level) {
    this.runtime = runtime;
    this.state = 0; this.inputPointer = 0; this.outputPointer = 0;
    this.position = 0; this.vad = 0; this.gain = 1; this.hold = 0; this.destroyed = false;
    this.silenceSamples = 0; this.sleeping = false;
    this.inputFrame = new Float32Array(FRAME_SIZE);
    this.outputFrame = new Float32Array(FRAME_SIZE);
    this.highpass = new Biquad();
    this.profile = level === "light" || level === "heavy" ? PROFILES[level] : PROFILES.medium;
    this.cutoff = this.profile.highpass;
    this.highpass.configure("highpass", this.cutoff, Math.SQRT1_2);
    this.hum = new HumFilter(this.profile);
    try {
      this.state = runtime.api.rnnoise_create(0);
      this.inputPointer = runtime.api.malloc(FRAME_SIZE * 4);
      this.outputPointer = runtime.api.malloc(FRAME_SIZE * 4);
      if (!this.state || !this.inputPointer || !this.outputPointer) throw new Error("RNNoise allocation failed");
      // Readiness requires an actual model call and finite output.
      this.processFrame();
    } catch (error) { this.destroy(); throw error; }
  }
  setLevel(level) {
    this.profile = level === "light" || level === "heavy" ? PROFILES[level] : PROFILES.medium;
    this.hum.setProfile(this.profile);
  }
  processFrame() {
    const memory = this.runtime.memory.buffer;
    if (memory !== this.buffer) {
      this.buffer = memory;
      this.wasmInput = new Float32Array(memory, this.inputPointer, FRAME_SIZE);
      this.wasmOutput = new Float32Array(memory, this.outputPointer, FRAME_SIZE);
    }
    this.wasmInput.set(this.inputFrame);
    const probability = this.runtime.api.rnnoise_process_frame(this.state, this.outputPointer, this.inputPointer);
    if (!Number.isFinite(probability)) throw new Error("RNNoise returned invalid voice probability");
    this.vad = Math.max(0, Math.min(1, probability));
    const profile = this.profile;
    if (this.runtime.memory.buffer !== this.buffer) {
      this.buffer = this.runtime.memory.buffer;
      this.wasmInput = new Float32Array(this.buffer, this.inputPointer, FRAME_SIZE);
      this.wasmOutput = new Float32Array(this.buffer, this.outputPointer, FRAME_SIZE);
    }
    if (this.vad >= 0.45) this.hold = Math.round(profile.hold * SAMPLE_RATE);
    const speech = Math.max(0, Math.min(1, (this.vad - 0.08) / 0.37));
    const voiceGain = profile.floor + (1 - profile.floor) * speech * speech * (3 - 2 * speech);
    const attack = Math.exp(-1 / (0.005 * SAMPLE_RATE));
    const release = Math.exp(-1 / (profile.release * SAMPLE_RATE));
    for (let index = 0; index < FRAME_SIZE; index++) {
      const target = this.hold > 0 ? 1 : voiceGain;
      if (this.hold > 0) this.hold--;
      this.gain = target + (this.gain - target) * (target > this.gain ? attack : release);
      const sample = this.wasmOutput[index] / 32767;
      if (!Number.isFinite(sample)) throw new Error("RNNoise returned invalid PCM");
      this.outputFrame[index] = Math.max(-1, Math.min(1, sample * this.gain));
    }
    this.cutoff += (profile.highpass - this.cutoff) * 0.1;
    this.highpass.configure("highpass", this.cutoff, Math.SQRT1_2);
  }
  render(input, output) {
    if (this.silenceSamples >= SAMPLE_RATE) {
      let audible = false;
      for (let index = 0; index < (input?.length || 0); index++) {
        if (Number.isFinite(input[index]) && input[index] !== 0) { audible = true; break; }
      }
      if (!audible) {
        if (!this.sleeping) {
          this.inputFrame.fill(0); this.outputFrame.fill(0); this.position = 0;
          this.sleeping = true;
        }
        output.fill(0);
        return;
      }
      this.sleeping = false; this.silenceSamples = 0;
    }
    for (let index = 0; index < output.length; index++) {
      const value = input?.[index] ?? 0;
      const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      this.silenceSamples = sample === 0 ? Math.min(SAMPLE_RATE, this.silenceSamples + 1) : 0;
      this.hum.observe(sample, this.vad);
      const filtered = this.hum.process(this.highpass.process(sample));
      // One FIFO frame plus RNNoise's own frame delay: about 20 ms at 48 kHz.
      output[index] = this.outputFrame[this.position];
      this.inputFrame[this.position] = filtered * 32767;
      if (++this.position === FRAME_SIZE) { this.position = 0; this.processFrame(); }
    }
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    const api = this.runtime.api;
    try { if (this.state) api.rnnoise_destroy(this.state); } catch { /* Free both buffers too. */ }
    try { if (this.inputPointer) api.free(this.inputPointer); } catch { /* Continue cleanup. */ }
    try { if (this.outputPointer) api.free(this.outputPointer); } catch { /* Continue cleanup. */ }
    this.state = 0; this.inputPointer = 0; this.outputPointer = 0;
  }
}

class VoiceNoiseSuppressionProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = options?.processorOptions?.channels === 2 ? 2 : 1;
    this.states = [];
    this.destroyed = false; this.failed = false;
    this.port.onmessage = event => {
      if (event.data?.type === "destroy") { this.destroy(); return; }
      if (this.destroyed || this.failed) return;
      if (event.data?.type === "level" && Object.hasOwn(PROFILES, event.data.level)) {
        for (const state of this.states) state.setLevel(event.data.level);
      }
    };
    try {
      if (sampleRate !== SAMPLE_RATE) throw new Error("RNNoise requires a 48 kHz AudioContext");
      const runtime = getRuntime(options?.processorOptions?.wasmModule);
      for (let index = 0; index < this.channels; index++) {
        this.states.push(new DenoiseChannel(runtime, options?.processorOptions?.level));
      }
      this.port.postMessage({ type: "ready" });
    } catch (error) { this.fail(error); }
  }
  fail(error) {
    if (this.failed || this.destroyed) return;
    this.failed = true;
    sharedRuntime = undefined;
    for (const state of this.states) state.destroy();
    this.states.length = 0;
    this.port.postMessage({ type: "failed", reason: String(error?.message || error).slice(0, 180) });
  }
  bypass(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0] || [];
    for (let channel = 0; channel < output.length; channel++) {
      const source = input?.[channel];
      const target = output[channel];
      target.fill(0);
      if (source) target.set(source.subarray(0, target.length));
    }
  }
  process(inputs, outputs) {
    if (this.destroyed) return false;
    if (this.failed) { this.bypass(inputs, outputs); return true; }
    try {
      const input = inputs[0];
      const output = outputs[0] || [];
      for (let channel = 0; channel < output.length; channel++) {
        if (channel < this.states.length) this.states[channel].render(input?.[channel], output[channel]);
        else output[channel].fill(0);
      }
    } catch (error) { this.fail(error); this.bypass(inputs, outputs); }
    return true;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const state of this.states) state.destroy();
    this.states.length = 0;
  }
}
registerProcessor("webspeak-voice-noise-suppression", VoiceNoiseSuppressionProcessor);
