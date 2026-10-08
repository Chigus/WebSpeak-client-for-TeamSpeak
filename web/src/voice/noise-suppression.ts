export type NoiseSuppressionLevel = "light" | "medium" | "heavy";
export type NoiseSuppressionState = "loading" | "active" | "failed";

export interface NoiseSuppressionOptions {
  channels: 1 | 2;
  level: NoiseSuppressionLevel;
  onState?(state: NoiseSuppressionState): void;
}

export interface NoiseSuppression {
  input: AudioNode;
  output: AudioNode;
  ready: Promise<boolean>;
  setLevel(level: NoiseSuppressionLevel): void;
  destroy(): void;
}

const PROCESSOR_NAME = "webspeak-voice-noise-suppression";
const WORKLET_URL = "/voice-noise-suppression-worklet.js";
const LOAD_TIMEOUT_MS = 8_000;
const PRIME_SECONDS = 0.025;
const FADE_SECONDS = 0.02;
const modules = new WeakMap<AudioContext, Promise<void>>();
let model: Promise<WebAssembly.Module> | undefined;

function bounded<T>(operation: Promise<T>, abort?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort?.();
      reject(new Error("Noise suppression initialization timed out"));
    }, LOAD_TIMEOUT_MS);
  });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}

function loadModel(): Promise<WebAssembly.Module> {
  if (!model) {
    const controller = new AbortController();
    const operation = (async () => {
      // Browser classes and Vite asset URLs stay out of the Node import path.
      const [library, regular, simd] = await Promise.all([
        import("@sapphi-red/web-noise-suppressor"),
        import("@sapphi-red/web-noise-suppressor/rnnoise.wasm?url"),
        import("@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url"),
      ]);
      const binary = await library.loadRnnoise({ url: regular.default, simdUrl: simd.default }, {
        signal: controller.signal, credentials: "same-origin",
      });
      // Compile off the audio thread. HTTP error bodies fail compilation too.
      return WebAssembly.compile(binary);
    })();
    const pending = bounded(operation, () => controller.abort()).catch(error => {
      if (model === pending) model = undefined;
      throw error;
    });
    model = pending;
  }
  return model;
}

function loadModule(context: AudioContext): Promise<void> {
  let pending = modules.get(context);
  if (!pending) {
    pending = bounded(context.audioWorklet.addModule(WORKLET_URL)).catch(error => {
      if (modules.get(context) === pending) modules.delete(context);
      throw error;
    });
    modules.set(context, pending);
  }
  return pending;
}

function normalizeLevel(level: NoiseSuppressionLevel): NoiseSuppressionLevel {
  return level === "light" || level === "heavy" ? level : "medium";
}

/** Stable endpoints pass original audio until the real model acknowledges readiness. */
export function createNoiseSuppression(context: AudioContext, options: NoiseSuppressionOptions): NoiseSuppression {
  const owned: AudioNode[] = [];
  const clean = (operation: () => void) => { try { operation(); } catch { /* Continue independent cleanup. */ } };
  function gain(value: number) {
    const node = context.createGain();
    owned.push(node);
    node.channelCount = options.channels;
    node.channelCountMode = "explicit";
    node.channelInterpretation = "discrete";
    node.gain.value = value;
    return node;
  }
  let input: GainNode, output: GainNode, bypass: GainNode, processed: GainNode;
  try {
    input = gain(1);
    output = gain(1);
    bypass = gain(1);
    processed = gain(0);
    input.connect(bypass);
    bypass.connect(output);
    processed.connect(output);
  } catch (error) {
    for (const resource of owned) clean(() => resource.disconnect());
    throw error;
  }

  let level = normalizeLevel(options.level);
  let destroyed = false, failed = false;
  let node: AudioWorkletNode | undefined;
  let status: NoiseSuppressionState | undefined;
  let settle!: (success: boolean) => void;
  const ready = new Promise<boolean>(resolve => { settle = resolve; });
  let deadline: ReturnType<typeof setTimeout> | undefined;

  function report(state: NoiseSuppressionState) {
    if (destroyed || status === state) return;
    status = state;
    clean(() => options.onState?.(state));
  }
  function fade(parameter: AudioParam, value: number, immediate = false) {
    const now = context.currentTime;
    const previous = parameter.value;
    parameter.cancelScheduledValues(now);
    parameter.setValueAtTime(immediate ? value : previous, now);
    if (!immediate) {
      // Keep raw audio audible while two RNNoise/FIFO frames fill.
      parameter.setValueAtTime(previous, now + PRIME_SECONDS);
      parameter.linearRampToValueAtTime(value, now + PRIME_SECONDS + FADE_SECONDS);
    }
  }
  function releaseProcessor() {
    const previous = node;
    node = undefined;
    if (!previous) return;
    previous.onprocessorerror = null;
    previous.port.onmessage = null;
    previous.port.onmessageerror = null;
    clean(() => previous.port.postMessage({ type: "destroy" }));
    clean(() => previous.port.close());
    clean(() => input.disconnect(previous));
    clean(() => previous.disconnect());
  }
  function fail() {
    if (destroyed || failed) return;
    failed = true;
    clearTimeout(deadline);
    // A crashed worklet can remain silent forever: restore the dry route first.
    clean(() => fade(bypass.gain, 1, true));
    clean(() => fade(processed.gain, 0, true));
    releaseProcessor();
    settle(false);
    report("failed");
  }
  async function initialize() {
    try {
      if (context.sampleRate !== 48_000 || context.state === "closed"
        || !context.audioWorklet || typeof AudioWorkletNode === "undefined"
        || typeof WebAssembly === "undefined") {
        fail();
        return;
      }
      const [wasmModule] = await Promise.all([loadModel(), loadModule(context)]);
      if (destroyed || failed) return;
      node = new AudioWorkletNode(context, PROCESSOR_NAME, {
        numberOfInputs: 1, numberOfOutputs: 1,
        outputChannelCount: [options.channels],
        channelCount: options.channels,
        channelCountMode: "explicit",
        channelInterpretation: "discrete",
        processorOptions: { wasmModule, channels: options.channels, level },
      });
      node.onprocessorerror = fail;
      node.port.onmessageerror = fail;
      node.port.onmessage = event => {
        if (destroyed || failed) return;
        if (event.data?.type === "failed") { fail(); return; }
        if (event.data?.type !== "ready" || status === "active") return;
        try {
          fade(bypass.gain, 0);
          fade(processed.gain, 1);
          clearTimeout(deadline);
          settle(true);
          report("active");
        } catch { fail(); }
      };
      input.connect(node);
      node.connect(processed);
    } catch { fail(); }
  }
  report("loading");
  deadline = setTimeout(fail, LOAD_TIMEOUT_MS);
  void initialize();
  return {
    input, output, ready,
    setLevel(next) {
      if (destroyed || failed) return;
      level = normalizeLevel(next);
      try { node?.port.postMessage({ type: "level", level }); } catch { fail(); }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(deadline);
      settle(false);
      releaseProcessor();
      for (const resource of owned) clean(() => resource.disconnect());
    },
  };
}
