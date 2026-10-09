/** Per-browser transport preferences; never change the TeamSpeak channel codec. */
export const VOICE_BITRATES = [16, 24, 32, 48, 64, 96, 128, 192] as const;
export type VoiceQualityPolicy = "balanced" | "quality" | "smooth";
export interface VoiceQualitySettings {
  mode: "auto" | "manual";
  bitrateKbps: number;
  policy: VoiceQualityPolicy;
}
export interface VoiceNetworkFeedback {
  sequence: number;
  rttMs: number | null;
  uplinkBufferedMs: number;
  playbackDropPercent: number;
  playbackFrames: number;
}
export interface VoiceQualityStatus extends VoiceQualitySettings {
  uplinkKbps: number;
  downlinkKbps: number;
  reason: "starting" | "stable" | "network" | "recovering" | "manual";
  compressedUplink: boolean;
  sequence?: number;
}
export const DEFAULT_VOICE_QUALITY: VoiceQualitySettings = { mode: "auto", bitrateKbps: 48, policy: "balanced" };
const record = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const bounded = (v: unknown, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;
export function isVoiceQualitySettings(v: unknown): v is VoiceQualitySettings {
  return record(v) && (v.mode === "auto" || v.mode === "manual")
    && VOICE_BITRATES.includes(v.bitrateKbps as typeof VOICE_BITRATES[number])
    && (v.policy === "balanced" || v.policy === "quality" || v.policy === "smooth");
}
export function isVoiceNetworkFeedback(v: unknown): v is VoiceNetworkFeedback {
  return record(v) && bounded(v.sequence, 0x7fffffff) && Number.isInteger(v.sequence)
    && (v.rttMs === null || bounded(v.rttMs, 60_000)) && bounded(v.uplinkBufferedMs, 60_000)
    && bounded(v.playbackDropPercent, 100) && bounded(v.playbackFrames, 100_000) && Number.isInteger(v.playbackFrames);
}
export function isVoiceQualityStatus(v: unknown): v is VoiceQualityStatus {
  return isVoiceQualitySettings(v) && record(v) && bounded(v.uplinkKbps, 192) && v.uplinkKbps >= 16
    && bounded(v.downlinkKbps, 192) && v.downlinkKbps >= 16 && typeof v.compressedUplink === "boolean"
    && ["starting", "stable", "network", "recovering", "manual"].includes(String(v.reason))
    && (v.sequence === undefined || (bounded(v.sequence, 0x7fffffff) && Number.isInteger(v.sequence)));
}
export interface VoiceAdaptation {
  uplink: number; downlink: number; baselineRtt: number | null;
  bad: number; good: number; sampledAt: number; changedAt: number;
  reason: VoiceQualityStatus["reason"];
}
export function initialVoiceAdaptation(settings: VoiceQualitySettings): VoiceAdaptation {
  const manual = settings.mode === "manual";
  return { uplink: manual ? settings.bitrateKbps : settings.policy === "smooth" ? 32 : settings.policy === "quality" ? 64 : 48,
    downlink: manual ? settings.bitrateKbps : settings.policy === "smooth" ? 48 : settings.policy === "quality" ? 128 : 96,
    baselineRtt: null, bad: 0, good: 0, sampledAt: 0, changedAt: 0, reason: manual ? "manual" : "starting" };
}
/** Server owns the decision; client reports its own TCP queue and playback.
 * No packet-loss claim is made for WSS: retransmission hides network loss. */
export function adaptVoiceQuality(previous: VoiceAdaptation, settings: VoiceQualitySettings, feedback: VoiceNetworkFeedback, now: number, downlinkBufferedMs: number): VoiceAdaptation {
  if (settings.mode === "manual" || (previous.sampledAt && now - previous.sampledAt < 750)) return previous;
  const next = { ...previous, sampledAt: now };
  if (feedback.rttMs !== null) next.baselineRtt = next.baselineRtt === null ? feedback.rttMs : Math.min(feedback.rttMs, next.baselineRtt * 1.01);
  const limit = settings.policy === "smooth" ? 250 : settings.policy === "quality" ? 600 : 400;
  const highRtt = feedback.rttMs !== null && feedback.rttMs > Math.max(limit, (next.baselineRtt ?? 0) * 1.8 + 100);
  const queue = Math.max(feedback.uplinkBufferedMs, downlinkBufferedMs);
  const playbackPressure = feedback.playbackFrames >= 10 && feedback.playbackDropPercent >= 5;
  const bad = queue > 100 || highRtt || playbackPressure;
  const severe = queue > 350 || (feedback.rttMs !== null && feedback.rttMs > 1800) || (feedback.playbackFrames >= 10 && feedback.playbackDropPercent >= 15);
  if (bad) {
    next.good = 0; next.bad++;
    if ((severe || next.bad >= 2) && (!previous.changedAt || now - previous.changedAt >= 4000)) {
      const ratio = settings.policy === "quality" ? 0.8 : 0.65;
      next.uplink = Math.max(16, Math.floor(previous.uplink * ratio));
      next.downlink = Math.max(16, Math.floor(previous.downlink * ratio));
      next.bad = 0; next.changedAt = now; next.reason = "network";
    }
  } else {
    next.bad = 0;
    // Silence alone supplies no evidence for increasing media bandwidth.
    next.good = feedback.rttMs !== null && feedback.playbackFrames >= 10 ? next.good + 1 : 0;
    if (next.good >= (settings.policy === "smooth" ? 10 : 6) && (!previous.changedAt || now - previous.changedAt >= 15_000)) {
      next.uplink = Math.min(settings.policy === "smooth" ? 48 : 64, Math.ceil(previous.uplink * 1.2));
      next.downlink = Math.min(192, Math.ceil(previous.downlink * 1.2));
      next.changedAt = now; next.good = 0;
      next.reason = next.uplink > previous.uplink || next.downlink > previous.downlink ? "recovering" : "stable";
    } else if (next.good >= 2 && previous.reason === "starting") next.reason = "stable";
  }
  return next;
}

// A short envelope cannot collide with the existing 1920/3840-byte PCM frames.
export const VOICE_OPUS_HEADER = [0x57, 0x53, 0x56, 1, 4] as const;
export function validVoiceOpusPacket(bytes: Uint8Array): boolean {
  if (bytes.length < 6 || bytes.length > 489 || !VOICE_OPUS_HEADER.every((v, i) => bytes[i] === v)) return false;
  const toc = bytes[5]!, config = toc >> 3, code = toc & 3;
  if (toc & 4) return false; // Compressed uplink is mono; stereo raw keeps its original path.
  const frameMs = config >= 16 ? 2.5 * 2 ** (config & 3) : config >= 12 ? 10 * 2 ** (config & 1) : [10, 20, 40, 60][config & 3]!;
  const count = code === 0 ? 1 : code === 3 ? ((bytes[6] ?? 0) & 63) : 2;
  return count > 0 && frameMs * count === 20;
}
