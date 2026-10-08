import { parseScreenShareSignal, type ScreenSharePeerSignal } from "./screen-share.js";

export const MAX_VOICE_PEERS = 5;
export interface VoicePeer { peerId: string; clientId: number }
export type PeerVoiceClientMessage =
  | { type: "peerVoiceJoin"; enabled: boolean }
  | { type: "peerVoiceReceiving"; peerIds: string[] }
  | { type: "peerVoiceSignal"; targetPeerId: string; connectionId: string; signal: ScreenSharePeerSignal };
export type PeerVoiceServerMessage =
  | { type: "peerVoiceRoster"; selfPeerId: string; peers: VoicePeer[]; limited: boolean }
  | { type: "peerVoiceSignal"; fromPeerId: string; connectionId: string; signal: ScreenSharePeerSignal };
const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export function parsePeerVoiceClientMessage(raw: string): PeerVoiceClientMessage | null {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  if (value.type === "peerVoiceJoin" && typeof value.enabled === "boolean") return { type: value.type, enabled: value.enabled };
  if (value.type === "peerVoiceReceiving" && Array.isArray(value.peerIds) && value.peerIds.length < MAX_VOICE_PEERS && value.peerIds.every(id)) {
    return { type: value.type, peerIds: [...new Set<string>(value.peerIds)] };
  }
  if (value.type === "peerVoiceSignal" && id(value.targetPeerId) && id(value.connectionId)) {
    const signal = parseScreenShareSignal(value.signal);
    if (signal) return { type: value.type, targetPeerId: value.targetPeerId, connectionId: value.connectionId, signal };
  }
  return null;
}
export function isPeerVoiceServerMessage(value: Record<string, unknown>): boolean {
  if (value.type === "peerVoiceSignal") return id(value.fromPeerId) && id(value.connectionId) && Boolean(parseScreenShareSignal(value.signal));
  if (value.type !== "peerVoiceRoster" || !(value.selfPeerId === "" || id(value.selfPeerId)) || typeof value.limited !== "boolean") return false;
  return Array.isArray(value.peers) && value.peers.length < MAX_VOICE_PEERS && value.peers.every(peer => peer
    && id(peer.peerId) && Number.isInteger(peer.clientId) && peer.clientId > 0 && peer.clientId <= 65535)
    && new Set(value.peers.map(peer => peer.peerId)).size === value.peers.length;
}
