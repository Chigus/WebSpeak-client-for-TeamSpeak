let configured: string[] = [];
export function setGatewayOrigins(value: unknown) {
  configured = Array.isArray(value) && value.length <= 4 ? value.filter((x): x is string => typeof x === "string") : [];
  cached = null;
}
export function hasGatewayChoices(): boolean { return configured.length > 1; }
const failed = new Map<string, number>();
let cached: { origin: string; until: number } | null = null;
export function markGatewayFailed(origin: string) { failed.set(origin, Date.now() + 120000); cached = null; }
export function scoreGateway(samples: number[]): number {
  if (!samples.length) return Infinity;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return mean + (Math.max(...samples) - Math.min(...samples)) + (3 - samples.length) * 1500;
}
/** The page stays at its trusted entry origin, preserving IndexedDB identity.
 * Only the ticket/WSS destination changes to another configured proxy. */
export async function selectGateway(signal: AbortSignal): Promise<string> {
  const local = location.origin ?? `${location.protocol}//${location.host}`;
  if (cached && cached.until > Date.now() && !failed.has(cached.origin)) return cached.origin;
  try {
    const config = { origins: configured };
    if (!config.origins.length) return local;
    const origins: string[] = [local];
    for (const raw of config.origins) {
      if (typeof raw !== "string") continue;
      const url = new URL(raw);
      if (url.protocol === "https:" && url.origin === raw && !url.username && !url.password && !origins.includes(raw)) origins.push(raw);
    }
    if (origins.length === 1) return local;
    const ranked = await Promise.all(origins.map(async origin => {
      const samples: number[] = [];
      if ((failed.get(origin) ?? 0) > Date.now()) return { origin, score: Infinity };
      failed.delete(origin);
      for (let n = 0; n < 3 && !signal.aborted; n++) {
        const start = performance.now();
        try {
          const result = await fetch(`${origin}/api/health?probe=${n}`, { cache: "no-store", credentials: "omit", signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) });
          if (result.ok && (await result.json()).status === "ok") samples.push(performance.now() - start);
        } catch {}
      }
      return { origin, score: scoreGateway(samples) };
    }));
    if (signal.aborted) return local;
    const base = ranked.find(item => item.origin === local)!, best = ranked.sort((a,b) => a.score-b.score)[0]!;
    const selected = best.origin !== local && best.score + 25 < base.score * .8 ? best.origin : local;
    cached = { origin: selected, until: Date.now() + 60000 }; return selected;
  } catch { return local; }
}
