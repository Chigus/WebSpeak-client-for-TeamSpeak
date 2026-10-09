import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { isScreenShareRelayId, type ScreenShareRelayId, type ScreenShareRelayCredentials } from "../shared/screen-share.js";

export interface ScreenShareRelayConfig {
  id: ScreenShareRelayId;
  urls: string[];
  secret: string;
}

/** A per-start lease covers long calls; the permanent REST secret never leaves the server. */
export const SCREEN_SHARE_RELAY_TTL_SECONDS = 24 * 60 * 60;
const TURN_URL = /^turns?:[a-z0-9.-]+:(\d{1,5})(?:\?transport=(?:udp|tcp))?$/i;
function validTurnUrl(url: unknown): boolean {
  if (typeof url !== "string" || url.length > 256) return false;
  const match = TURN_URL.exec(url);
  return Boolean(match && Number(match[1]) > 0 && Number(match[1]) <= 65535);
}

export function readScreenShareRelays(file = process.env.WEBSPEAK_SCREEN_SHARE_RELAYS_FILE): ScreenShareRelayConfig[] {
  if (!file?.trim()) return [];
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file.trim(), "utf8")); }
  catch { throw new Error("Cannot read screen-share relay configuration"); }
  if (!Array.isArray(raw) || raw.length > 2) throw new Error("Invalid screen-share relay configuration");
  const ids = new Set<string>();
  return raw.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Invalid screen-share relay entry");
    const r = item as Record<string, unknown>;
    if (!isScreenShareRelayId(r.id) || ids.has(r.id) || typeof r.secret !== "string" || r.secret.length < 32 || r.secret.length > 256
      || !Array.isArray(r.urls) || r.urls.length < 1 || r.urls.length > 4
      || !r.urls.every(validTurnUrl)) {
      throw new Error("Invalid screen-share relay entry");
    }
    ids.add(r.id);
    return { id: r.id, secret: r.secret, urls: [...r.urls] as string[] };
  });
}

export class ScreenShareRelays {
  constructor(private readonly config: readonly ScreenShareRelayConfig[] = [], private readonly now = Date.now) {}
  available(): ScreenShareRelayId[] { return this.config.map(relay => relay.id); }
  issue(id: ScreenShareRelayId): ScreenShareRelayCredentials | null {
    const relay = this.config.find(item => item.id === id);
    if (!relay) return null;
    const expiresAt = Math.floor(this.now() / 1000) + SCREEN_SHARE_RELAY_TTL_SECONDS;
    const username = `${expiresAt}:screen-${randomBytes(12).toString("hex")}`;
    const credential = createHmac("sha1", relay.secret).update(username).digest("base64");
    return { route: id, expiresAt: expiresAt * 1000, iceServers: [{ urls: [...relay.urls], username, credential }] };
  }
}
