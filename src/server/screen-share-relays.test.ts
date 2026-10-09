import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readScreenShareRelays, ScreenShareRelays, SCREEN_SHARE_RELAY_TTL_SECONDS } from "./screen-share-relays.js";
import { parseScreenShareMessage, parseScreenShareRelayCredentials } from "../shared/screen-share.js";

const config = { id: "macau" as const, urls: ["turn:relay.example:3478?transport=udp"], secret: "s".repeat(48) };
test("TURN REST credentials have a bounded lease and separate random identities", () => {
  const registry = new ScreenShareRelays([config], () => 100_000);
  assert.deepEqual(registry.available(), ["macau"]);
  assert.equal(registry.issue("shenzhen"), null);
  const first = registry.issue("macau")!, second = registry.issue("macau")!;
  const ice = first.iceServers[0]!;
  assert.equal(first.expiresAt, (100 + SCREEN_SHARE_RELAY_TTL_SECONDS) * 1000);
  assert.equal(ice.credential, createHmac("sha1", config.secret).update(ice.username!).digest("base64"));
  assert.notEqual(ice.username, second.iceServers[0]?.username);
  assert.equal(JSON.stringify(first).includes(config.secret), false);
  assert.ok(parseScreenShareRelayCredentials(first));
});
test("private relay configuration rejects duplicates, invalid ports, STUN and short secrets", t => {
  const directory = mkdtempSync(join(tmpdir(), "webspeak-turn-")), file = join(directory, "relays.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const value of [[config, config], [{ ...config, secret: "short" }], [{ ...config, id: "unknown" }], ...["stun:example:3478", "turn:example:99999", "turn:example:0"].map(url => [{ ...config, urls: [url] }])]) {
    writeFileSync(file, JSON.stringify(value));
    assert.throws(() => readScreenShareRelays(file), /Invalid screen-share/);
  }
  writeFileSync(file, JSON.stringify([config]));
  assert.deepEqual(readScreenShareRelays(file), [config]);
  assert.deepEqual(readScreenShareRelays(""), []);
});
test("wire parsing preserves legacy P2P and rejects unknown routes or unusable relay credentials", () => {
  assert.deepEqual(parseScreenShareMessage('{"type":"screenShareStart"}'), { type: "screenShareStart" });
  assert.ok("error" in parseScreenShareMessage('{"type":"screenShareStart","route":"other"}')!);
  const valid = new ScreenShareRelays([config]).issue("macau")!;
  for (const value of [{ ...valid, iceServers: [] }, { ...valid, iceServers: [{ urls: "stun:example", username: "a", credential: "b" }] }, { ...valid, route: "other" }]) {
    assert.equal(parseScreenShareRelayCredentials(value), null);
  }
});
