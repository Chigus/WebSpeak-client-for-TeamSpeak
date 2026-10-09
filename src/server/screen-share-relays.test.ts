import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readScreenShareRelays, ScreenShareRelays, SCREEN_SHARE_RELAY_TTL_SECONDS } from "./screen-share-relays.js";
import { parseScreenShareMessage, parseScreenShareRelayCredentials } from "../shared/screen-share.js";
import { isVoiceRelayMessage } from "../shared/voice-relay.js";

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

test("three private TURN nodes plus Cloudflare expose four routes and validate Alibaba media leases", t => {
  const directory = mkdtempSync(join(tmpdir(), "webspeak-four-relays-"));
  const file = join(directory, "relays.json"), cloudflareFile = join(directory, "cloudflare.json");
  const previous = process.env.WEBSPEAK_CLOUDFLARE_TURN_FILE;
  t.after(() => {
    if (previous === undefined) delete process.env.WEBSPEAK_CLOUDFLARE_TURN_FILE;
    else process.env.WEBSPEAK_CLOUDFLARE_TURN_FILE = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const nodes = (["macau", "shenzhen", "aliyun"] as const).map(id => ({
    id, secret: `${id}-`.padEnd(48, "s"), urls: [`turn:${id}.example:3478?transport=udp`, `turns:${id}.example:5349?transport=tcp`],
    ...(id === "aliyun" ? { serverUrls: ["turn:gateway-shenzhen.example:3478?transport=udp"] } : {}),
  }));
  const cloudflare = { id: "cloudflare", provider: "cloudflare", keyId: "test-key-id-0123456789", apiToken: "test-api-token-0123456789" };
  writeFileSync(file, JSON.stringify(nodes));
  writeFileSync(cloudflareFile, JSON.stringify(cloudflare));
  process.env.WEBSPEAK_CLOUDFLARE_TURN_FILE = cloudflareFile;
  const relays = new ScreenShareRelays(readScreenShareRelays(file));
  assert.deepEqual(relays.available(), ["macau", "shenzhen", "aliyun", "cloudflare"]);
  const lease = relays.issue("aliyun")!;
  assert.ok(parseScreenShareRelayCredentials(lease));
  assert.deepEqual(lease.iceServers[0]!.urls, nodes[2]!.urls);
  const gateway = relays.gatewayIceServers(lease);
  assert.deepEqual(gateway[0]!.urls, nodes[2]!.serverUrls);
  assert.equal(gateway[0]!.username, lease.iceServers[0]!.username);
  assert.equal(gateway[0]!.credential, lease.iceServers[0]!.credential);
  assert.equal(JSON.stringify(lease).includes("gateway-shenzhen.example"), false);
  assert.equal(Object.hasOwn(lease, "serverUrls"), false);
  assert.equal(lease.iceServers[0]!.credential, createHmac("sha1", nodes[2]!.secret).update(lease.iceServers[0]!.username!).digest("base64"));
  assert.deepEqual(parseScreenShareMessage('{"type":"screenShareStart","route":"aliyun"}'), { type: "screenShareStart", route: "aliyun" });
  assert.ok(isVoiceRelayMessage({ type: "voiceRelay", action: "request", id: "voice-aliyun", route: "aliyun" }));
  assert.ok(isVoiceRelayMessage({ type: "voiceRelay", action: "offer", id: "voice-aliyun", route: "aliyun", sdp: "v=0\r\nfixture-offer", relay: lease }));
  assert.equal(JSON.stringify(lease).includes(nodes[2]!.secret), false);
  writeFileSync(file, JSON.stringify([...nodes, nodes[2]]));
  assert.throws(() => readScreenShareRelays(file), /Invalid screen-share relay configuration/);
});

test("gateway TURN overrides are bounded static configuration and cannot override cloud provider leases", t => {
  const directory = mkdtempSync(join(tmpdir(), "webspeak-gateway-turn-")), file = join(directory, "relays.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const serverUrls of [null, [], "turn:private.example:3478", ["stun:private.example:3478"], ["turn:private.example:99999"], Array(5).fill("turn:private.example:3478")]) {
    writeFileSync(file, JSON.stringify([{ ...config, serverUrls }]));
    assert.throws(() => readScreenShareRelays(file), /Invalid screen-share relay entry/);
  }
  writeFileSync(file, JSON.stringify([{ id: "cloudflare", provider: "cloudflare", keyId: "test-key-id-0123456789", apiToken: "test-api-token-0123456789", serverUrls: ["turn:private.example:3478"] }]));
  assert.throws(() => readScreenShareRelays(file), /Invalid screen-share relay entry/);
  const relays = new ScreenShareRelays([config]), lease = relays.issue("macau")!;
  const gateway = relays.gatewayIceServers(lease);
  assert.deepEqual(gateway, lease.iceServers, "routes without an override keep their existing TURN configuration");
  (gateway[0]!.urls as string[]).push("turn:other.example:3478");
  assert.deepEqual(relays.gatewayIceServers(lease), lease.iceServers, "a peer cannot mutate the browser lease or another peer's configuration");
});
