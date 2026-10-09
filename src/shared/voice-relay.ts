import { isScreenShareRelayId, parseScreenShareRelayCredentials, type ScreenShareRelayCredentials, type ScreenShareRelayId } from "./screen-share.js";
export type VoiceRelayRoute = "direct" | ScreenShareRelayId;
export type VoiceRelayMessage = { type: "voiceRelay"; id: string; action: "request" | "offer" | "answer" | "stop" | "error" | "select" | "selected";
  route?: VoiceRelayRoute; sdp?: string; relay?: ScreenShareRelayCredentials; rttMs?: number; baselineMs?: number; loss?: number };
export function isVoiceRelayMessage(raw: unknown): raw is VoiceRelayMessage {
  if (!raw || typeof raw !== "object") return false;
  const v = raw as Record<string, unknown>;
  if (v.type !== "voiceRelay" || typeof v.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(v.id)) return false;
  if (!["request", "offer", "answer", "stop", "error", "select", "selected"].includes(String(v.action))) return false;
  if (v.route !== undefined && v.route !== "direct" && !isScreenShareRelayId(v.route)) return false;
  if (v.action === "request" && v.route === undefined) return false;
  if (v.relay !== undefined && (v.action !== "offer" || !parseScreenShareRelayCredentials(v.relay))) return false;
  if ((v.action === "offer" || v.action === "answer") && (typeof v.sdp !== "string" || v.sdp.length < 10 || v.sdp.length > 65536)) return false;
  if (v.action === "select") return [v.rttMs, v.baselineMs, v.loss].every(x => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 60000) && Number(v.loss) <= 1;
  return true;
}
/** A stable existing connection wins ties. Loss is an interval probe estimate. */
export function preferVoiceRelay(rtt: number, baseline: number, loss: number): boolean {
  return loss <= 0.05 && rtt < 1200 && (rtt + 25 < baseline * 0.8 || baseline >= 1500);
}
