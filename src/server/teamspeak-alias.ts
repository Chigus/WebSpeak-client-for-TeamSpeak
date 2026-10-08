import {
  createTeamSpeakNicknameLookup,
  parseTeamSpeakConnectionTarget,
} from "../domain/teamspeak-connection-target.js";
import { DEFAULT_TEAM_SPEAK_PORT, parseTeamSpeakTarget, type TeamSpeakTarget } from "../domain/teamspeak-target.js";
import { resolveLocalTeamSpeakAlias } from "./teamspeak-resolver.js";

export class TeamSpeakAliasLookupError extends Error {
  constructor(message = "TeamSpeak server nickname could not be resolved", options?: ErrorOptions) {
    super(message, options);
    this.name = "TeamSpeakAliasLookupError";
  }
}

/** Only the official HTTPS lookup runs before the open-target address checks. */
export async function resolveTeamSpeakTarget(
  value: string,
  fetchLookup: typeof fetch = fetch,
  localLookup = resolveLocalTeamSpeakAlias,
): Promise<TeamSpeakTarget> {
  const target = parseTeamSpeakConnectionTarget(value);
  if (target.kind === "address") return target.target;

  // An explicit lookup URL always requests a registered nickname. Ordinary
  // short hostnames retain the local service discovery introduced in v0.2.6.
  if (!target.lookupOnly) {
    const localAddress = await localLookup(target.name);
    if (localAddress) return { host: localAddress, port: target.port ?? DEFAULT_TEAM_SPEAK_PORT };
  }

  try {
    const response = await fetchLookup(createTeamSpeakNicknameLookup(target.name), {
      headers: { accept: "text/plain" },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new TeamSpeakAliasLookupError();
    const body = await response.text();
    if (body.length > 4096) throw new TeamSpeakAliasLookupError("Invalid TeamSpeak nickname lookup response");
    const address = body.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (!address) throw new TeamSpeakAliasLookupError("TeamSpeak server nickname was not found");
    const resolved = parseTeamSpeakTarget(address);
    if (!resolved.host.includes(".") && !resolved.host.includes(":") && resolved.host !== "localhost") {
      throw new TeamSpeakAliasLookupError("Invalid TeamSpeak nickname lookup response");
    }
    return { host: resolved.host, port: target.port ?? resolved.port };
  } catch (error) {
    if (error instanceof TeamSpeakAliasLookupError) throw error;
    throw new TeamSpeakAliasLookupError(undefined, { cause: error });
  }
}
