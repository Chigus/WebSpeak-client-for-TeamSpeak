import {
  InvalidTeamSpeakTargetError,
  formatTeamSpeakTarget,
  parseTeamSpeakTarget,
  parseTeamSpeakPort,
  type TeamSpeakTarget,
} from "./teamspeak-target.js";

export const TEAM_SPEAK_NICKNAME_LOOKUP = "https://named.myteamspeak.com/lookup";

export type TeamSpeakConnectionTarget =
  | { kind: "address"; target: TeamSpeakTarget }
  | { kind: "nickname"; name: string; port?: number; lookupOnly?: true };

/** Single-label names follow the TeamSpeak nickname convention; localhost stays local. */
export function parseTeamSpeakConnectionTarget(value: string): TeamSpeakConnectionTarget {
  const input = value.trim();
  if (!input) throw new InvalidTeamSpeakTargetError("TeamSpeak server address is required");

  if (/^https?:\/\//i.test(input)) {
    let url: URL;
    try { url = new URL(input); }
    catch { throw new InvalidTeamSpeakTargetError("Invalid TeamSpeak nickname lookup URL"); }
    if (url.origin !== "https://named.myteamspeak.com" || url.pathname !== "/lookup" || url.username || url.password) {
      throw new InvalidTeamSpeakTargetError("Invalid TeamSpeak nickname lookup URL");
    }
    const names = url.searchParams.getAll("name");
    if (names.length !== 1) throw new InvalidTeamSpeakTargetError("One TeamSpeak nickname is required");
    // URLSearchParams decodes the query once, including form-encoded spaces.
    const target = nicknameTarget(names[0]!, url.hash ? parseTeamSpeakPort(url.hash.slice(1)) : undefined);
    // Keep an explicit registry lookup distinct from a local service name
    // when the target is saved or split into the address and port fields.
    if (/^[a-z0-9_-]+$/i.test(target.name)) target.lookupOnly = true;
    return target;
  }

  if (input.startsWith("[") || input.indexOf(":") !== input.lastIndexOf(":")) {
    return { kind: "address", target: parseTeamSpeakTarget(input) };
  }
  const separator = Math.max(input.indexOf("#"), input.indexOf(":"));
  const host = (separator >= 0 ? input.slice(0, separator) : input).trim();
  const port = separator >= 0 ? parseTeamSpeakPort(input.slice(separator + 1)) : undefined;
  if (host.toLowerCase() === "localhost" || /^[a-z0-9._-]+\.[a-z0-9._-]*$/i.test(host)) {
    return { kind: "address", target: parseTeamSpeakTarget(input) };
  }
  if (/[\/\\?#@\[\]:]/.test(host)) throw new InvalidTeamSpeakTargetError();
  return nicknameTarget(host, port);
}

export function formatTeamSpeakConnectionTarget(target: TeamSpeakConnectionTarget): string {
  if (target.kind === "address") return formatTeamSpeakTarget(target.target);
  // A lookup URL preserves names that could otherwise be mistaken for a host or port.
  if (target.lookupOnly || /[.\/\\?#@\[\]:]/.test(target.name) || target.name.toLowerCase() === "localhost") {
    const url = createTeamSpeakNicknameLookup(target.name);
    if (target.port !== undefined) url.hash = String(target.port);
    return url.href;
  }
  return target.port === undefined ? target.name : `${target.name}:${target.port}`;
}

export function createTeamSpeakNicknameLookup(name: string): URL {
  const url = new URL(TEAM_SPEAK_NICKNAME_LOOKUP);
  url.searchParams.set("name", name);
  return url;
}

function nicknameTarget(nameValue: string, port?: number): Extract<TeamSpeakConnectionTarget, { kind: "nickname" }> {
  const name = nameValue.trim();
  if (!name || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new InvalidTeamSpeakTargetError("Invalid TeamSpeak server nickname");
  }
  return { kind: "nickname", name, ...(port === undefined ? {} : { port }) };
}

