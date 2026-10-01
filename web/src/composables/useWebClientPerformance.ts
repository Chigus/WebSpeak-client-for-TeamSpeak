import { computed, onUnmounted, ref, watch, type Ref } from "vue";
import type { VoiceAudioStatusSample } from "../voice/audio-diagnostics.js";

const SAMPLE_INTERVAL_MS = 2_000;

export type VoiceAudioHealth = "disconnected" | "sampling" | "connecting" | "warning" | "active" | "quiet";

function counterDelta(current: number, previous: number | undefined): number | null {
  if (previous === undefined || current < previous) return null;
  return current - previous;
}

function ratePerSecond(current: number, previous: number | undefined, elapsedMs: number): number | null {
  const delta = counterDelta(current, previous);
  if (delta === null || elapsedMs < 250) return null;
  return Math.round((delta * 1_000) / elapsedMs);
}

function bitrateKbps(current: number | null, previous: number | null | undefined, elapsedMs: number): number | null {
  if (current === null || previous == null || current < previous || elapsedMs < 250) return null;
  return Math.round(((current - previous) * 8) / elapsedMs);
}

function intervalLossPercent(
  currentReceived: number | null | undefined,
  previousReceived: number | null | undefined,
  currentLost: number | null | undefined,
  previousLost: number | null | undefined,
  fallback: number | null,
  packetsIncludeLost = false,
): number | null {
  if (currentReceived == null || previousReceived == null || currentLost == null || previousLost == null) return fallback;
  const receivedDelta = counterDelta(currentReceived, previousReceived);
  const lostDelta = counterDelta(Math.max(0, currentLost), Math.max(0, previousLost));
  if (receivedDelta === null || lostDelta === null) return fallback;
  const total = receivedDelta + (packetsIncludeLost ? 0 : lostDelta);
  return total > 0 ? Math.min(100, (lostDelta / total) * 100) : fallback;
}

function downlinkCounter(sample: VoiceAudioStatusSample | null) {
  if (!sample) return null;
  if (sample.transport === "websocket") return { source: "pcm", value: sample.fallbackPlayback.framesReceived };
  if (sample.transport === "webrtc" && sample.browser?.inboundPackets != null) return { source: "rtp", value: sample.browser.inboundPackets };
  return { source: "bridge", value: sample.bridge.egressFrames };
}

export function useWebClientPerformance(
  connected: Readonly<Ref<boolean>>,
  measureAudioStatus: () => Promise<VoiceAudioStatusSample | null>,
) {
  const panelOpen = ref(false);
  const running = ref(false);
  const latestSample = ref<VoiceAudioStatusSample | null>(null);
  const previousSample = ref<VoiceAudioStatusSample | null>(null);
  let timer: number | null = null;
  let generation = 0;
  let disposed = false;

  const stats = computed(() => {
    const current = latestSample.value;
    const prior = previousSample.value;
    const previous = current && prior && current.scopeId === prior.scopeId && current.transport === prior.transport ? prior : null;
    const elapsedMs = current && previous ? current.sampledAt - previous.sampledAt : 0;
    const bridge = current?.bridge;
    const previousBridge = previous?.bridge;
    const browser = current?.browser;
    const previousBrowser = previous?.browser;
    const uplinkFramesPerSecond = bridge
      ? ratePerSecond(bridge.tsSendFrames, previousBridge?.tsSendFrames, elapsedMs)
      : null;
    const downlink = downlinkCounter(current);
    const priorDownlink = downlinkCounter(previous);
    const downlinkFramesPerSecond = downlink && priorDownlink && downlink.source === priorDownlink.source
      ? ratePerSecond(downlink.value, priorDownlink.value, elapsedMs) : null;
    const uplinkLossPercent = browser
      ? intervalLossPercent(browser.outboundPackets, previousBrowser?.outboundPackets, browser.outboundPacketsLost, previousBrowser?.outboundPacketsLost, browser.outboundLossPercent, true)
      : null;
    const downlinkLossPercent = browser
      ? intervalLossPercent(browser.inboundPackets, previousBrowser?.inboundPackets, browser.inboundPacketsLost, previousBrowser?.inboundPacketsLost, browser.inboundLossPercent)
      : null;
    const recentErrors = bridge && previousBridge
      ? (counterDelta(bridge.tsSendErrors, previousBridge.tsSendErrors) ?? 0)
        + (counterDelta(bridge.ingressDroppedFrames, previousBridge.ingressDroppedFrames) ?? 0)
        + (counterDelta(bridge.egressDroppedFrames, previousBridge.egressDroppedFrames) ?? 0)
        + (counterDelta(bridge.webrtcIngressDecodeErrors, previousBridge.webrtcIngressDecodeErrors) ?? 0)
        + (counterDelta(bridge.webrtcDownlinkDecodeErrors, previousBridge.webrtcDownlinkDecodeErrors) ?? 0)
        + (counterDelta(bridge.webrtcQueueDroppedFrames, previousBridge.webrtcQueueDroppedFrames) ?? 0)
        + (counterDelta(current?.fallbackPlayback.decodeErrors ?? 0, previous?.fallbackPlayback.decodeErrors ?? 0) ?? 0)
      : 0;
    const uplinkBitrateKbps = browser ? bitrateKbps(browser.outboundBytes, previousBrowser?.outboundBytes, elapsedMs) : null;
    const downlinkBitrateKbps = browser ? bitrateKbps(browser.inboundBytes, previousBrowser?.inboundBytes, elapsedMs) : null;
    const mediaIsActive = (uplinkFramesPerSecond ?? 0) > 0
      || (downlinkFramesPerSecond ?? 0) > 0
      || (uplinkBitrateKbps ?? 0) > 0
      || (downlinkBitrateKbps ?? 0) > 0;
    const playbackBlocked = (downlinkFramesPerSecond ?? 0) > 0
      && (current?.playbackState === "paused" || current?.playbackState === "unavailable");
    let health: VoiceAudioHealth = "sampling";
    if (!connected.value) health = "disconnected";
    else if (current) {
      if (current.connectionState === "failed" || recentErrors > 0 || playbackBlocked || (!current.microphoneMuted && (current.microphonePermission === "denied" || (current.microphonePermission === "granted" && !current.microphoneReady)))) health = "warning";
      else if (current.transport === "negotiating" || (current.transport === "webrtc" && current.connectionState && current.connectionState !== "connected")) health = "connecting";
      else health = mediaIsActive ? "active" : "quiet";
    }

    return {
      ready: current !== null,
      health,
      transport: current?.transport ?? "disconnected",
      connectionState: current?.connectionState ?? null,
      microphoneMuted: current?.microphoneMuted ?? false,
      microphoneReady: current?.microphoneReady ?? false,
      microphonePermission: current?.microphonePermission ?? "unknown",
      playbackState: current?.playbackState ?? null,
      uplinkFramesPerSecond,
      downlinkFramesPerSecond,
      uplinkBitrateKbps,
      downlinkBitrateKbps,
      uplinkLossPercent,
      uplinkRttMs: browser?.outboundRttMs ?? null,
      downlinkLossPercent,
      downlinkJitterMs: browser?.inboundJitterMs ?? null,
      concealedSamples: browser?.concealedSamples ?? null,
      sendErrors: bridge && previousBridge ? counterDelta(bridge.tsSendErrors, previousBridge.tsSendErrors) : null,
      droppedFrames: bridge && previousBridge
        ? (counterDelta(bridge.ingressDroppedFrames, previousBridge.ingressDroppedFrames) ?? 0)
          + (counterDelta(bridge.egressDroppedFrames, previousBridge.egressDroppedFrames) ?? 0)
          + (counterDelta(bridge.webrtcQueueDroppedFrames, previousBridge.webrtcQueueDroppedFrames) ?? 0)
          + (counterDelta(current?.fallbackPlayback.framesDropped ?? 0, previous?.fallbackPlayback.framesDropped ?? 0) ?? 0)
        : null,
      queueUnderruns: bridge && previousBridge ? counterDelta(bridge.webrtcQueueUnderrunTicks, previousBridge.webrtcQueueUnderrunTicks) : null,
      ingressMaxGapMs: bridge?.ingressMaxGapMs ?? null,
      egressMaxGapMs: bridge?.egressMaxGapMs ?? null,
    };
  });

  async function runProbe(expectedGeneration = generation): Promise<void> {
    if (disposed || expectedGeneration !== generation || running.value || !connected.value) return;
    running.value = true;
    try {
      const sample = await measureAudioStatus();
      if (expectedGeneration !== generation || !connected.value) return;
      previousSample.value = sample ? latestSample.value : null;
      latestSample.value = sample;
    } catch {
      if (expectedGeneration === generation) {
        latestSample.value = null;
        previousSample.value = null;
      }
    } finally {
      if (expectedGeneration === generation) running.value = false;
    }
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    generation += 1;
    running.value = false;
    latestSample.value = null;
    previousSample.value = null;
  }

  function start(): void {
    if (timer !== null || !connected.value) return;
    const activeGeneration = ++generation;
    void runProbe(activeGeneration);
    timer = window.setInterval(() => { void runProbe(activeGeneration); }, SAMPLE_INTERVAL_MS);
  }

  function refresh(): void {
    void runProbe();
  }

  function togglePanel(): void {
    panelOpen.value = !panelOpen.value;
  }

  watch(connected, (isConnected) => {
    if (isConnected) start();
    else stop();
  }, { immediate: true });

  onUnmounted(() => { disposed = true; stop(); });

  return { panelOpen, running, stats, togglePanel, refresh };
}
