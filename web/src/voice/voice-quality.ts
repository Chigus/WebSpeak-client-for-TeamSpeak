import { ref } from "vue";
import { DEFAULT_VOICE_QUALITY, isVoiceQualitySettings, type VoiceQualitySettings, type VoiceQualityStatus } from "../../../src/shared/voice-quality.js";
import { createOpusUplink } from "./opus-uplink.js";
import type { VoiceAudioStatusSample } from "./audio-diagnostics.js";

/** Session-owned feedback remains active when the settings/diagnostics UI is closed. */
export function createVoiceQuality(options: {
  socket(): WebSocket | null;
  send(type: "setVoiceQuality" | "voiceNetworkFeedback", payload: any): void;
  measure(): Promise<VoiceAudioStatusSample | null>;
  routeMetrics?(): { bufferedAmount: number; rttMs: number | null } | null;
  canSend(): boolean;
  sendAudio(packet: Uint8Array): void;
}) {
  const settings = ref<VoiceQualitySettings>({ ...DEFAULT_VOICE_QUALITY });
  const status = ref<VoiceQualityStatus | null>(null);
  let generation = 0, sequence = 0, available = false, compressed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous: VoiceAudioStatusSample | null = null;
  let touched = false;
  const encoder = createOpusUplink({
    canSend: options.canSend,
    send: options.sendAudio,
    onFailure() { compressed = false; publish(); },
  });
  function publish() {
    if (available) options.send("setVoiceQuality", { ...settings.value, compressedUplink: compressed });
  }
  async function feedback(owner: number) {
    const socket = options.socket();
    const started = performance.now();
    const sample = await options.measure().catch(() => null);
    if (owner !== generation || !available || socket !== options.socket()) return;
    const comparable = sample && previous && sample.scopeId === previous.scopeId;
    const frames = comparable ? Math.max(0, sample.fallbackPlayback.framesReceived - previous!.fallbackPlayback.framesReceived) : 0;
    const dropped = comparable ? Math.max(0, sample.fallbackPlayback.framesDropped - previous!.fallbackPlayback.framesDropped) : 0;
    const bitrate = compressed ? status.value?.uplinkKbps ?? 48 : 768;
    const route = options.routeMetrics?.();
    options.send("voiceNetworkFeedback", { sequence: ++sequence,
      rttMs: route ? route.rttMs : sample ? Math.min(60000, performance.now() - started) : null,
      uplinkBufferedMs: Math.min(60000, (route?.bufferedAmount ?? socket?.bufferedAmount ?? 0) * 8 / bitrate),
      playbackFrames: Math.min(100000, frames), playbackDropPercent: frames ? Math.min(100, dropped / frames * 100) : 0 });
    previous = sample;
    timer = setTimeout(() => void feedback(owner), 2000);
  }
  function stop() {
    generation++; available = false; compressed = false; status.value = null; previous = null;
    clearTimeout(timer); encoder.close();
  }
  return {
    settings, status,
    restore(value: unknown) { if (!touched && isVoiceQualitySettings(value)) settings.value = { ...value }; },
    set(value: VoiceQualitySettings) {
      if (!isVoiceQualitySettings(value)) return;
      touched = true; settings.value = { ...value }; publish();
    },
    async start(enabled: boolean) {
      stop(); available = enabled;
      if (!enabled) return;
      const owner = generation;
      const supported = await encoder.prepare(48);
      if (owner !== generation) return;
      compressed = supported;
      publish(); timer = setTimeout(() => void feedback(owner), 2000);
    },
    receive(value: VoiceQualityStatus) {
      if (!available) return;
      status.value = value;
      encoder.setBitrate(value.uplinkKbps);
    },
    push(frame: Int16Array): boolean {
      return compressed && status.value?.compressedUplink === true && encoder.push(frame);
    },
    invalidate: encoder.invalidate,
    stop,
  };
}
