import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { normalizeVoiceMediaHost } from "../shared/voice-ice.js";

/** Default WebRTC media port range used by WebSpeak and its Docker image. */
export const DEFAULT_WEBRTC_UDP_PORT_RANGE: [number, number] = [40000, 40099];

// Kept as a public alias for callers that used the original fixed-range name.
export const WEBRTC_UDP_PORT_RANGE = DEFAULT_WEBRTC_UDP_PORT_RANGE;
export const WEBRTC_UDP_PORT_MIN = 1024;
export const WEBRTC_UDP_PORT_MAX = 65535;

/** SDP candidates must contain usable addresses, not the HTTP proxy's hostname. */
export async function resolveVoiceMediaAddresses(
  host: string | undefined,
  ipv6: boolean,
  resolve = (name: string) => lookup(name, { all: true }),
): Promise<string[]> {
  const normalized = normalizeVoiceMediaHost(host ?? "");
  if (!normalized) return [];
  const family = isIP(normalized);
  if (family) return family === 4 || ipv6 ? [normalized] : [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      resolve(normalized),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Media DNS timeout")), 1500); }),
    ]);
    return [...new Set(addresses.filter(value => value.family === 4 || ipv6 && value.family === 6).map(value => value.address))];
  } catch {
    // Host discovery and STUN may still work when the optional additional address does not.
    return [];
  } finally { clearTimeout(timer); }
}
