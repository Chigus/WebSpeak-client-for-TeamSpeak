import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Resolver as TeamSpeakResolver } from "@echosixhiya/teamspeak-client/discovery";
import type { AddrResolver, ResolvedAddr } from "@echosixhiya/teamspeak-client";
import { formatTeamSpeakTarget, parseTeamSpeakTarget } from "../domain/teamspeak-target.js";

const LOCAL_ALIAS_LOOKUP_TIMEOUT_MS = 1_000;
const NICKNAME_LOOKUP_TIMEOUT_MS = 3_000;

type LocalAddress = { address: string; family: number };
type LocalLookup = (hostname: string) => Promise<LocalAddress[]>;

interface WebSpeakTeamSpeakResolverOptions {
  baseResolver?: AddrResolver;
  localLookup?: LocalLookup;
  localAliasLookupTimeoutMs?: number;
  nicknameLookupTimeoutMs?: number;
}

/**
 * Keep TeamSpeak nickname discovery for normal names, while allowing an
 * internal short hostname (for example a Docker Compose service name) to use
 * the local resolver directly. Bound cloud nickname discovery so a network
 * black hole cannot prevent the SDK's direct-host fallback indefinitely.
 */
export class WebSpeakTeamSpeakResolver implements AddrResolver {
  private readonly baseResolver: AddrResolver;
  private readonly localLookup: LocalLookup;
  private readonly localAliasLookupTimeoutMs: number;
  private readonly nicknameLookupTimeoutMs: number;

  constructor(options: WebSpeakTeamSpeakResolverOptions = {}) {
    this.baseResolver = options.baseResolver ?? new TeamSpeakResolver();
    this.localLookup = options.localLookup ?? ((hostname) => lookup(hostname, { all: true, verbatim: true }));
    this.localAliasLookupTimeoutMs = options.localAliasLookupTimeoutMs ?? LOCAL_ALIAS_LOOKUP_TIMEOUT_MS;
    this.nicknameLookupTimeoutMs = options.nicknameLookupTimeoutMs ?? NICKNAME_LOOKUP_TIMEOUT_MS;
  }

  async resolve(address: string, signal?: AbortSignal): Promise<ResolvedAddr[]> {
    if (signal?.aborted) throw signal.reason ?? new Error("TeamSpeak address resolution was aborted");

    let target;
    try {
      target = parseTeamSpeakTarget(address);
    } catch {
      return this.resolveBase(address, signal);
    }

    const { host, port } = target;
    if (isIP(host) || host === "localhost" || host.includes(".")) {
      return this.resolveBase(address, signal);
    }

    const localAddress = await resolveLocalTeamSpeakAlias(host, {
      lookup: this.localLookup, timeoutMs: this.localAliasLookupTimeoutMs, signal,
    });
    if (localAddress) {
      return [directAddress(localAddress, port)];
    }

    const baseResults = await this.resolveBaseWithTimeout(address, signal);
    return baseResults?.length ? baseResults : [directAddress(host, port)];
  }

  private resolveBase(address: string, signal?: AbortSignal): Promise<ResolvedAddr[]> {
    return this.baseResolver.resolve(address, signal);
  }

  private async resolveBaseWithTimeout(address: string, signal?: AbortSignal): Promise<ResolvedAddr[] | null> {
    const timeoutController = new AbortController();
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
    try {
      return await raceWithTimeout(
        Promise.resolve().then(() => this.baseResolver.resolve(address, combinedSignal)),
        this.nicknameLookupTimeoutMs,
        signal,
      );
    } catch (error: unknown) {
      if (signal?.aborted) throw signal.reason ?? error;
      return null;
    } finally {
      timeoutController.abort(new Error("TeamSpeak nickname lookup timed out"));
    }
  }
}

/** Keep Docker/service names local before attempting public nickname discovery. */
export async function resolveLocalTeamSpeakAlias(
  host: string,
  options: { lookup?: LocalLookup; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string | undefined> {
  if (!/^[a-z0-9_-]+$/i.test(host)) return undefined;
  const localLookup = options.lookup ?? ((name: string) => lookup(name, { all: true, verbatim: true }));
  const addresses = await raceWithTimeout(
    Promise.resolve().then(() => localLookup(host)),
    options.timeoutMs ?? LOCAL_ALIAS_LOOKUP_TIMEOUT_MS,
    options.signal,
  ).catch((error: unknown) => {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    return null;
  });
  return addresses?.find(({ address }) => isPrivateNetworkAddress(address))?.address;
}

function directAddress(host: string, port: number): ResolvedAddr {
  return {
    addr: formatTeamSpeakTarget({ host, port }),
    source: "Direct",
    expiry: new Date(0),
  };
}

function isPrivateNetworkAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number, number, number];
    return a === 10
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
  }
  if (version !== 6) return false;

  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPrivateNetworkAddress(normalized.slice("::ffff:".length));
  if (normalized === "::" || normalized === "::1") return true;
  const firstGroup = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  return (firstGroup & 0xfe00) === 0xfc00 || (firstGroup & 0xffc0) === 0xfe80;
}

function raceWithTimeout<T>(work: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T | null> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("TeamSpeak address resolution was aborted"));

  return new Promise<T | null>((resolve, reject) => {
    let settled = false;
    const finish = (callback: (value: T | null) => void, value: T | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("TeamSpeak address resolution was aborted"));
    };
    const timer = setTimeout(() => finish(resolve, null), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => finish(resolve, value),
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
