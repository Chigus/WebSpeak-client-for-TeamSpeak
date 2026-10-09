import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { MAX_SCREEN_SHARE_ICE_SERVERS, SCREEN_SHARE_RELAY_IDS, isScreenShareRelayId, type ScreenShareRelayId, type ScreenShareRelayCredentials } from "../shared/screen-share.js";

export interface ScreenShareRelayConfig {
  id: ScreenShareRelayId;
  urls: string[];
  /** Gateway-side route to the same TURN server/REST secret; never sent to browsers. */
  serverUrls?: string[];
  secret: string;
  provider?: "cloudflare";
  keyId?: string;
  apiToken?: string;
}

/** A per-start lease covers long calls; the permanent REST secret never leaves the server. */
export const SCREEN_SHARE_RELAY_TTL_SECONDS = 24 * 60 * 60;
const TURN_URL = /^turns?:[a-z0-9.-]+:(\d{1,5})(?:\?transport=(?:udp|tcp))?$/i;
function validTurnUrl(url: unknown): boolean {
  if (typeof url !== "string" || url.length > 256) return false;
  const match = TURN_URL.exec(url);
  return Boolean(match && Number(match[1]) > 0 && Number(match[1]) <= 65535);
}
function validTurnUrls(urls: unknown): urls is string[] {
  return Array.isArray(urls) && urls.length >= 1 && urls.length <= 4 && urls.every(validTurnUrl);
}

export function readScreenShareRelays(file = process.env.WEBSPEAK_SCREEN_SHARE_RELAYS_FILE): ScreenShareRelayConfig[] {
  const cloudflareFile = process.env.WEBSPEAK_CLOUDFLARE_TURN_FILE;
  if (!file?.trim() && !cloudflareFile) return [];
  let raw: unknown;
  try {
    raw = file?.trim() ? JSON.parse(readFileSync(file.trim(), "utf8")) : [];
    if (cloudflareFile && Array.isArray(raw)) raw.push(JSON.parse(readFileSync(cloudflareFile, "utf8")));
  }
  catch { throw new Error("Cannot read screen-share relay configuration"); }
  if (!Array.isArray(raw) || raw.length > SCREEN_SHARE_RELAY_IDS.length) throw new Error("Invalid screen-share relay configuration");
  const ids = new Set<string>();
  return raw.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Invalid screen-share relay entry");
    const r = item as Record<string, unknown>;
    if (r.serverUrls !== undefined && (r.provider !== undefined || !validTurnUrls(r.serverUrls))) {
      throw new Error("Invalid screen-share relay entry");
    }
    if (r.id === "cloudflare" && r.provider === "cloudflare" && !ids.has(r.id)
      && typeof r.keyId === "string" && /^[a-zA-Z0-9_-]{20,100}$/.test(r.keyId)
      && typeof r.apiToken === "string" && /^[a-zA-Z0-9_-]{20,200}$/.test(r.apiToken)) {
      ids.add(r.id);
      return { id: r.id, provider: "cloudflare", keyId: r.keyId, apiToken: r.apiToken, urls: [], secret: "" };
    }
    if (!isScreenShareRelayId(r.id) || ids.has(r.id) || typeof r.secret !== "string" || r.secret.length < 32 || r.secret.length > 256
      || !validTurnUrls(r.urls)) {
      throw new Error("Invalid screen-share relay entry");
    }
    ids.add(r.id);
    return { id: r.id, secret: r.secret, urls: [...r.urls],
      ...(r.serverUrls !== undefined ? { serverUrls: [...r.serverUrls as string[]] } : {}) };
  });
}

export class ScreenShareRelays {
  constructor(private readonly config: readonly ScreenShareRelayConfig[] = [], private readonly now = Date.now) {}
  available(): ScreenShareRelayId[] { return this.config.map(relay => relay.id); }
  issue(id: ScreenShareRelayId): ScreenShareRelayCredentials | null {
    const relay = this.config.find(item => item.id === id);
    if (!relay || relay.provider === "cloudflare") return null;
    const expiresAt = Math.floor(this.now() / 1000) + SCREEN_SHARE_RELAY_TTL_SECONDS;
    const username = `${expiresAt}:screen-${randomBytes(12).toString("hex")}`;
    const credential = createHmac("sha1", relay.secret).update(username).digest("base64");
    return { route: id, expiresAt: expiresAt * 1000, iceServers: [{ urls: [...relay.urls], username, credential }] };
  }

  /** The browser and gateway may enter the same coturn through different proxies. */
  gatewayIceServers(lease: ScreenShareRelayCredentials): ScreenShareRelayCredentials["iceServers"] {
    const relay = this.config.find(item => item.id === lease.route);
    const override = relay?.provider === undefined ? relay?.serverUrls : undefined;
    return lease.iceServers.map(server => ({ ...server,
      urls: override ? [...override] : Array.isArray(server.urls) ? [...server.urls] : server.urls }));
  }

  async issueAsync(id: ScreenShareRelayId | "auto"): Promise<ScreenShareRelayCredentials | null> {
    if (id === "auto") {
      const issued = await Promise.allSettled(this.available().map(route => this.issueAsync(route)));
      const leases = issued.flatMap(result => result.status === "fulfilled" && result.value ? [result.value] : []);
      // Offer one credential group per relay before additional transport groups.
      // A provider with many URLs must not displace another configured route or
      // exceed the same bound enforced by the browser's credential parser.
      const iceServers: ScreenShareRelayCredentials["iceServers"] = [];
      for (let group = 0; group < MAX_SCREEN_SHARE_ICE_SERVERS && iceServers.length < MAX_SCREEN_SHARE_ICE_SERVERS; group++) {
        for (const lease of leases) {
          const server = lease.iceServers[group];
          if (server && iceServers.length < MAX_SCREEN_SHARE_ICE_SERVERS) iceServers.push(server);
        }
      }
      return { route: "auto", expiresAt: leases.length ? Math.min(...leases.map(lease => lease.expiresAt)) : this.now() + 86400000,
        iceServers };
    }
    const relay = this.config.find(item => item.id === id);
    if (!relay || relay.provider !== "cloudflare") return this.issue(id);
    try {
      const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${relay.keyId}/credentials/generate-ice-servers`, {
        method: "POST", headers: { Authorization: `Bearer ${relay.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify({ ttl: SCREEN_SHARE_RELAY_TTL_SECONDS }), signal: AbortSignal.timeout(6000),
      });
      if (!response.ok) return null;
      const raw = await response.json() as { iceServers?: unknown };
      if (!Array.isArray(raw.iceServers) || raw.iceServers.length > 4) return null;
      const iceServers = raw.iceServers.flatMap(item => {
        const urls = (Array.isArray(item?.urls) ? item.urls : [item?.urls]).filter(validTurnUrl) as string[];
        if (!urls.length || typeof item.username !== "string" || item.username.length > 512
          || typeof item.credential !== "string" || item.credential.length > 512) return [];
        // Port 53 is blocked by several browsers; 3478/5349/443 remain usable.
        const usable = urls.filter(url => !/:53(?:\?|$)/.test(url));
        return [usable.slice(0, 4), usable.slice(4, 8)].filter(group => group.length).map(group => ({ urls: group, username: item.username, credential: item.credential }));
      }).filter(item => item.urls.length);
      return iceServers.length ? { route: id, expiresAt: this.now() + SCREEN_SHARE_RELAY_TTL_SECONDS * 1000, iceServers } : null;
    } catch { return null; }
  }
}
