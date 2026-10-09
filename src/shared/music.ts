export type MusicSource = "netease" | "qqmusic" | "bilibili";
export type MusicAction = "status" | "search" | "playlist" | "enqueue" | "control" | "remove" | "queuePlay" | "volume" | "shuffle" | "repeat";
export interface MusicTrack {
  source: MusicSource; id: string; title: string; artist: string; album: string;
  duration: number; artwork: string; queueId?: number; albumMid?: string;
}
export interface MusicStatus {
  state: string; title: string; artist: string; artwork: string; elapsed: number; duration: number;
  volume: number; shuffled: boolean; repeat: "none" | "all" | "one";
}
export interface MusicResult {
  enabled: boolean; inChannel: boolean; botName: string; botChannelId?: string;
  status?: MusicStatus; items?: MusicTrack[]; name?: string; total?: number; hasMore?: boolean;
  queued?: boolean; trial?: boolean; playlistId?: string;
}
export interface MusicRequest {
  type: "musicRequest"; requestId: string; channelId: string; action: MusicAction;
  payload: { source?: MusicSource; keywords?: string; id?: string; link?: string; playNow?: boolean; control?: string;
    queueId?: number; volume?: number; enabled?: boolean; mode?: "none" | "all" | "one"; page?: number };
}
export type MusicResponse = { type: "musicResult"; requestId: string; channelId: string; result?: MusicResult; code?: string };
export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const isMusicSource = (v: unknown): v is MusicSource => v === "netease" || v === "qqmusic" || v === "bilibili";
export function validNetEaseShareLink(value: unknown): value is string {
  return typeof value === "string" && /^https:\/\/163cn\.tv\/[A-Za-z0-9]{1,64}$/.test(value);
}
export function validMusicId(source: MusicSource, id: unknown): id is string {
  return typeof id === "string" && (source === "netease" ? /^\d{1,20}$/ : source === "qqmusic" ? /^[A-Za-z0-9]{1,40}$/ : /^(BV[A-Za-z0-9]{10}|av\d{1,20})$/).test(id);
}
export function parseMusicRequest(value: unknown): MusicRequest | null {
  if (!isRecord(value) || value.type !== "musicRequest" || typeof value.requestId !== "string" || !/^[\w-]{1,64}$/.test(value.requestId)
    || typeof value.channelId !== "string" || !/^\d{1,20}$/.test(value.channelId) || !isRecord(value.payload)) return null;
  const p = value.payload, source = p.source;
  switch (value.action) {
    case "status": break;
    case "search":
      if (!isMusicSource(source) || typeof p.keywords !== "string" || !p.keywords.trim() || p.keywords.length > 120
        || (p.page !== undefined && (!Number.isInteger(p.page) || Number(p.page) < 1 || Number(p.page) > 100))) return null;
      break;
    case "playlist":
      if ((source !== "netease" && source !== "qqmusic") || !(typeof p.id === "string" && /^\d{1,20}$/.test(p.id) && p.link === undefined
        || source === "netease" && p.id === undefined && validNetEaseShareLink(p.link))) return null;
      if (p.page !== undefined && (!Number.isInteger(p.page) || Number(p.page) < 1 || Number(p.page) > 100)) return null;
      break;
    case "enqueue":
      if (!isMusicSource(source) || !validMusicId(source, p.id) || (p.playNow !== undefined && typeof p.playNow !== "boolean")) return null;
      break;
    case "control": if (!["play", "pause", "next", "previous"].includes(String(p.control))) return null; break;
    case "remove": case "queuePlay": if (!Number.isSafeInteger(p.queueId) || Number(p.queueId) < 1) return null; break;
    case "volume": if (!Number.isInteger(p.volume) || Number(p.volume) < 0 || Number(p.volume) > 100) return null; break;
    case "shuffle": if (typeof p.enabled !== "boolean") return null; break;
    case "repeat": if (!["none", "all", "one"].includes(String(p.mode))) return null; break;
    default: return null;
  }
  return value as unknown as MusicRequest;
}
export function isMusicResponse(value: unknown): value is MusicResponse {
  if (!isRecord(value) || value.type !== "musicResult" || typeof value.requestId !== "string" || value.requestId.length > 64
    || typeof value.channelId !== "string" || !/^\d{1,20}$/.test(value.channelId)) return false;
  if (value.code !== undefined) return typeof value.code === "string" && /^[A-Z_]{1,60}$/.test(value.code);
  const r = value.result;
  if (!isRecord(r) || typeof r.enabled !== "boolean" || typeof r.inChannel !== "boolean" || typeof r.botName !== "string") return false;
  if (r.botChannelId !== undefined && (typeof r.botChannelId !== "string" || !/^\d{1,20}$/.test(r.botChannelId))) return false;
  if (["hasMore", "queued", "trial"].some(k => r[k] !== undefined && typeof r[k] !== "boolean")) return false;
  if (r.total !== undefined && (typeof r.total !== "number" || !Number.isFinite(r.total) || r.total < 0)) return false;
  if (r.name !== undefined && typeof r.name !== "string") return false;
  if (r.playlistId !== undefined && (typeof r.playlistId !== "string" || !/^\d{1,20}$/.test(r.playlistId))) return false;
  if (r.items !== undefined && (!Array.isArray(r.items) || r.items.length > 200 || !r.items.every(item =>
    isRecord(item) && isMusicSource(item.source) && validMusicId(item.source, item.id)
    && ["title", "artist", "album", "artwork"].every(key => typeof item[key] === "string")
    && typeof item.duration === "number" && Number.isFinite(item.duration) && item.duration >= 0
    && (item.queueId === undefined || (Number.isSafeInteger(item.queueId) && Number(item.queueId) > 0))))) return false;
  const s = r.status;
  return s === undefined || (isRecord(s) && ["state", "title", "artist", "artwork"].every(key => typeof s[key] === "string")
    && ["elapsed", "duration", "volume"].every(key => typeof s[key] === "number" && Number.isFinite(s[key]))
    && typeof s.shuffled === "boolean" && ["none", "all", "one"].includes(String(s.repeat)));
}
