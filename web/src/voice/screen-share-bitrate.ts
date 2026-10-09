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
    initial: normalized.bitrateMode === "manual" ? normalized.bitrateMbps * 1_000_000 : Math.round(ceiling * (normalized.bitratePolicy === "quality" ? 0.8 : 0.65)),
    degradation: normalized.bitrateMode === "manual" || normalized.bitratePolicy === "quality" ? "maintain-resolution" as const
      : normalized.bitratePolicy === "smooth" ? "maintain-framerate" as const : "balanced" as const,
  };
}

export interface ScreenShareAdaptationState {
  target: number;
  lastSampleAt: number;
  lastChangeAt: number;
  goodSamples: number;
  badSamples: number;
  bandwidth: number | null;
  baselineRtt: number | null;
  reason: ScreenShareBitrateReason;
}
export function initialScreenShareAdaptation(target: number): ScreenShareAdaptationState {
  return { target, lastSampleAt: 0, lastChangeAt: 0, goodSamples: 0, badSamples: 0, bandwidth: null, baselineRtt: null, reason: "starting" };
}

/** Use interval feedback, fast congestion response and slower recovery. A static
 * screen's low bitrate/FPS is not evidence of a poor connection. */
export function adaptScreenShareBitrate(previous: ScreenShareAdaptationState, sample: ScreenShareNetworkSample, ceiling: number, policy: ScreenShareBitratePolicy): ScreenShareAdaptationState {
  if (sample.sampledAt <= previous.lastSampleAt || (previous.lastSampleAt && sample.sampledAt - previous.lastSampleAt < 750)) return previous;
  const next = { ...previous, lastSampleAt: sample.sampledAt };
  const estimate = sample.availableOutgoingBitrateKbps;
  if (estimate !== null && Number.isFinite(estimate) && estimate > 0) next.bandwidth = next.bandwidth === null ? estimate * 1000 : next.bandwidth * 0.65 + estimate * 350;
  const rtt = sample.roundTripTimeMs;
  if (rtt !== null && Number.isFinite(rtt) && rtt > 0) next.baselineRtt = next.baselineRtt === null ? rtt : Math.min(rtt, next.baselineRtt * 1.01);
  const loss = sample.intervalLossPercent;
  const lossLimit = policy === "quality" ? 6 : policy === "smooth" ? 2 : 3;
  const rttLimit = policy === "quality" ? 600 : policy === "smooth" ? 300 : 450;
  const delayPressure = rtt !== null && rtt > Math.max(rttLimit, (next.baselineRtt ?? rtt) * 1.8 + 100);
  const bandwidthPressure = next.bandwidth !== null && next.bandwidth < previous.target * 0.8 && (sample.bitrateKbps ?? 0) > 0;
  const emergency = (loss !== null && loss >= 12) || (rtt !== null && rtt >= Math.max(1200, (next.baselineRtt ?? rtt) * 3));
  const congested = emergency || (loss !== null && loss >= lossLimit) || delayPressure || bandwidthPressure;
  if (congested) {
    next.goodSamples = 0; next.badSamples++;
    if ((emergency || next.badSamples >= 2) && (!previous.lastChangeAt || sample.sampledAt - previous.lastChangeAt >= 2000)) {
      const fraction = policy === "quality" ? 0.82 : policy === "smooth" ? 0.65 : 0.75;
      next.target = Math.round(clamp(Math.min(previous.target * fraction, next.bandwidth === null ? Infinity : next.bandwidth * 0.85), 500_000, ceiling));
      next.lastChangeAt = sample.sampledAt; next.badSamples = 0; next.reason = "network";
    }
    return next;
  }
  next.badSamples = 0;
  if (sample.qualityLimitationReason === "cpu") { next.goodSamples = 0; next.reason = "cpu"; return next; }
  const feedback = loss !== null || (estimate !== null && estimate > 0);
  const headroom = next.bandwidth !== null ? next.bandwidth > previous.target * 1.2 : (sample.bitrateKbps ?? 0) * 1000 > previous.target * 0.8;
  next.goodSamples = feedback && headroom ? next.goodSamples + 1 : 0;
  const recoverySamples = policy === "quality" ? 3 : policy === "smooth" ? 6 : 4;
  if (next.goodSamples >= recoverySamples && (!previous.lastChangeAt || sample.sampledAt - previous.lastChangeAt >= 5000)) {
    next.target = Math.round(clamp(Math.min(previous.target * 1.18 + 100_000, next.bandwidth === null ? Infinity : next.bandwidth * 0.9), 500_000, ceiling));
    next.lastChangeAt = sample.sampledAt; next.goodSamples = 0;
    next.reason = next.target > previous.target ? "recovering" : "stable";
  }
  return next;
}

/** One serialized writer per sender. A queued old sample cannot overwrite a
 * manual change, a replacement peer, or a disposed session. */
export function createScreenShareEncoder(sender: RTCRtpSender, track: MediaStreamTrack, isCurrent: () => boolean) {
  let plan = screenShareEncodingPlan({}, track.getSettings());
  let adaptation = initialScreenShareAdaptation(plan.initial);
  let revision = 0, completedRevision = -1, disposed = false;
  let running: Promise<boolean> | null = null;
  let appliedBitrate: number | null = null, supported: boolean | null = null, strategySupported = true;
  async function pump(): Promise<boolean> {
    if (running) return running;
    const operation = (async () => {
      while (!disposed && isCurrent() && completedRevision !== revision) {
        const currentRevision = revision, currentPlan = plan, target = adaptation.target;
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
          if (success) appliedBitrate = target;
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
      adaptation = initialScreenShareAdaptation(plan.initial);
      if (plan.bitrateMode === "manual") adaptation.reason = "manual";
      revision++; return pump();
    },
    retry() { revision++; return pump(); },
    sample(sample: ScreenShareNetworkSample) {
      if (disposed || !isCurrent() || plan.bitrateMode !== "auto" || supported !== true) return;
      const next = adaptScreenShareBitrate(adaptation, sample, plan.ceiling, plan.bitratePolicy);
      const changed = next.target !== adaptation.target;
      adaptation = next;
      if (changed) { revision++; void pump(); }
    },
    snapshot() { return { targetBitrateKbps: appliedBitrate === null ? null : appliedBitrate / 1000, bitrateMode: plan.bitrateMode, bitratePolicy: plan.bitratePolicy, bitrateReason: adaptation.reason, bitrateControlSupported: supported, bitrateStrategySupported: strategySupported }; },
    dispose() { disposed = true; revision++; },
  };
}
