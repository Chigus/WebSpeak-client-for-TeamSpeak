import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_TEAM_SPEAK_PORT,
  parseTeamSpeakTargetParts,
  parseTeamSpeakPort,
} from "./domain/teamspeak-target.js";
import { formatTeamSpeakConnectionTarget, parseTeamSpeakConnectionTarget } from "./domain/teamspeak-connection-target.js";

/** The only TeamSpeak state still read from the legacy JSON config. */
export interface AppConfig {
  tsHost: string;
  tsPort: number;
  tsTarget?: string;
  tsServerPassword: string;
}

export function getDefaultConfig(): AppConfig {
  return {
    tsHost: "127.0.0.1",
    tsPort: DEFAULT_TEAM_SPEAK_PORT,
    tsServerPassword: "",
  };
}

/**
 * Convert both the old JSON shape and the M000 shape into the normalized
 * normalized legacy model. Deprecated fields are intentionally ignored and disappear
 * when the migrated model is written back.
 */
export function migrateConfig(input: unknown): AppConfig {
  const defaults = getDefaultConfig();
  if (!isRecord(input)) return defaults;

  const rawHost = typeof input.tsHost === "string" && input.tsHost.trim()
    ? input.tsHost.trim()
    : defaults.tsHost;
  const rawPort = input.tsPort === undefined ? undefined : input.tsPort;
  let target;
  let tsTarget: string | undefined;
  try {
    const connection = /^[0-9a-f:]+$/i.test(rawHost) && rawHost.indexOf(":") !== rawHost.lastIndexOf(":") && input.tsTarget === undefined
      ? { kind: "address" as const, target: parseTeamSpeakTargetParts(rawHost, toPortValue(rawPort), defaults.tsPort) }
      : parseTeamSpeakConnectionTarget(typeof input.tsTarget === "string" ? input.tsTarget : rawHost);
    if (connection.kind === "nickname") {
      const port = toPortValue(rawPort);
      if (input.tsTarget === undefined && port !== undefined && String(port).trim()) {
        connection.port = parseTeamSpeakPort(port);
      }
      target = { host: connection.name, port: connection.port ?? defaults.tsPort };
      tsTarget = formatTeamSpeakConnectionTarget(connection);
    } else {
      target = parseTeamSpeakTargetParts(rawHost, toPortValue(rawPort), defaults.tsPort);
    }
  } catch {
    target = { host: defaults.tsHost, port: defaults.tsPort };
  }

  return {
    tsHost: target.host,
    tsPort: target.port,
    ...(tsTarget ? { tsTarget } : {}),
    tsServerPassword: typeof input.tsServerPassword === "string" ? input.tsServerPassword : defaults.tsServerPassword,
  };
}

export function loadConfig(path: string): AppConfig {
  try {
    return migrateConfig(JSON.parse(readFileSync(path, "utf-8")) as unknown);
  } catch {
    return getDefaultConfig();
  }
}

/** Write only the normalized legacy shape; this is the one-time legacy cleanup. */
export function saveConfig(path: string, config: AppConfig): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(migrateConfig(config), null, 2), "utf-8");
  } catch {
    // config.json may be read-only (e.g. running under systemd as non-root)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPortValue(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}
