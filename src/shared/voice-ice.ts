/** A media host is an address, never an HTTP URL or an address with a port. */
export function normalizeVoiceMediaHost(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 253) return null;
  const host = value.trim();
  if (!host) return "";
  if (/[:\[\]]/.test(host)) {
    if (!/^(?:\[[\da-f:.]+\]|[\da-f:.]+)$/i.test(host)) return null;
    try {
      const parsed = new URL(`http://${host.startsWith("[") ? host : `[${host}]`}`);
      return parsed.hostname.startsWith("[") && !parsed.port && parsed.pathname === "/"
        ? parsed.hostname.slice(1, -1) : null;
    } catch { return null; }
  }
  if (!host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null;
  return host.toLowerCase();
}

/** Voice currently exposes UDP STUN discovery only, without relay credentials. */
export function normalizeVoiceStunServer(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  if (!value.trim()) return "";
  // werift currently performs srflx discovery on IPv4 sockets. IPv6 media
  // candidates still work independently, but an IPv6-only STUN URL would not.
  const match = /^stun:([a-z\d.-]+)(?::(\d{1,5}))?$/i.exec(value.trim());
  if (!match) return null;
  const host = normalizeVoiceMediaHost(match[1]);
  const port = Number(match[2] ?? 3478);
  if (!host || port < 1 || port > 65535) return null;
  return `stun:${host}:${port}`;
}
