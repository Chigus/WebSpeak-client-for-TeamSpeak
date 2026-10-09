/** Only administrator-configured HTTPS origins can receive identity/join data. */
export function readGatewayOrigins(raw = process.env.WEBSPEAK_GATEWAY_ORIGINS): string[] {
  if (!raw) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Invalid gateway origins"); }
  if (!Array.isArray(value) || value.length > 4) throw new Error("Invalid gateway origins");
  return [...new Set(value.map(item => {
    if (typeof item !== "string") throw new Error("Invalid gateway origin");
    const url = new URL(item);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Invalid gateway origin");
    return url.origin;
  }))];
}
