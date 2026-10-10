export type ScreenShareBitrateMode = "auto" | "manual";
export type ScreenShareBitratePolicy = "quality" | "smooth" | "balanced";
export interface ScreenShareBitrateSettings {
  bitrateMode?: ScreenShareBitrateMode;
  bitrateMbps?: number;
  bitratePolicy?: ScreenShareBitratePolicy;
}
export interface ScreenShareEncoderSettings extends ScreenShareBitrateSettings {
  maxWidth?: number;
  maxHeight?: number;
  maxFrameRate?: number;
}
export interface ScreenShareNetworkSample {
  sampledAt: number;
  bitrateKbps: number | null;
  intervalLossPercent: number | null;
  roundTripTimeMs: number | null;
  availableOutgoingBitrateKbps: number | null;
  qualityLimitationReason: string | null;
}
export type ScreenShareBitrateReason = "manual" | "starting" | "network" | "recovering" | "cpu" | "stable";
export const SCREEN_SHARE_BITRATE_OPTIONS = [1, 2, 4, 6, 8, 12, 16, 20] as const;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export function normalizeScreenShareBitrate(settings: ScreenShareBitrateSettings = {}) {
  return {
    bitrateMode: settings.bitrateMode === "manual" ? "manual" as const : "auto" as const,
    bitrateMbps: Number.isFinite(settings.bitrateMbps) ? clamp(settings.bitrateMbps!, 1, 20) : 12,
    bitratePolicy: (["quality", "smooth", "balanced"] as const).includes(settings.bitratePolicy!) ? settings.bitratePolicy! : "balanced" as const,
  };
}

export function screenShareEncodingPlan(settings: ScreenShareEncoderSettings, capture: MediaTrackSettings) {
  const normalized = normalizeScreenShareBitrate(settings);
  const width = capture.width && capture.width > 0 ? capture.width : settings.maxWidth ?? 1920;
  const height = capture.height && capture.height > 0 ? capture.height : settings.maxHeight ?? 1080;
  const scale = Math.max(1, settings.maxWidth ? width / settings.maxWidth : 1, settings.maxHeight ? height / settings.maxHeight : 1);
  const fps = Math.max(1, Math.min(settings.maxFrameRate ?? capture.frameRate ?? 30, capture.frameRate || settings.maxFrameRate || 30));
  const factor = normalized.bitratePolicy === "quality" ? 1.3 : normalized.bitratePolicy === "smooth" ? 0.75 : 1;
  const ceiling = Math.round(clamp(8_000_000 * (width * height / scale ** 2 / (1920 * 1080)) * (Math.max(15, fps) / 30) * factor, 2_000_000, 20_000_000));
  return {
    ...normalized, scale, fps, ceiling,
    initial: normalized.bitrateMode === "manual" ? normalized.bitrateMbps * 1_000_000 : ceiling,
    degradation: normalized.bitrateMode === "manual" || normalized.bitratePolicy === "quality" ? "maintain-resolution" as const
      : normalized.bitratePolicy === "smooth" ? "maintain-framerate" as const : "balanced" as const,
  };
}

/** One serialized writer per sender. A queued old sample cannot overwrite a
 * manual change, a replacement peer, or a disposed session. */
export function createScreenShareEncoder(sender: RTCRtpSender, track: MediaStreamTrack, isCurrent: () => boolean) {
  let plan = screenShareEncodingPlan({}, track.getSettings());
  let reason: ScreenShareBitrateReason = "starting";
  let revision = 0, completedRevision = -1, disposed = false;
  let running: Promise<boolean> | null = null;
  let appliedBitrate: number | null = null, supported: boolean | null = null, strategySupported = true;
  async function pump(): Promise<boolean> {
    if (running) return running;
    const operation = (async () => {
      while (!disposed && isCurrent() && completedRevision !== revision) {
        const currentRevision = revision, currentPlan = plan, target = currentPlan.initial;
        let success = false;
        try {
          const parameters = sender.getParameters();
          parameters.encodings = [{ ...(parameters.encodings?.[0] ?? {}), maxBitrate: target, maxFramerate: currentPlan.fps, scaleResolutionDownBy: currentPlan.scale }, ...(parameters.encodings?.slice(1) ?? [])];
          parameters.degradationPreference = currentPlan.degradation;
          await sender.setParameters(parameters);
          success = true; strategySupported = true;
        } catch {
          // A browser may support bitrate but not degradationPreference.
          if (!disposed && isCurrent() && currentRevision === revision) try {
            const parameters = sender.getParameters();
            parameters.encodings = [{ ...(parameters.encodings?.[0] ?? {}), maxBitrate: target, maxFramerate: currentPlan.fps, scaleResolutionDownBy: currentPlan.scale }, ...(parameters.encodings?.slice(1) ?? [])];
            delete parameters.degradationPreference;
            await sender.setParameters(parameters);
            success = true; strategySupported = false;
          } catch { /* Keep capture alive and expose unsupported control. */ }
        }
        if (disposed || !isCurrent()) return false;
        completedRevision = currentRevision;
        if (currentRevision === revision) {
          supported = success;
          if (success) {
            try {
              appliedBitrate = sender.getParameters().encodings[0]?.maxBitrate ?? null;
              supported = appliedBitrate === target;
            } catch { supported = false; }
          }
        }
      }
      return supported === true;
    })();
    running = operation;
    try { return await operation; } finally { if (running === operation) running = null; }
  }
  return {
    configure(settings: ScreenShareEncoderSettings) {
      plan = screenShareEncodingPlan(settings, track.getSettings());
      reason = plan.bitrateMode === "manual" ? "manual" : "stable";
      revision++; return pump();
    },
    retry() { revision++; return pump(); },
    sample(sample: ScreenShareNetworkSample) {
      if (disposed || !isCurrent() || plan.bitrateMode !== "auto" || supported !== true) return;
      // Piik delegates congestion and recovery to WebRTC. Observations must
      // never ratchet the configured ceiling down and suppress native recovery.
      reason = sample.qualityLimitationReason === "cpu" ? "cpu"
        : sample.qualityLimitationReason === "bandwidth" ? "network" : "stable";
    },
    snapshot() { return { targetBitrateKbps: appliedBitrate === null ? null : appliedBitrate / 1000, bitrateMode: plan.bitrateMode, bitratePolicy: plan.bitratePolicy, bitrateReason: reason, bitrateControlSupported: supported, bitrateStrategySupported: strategySupported }; },
    dispose() { disposed = true; revision++; },
  };
}
