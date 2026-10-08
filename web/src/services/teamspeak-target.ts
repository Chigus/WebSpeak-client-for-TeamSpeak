import {
  formatTeamSpeakConnectionTarget,
  parseTeamSpeakConnectionTarget,
} from "../../../src/domain/teamspeak-connection-target.js";

export const DEFAULT_TEAM_SPEAK_PORT = "9987";

export interface TeamSpeakTargetFields {
  address: string;
  port: string;
}

/** Split both the current canonical target and the legacy address#port form. */
export function splitTeamSpeakTarget(value: unknown, fallbackPort = DEFAULT_TEAM_SPEAK_PORT): TeamSpeakTargetFields {
  const input = typeof value === "string" ? value.trim() : "";
  if (!input) return { address: "", port: fallbackPort };

  try {
    const target = parseTeamSpeakConnectionTarget(input);
    if (target.kind === "nickname") {
      return { address: formatTeamSpeakConnectionTarget({ ...target, port: undefined }), port: target.port === undefined ? "" : String(target.port) };
    }
    const hasPort = input.includes("#") || /^\[[^\]]+\]:/.test(input) || /^[^:]+:/.test(input);
    return { address: target.target.host, port: hasPort ? String(target.target.port) : fallbackPort };
  } catch {
    return { address: stripBrackets(input), port: fallbackPort };
  }
}

/** Build the canonical API value from the two user-facing fields. */
export function combineTeamSpeakTarget(address: string, port: string): string {
  const normalizedAddress = stripBrackets(address.trim());
  const normalizedPort = port.trim();
  if (!normalizedAddress) return "";
  const input = !normalizedAddress.startsWith("[") && normalizedAddress.indexOf(":") !== normalizedAddress.lastIndexOf(":") && !/^https?:\/\//i.test(normalizedAddress)
    ? `[${normalizedAddress}]`
    : normalizedAddress;
  try {
    const target = parseTeamSpeakConnectionTarget(input);
    if (normalizedPort) {
      if (!isPort(normalizedPort)) throw new Error("Invalid port");
      if (target.kind === "nickname") target.port = Number(normalizedPort);
      else target.target.port = Number(normalizedPort);
    }
    return formatTeamSpeakConnectionTarget(target);
  } catch {
    return normalizedPort ? `${input}:${normalizedPort}` : input;
  }
}

export function isValidTeamSpeakPort(value: string): boolean {
  return !value.trim() || isPort(value.trim());
}

/** Drop the prefilled default when switching to a nickname, retaining custom ports. */
export function suggestedTeamSpeakPort(previousAddress: string, address: string, port: string): string {
  try {
    const target = parseTeamSpeakConnectionTarget(address);
    let previousWasNickname = false;
    try { previousWasNickname = parseTeamSpeakConnectionTarget(previousAddress).kind === "nickname"; }
    catch { /* An empty or incomplete field has no previous nickname. */ }
    if (target.kind === "nickname" && !previousWasNickname && port === DEFAULT_TEAM_SPEAK_PORT) {
      return target.port === undefined ? "" : String(target.port);
    }
    if (target.kind === "address" && previousWasNickname && !port.trim()) return String(target.target.port);
  } catch { /* Keep the port while the address is being edited. */ }
  return port;
}

function isPort(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function stripBrackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}
