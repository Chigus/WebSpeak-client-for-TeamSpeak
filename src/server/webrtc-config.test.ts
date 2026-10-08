import assert from "node:assert/strict";
import test from "node:test";
import { normalizeVoiceMediaHost, normalizeVoiceStunServer } from "../shared/voice-ice.js";
import { resolveVoiceMediaAddresses } from "./webrtc-config.js";

test("media hosts accept DNS and IPv4/IPv6, reject web URLs, ports and injected components", () => {
  for (const [input, expected] of [["", ""], [" MEDIA.example.com ", "media.example.com"], ["192.0.2.1", "192.0.2.1"], ["[2001:db8::1]", "2001:db8::1"], ["::1", "::1"]]) {
    assert.equal(normalizeVoiceMediaHost(input), expected);
  }
  for (const input of [null, 5, "https://media.example.com", "media.example.com:443", "user@media.example.com", "[::1]?x", "[::1]/x", "[::1]:443", "a\r\nb", "-invalid", "x".repeat(254)]) {
    assert.equal(normalizeVoiceMediaHost(input), null, String(input));
  }
});

test("voice STUN accepts supported UDP URLs and rejects TURN credentials and other protocols", () => {
  assert.equal(normalizeVoiceStunServer(" STUN:stun.example.com "), "stun:stun.example.com:3478");
  assert.equal(normalizeVoiceStunServer("stun:[2001:db8::1]:3478"), null);
  assert.equal(normalizeVoiceStunServer(""), "");
  for (const value of [null, [], "turn:example.com", "stuns:example.com", "https://example.com", "stun:user:pass@example.com", "stun:example.com:0", "stun:example.com:65536", "stun:example.com?transport=tcp", "stun:example.com/path"]) {
    assert.equal(normalizeVoiceStunServer(value), null, String(value));
  }
});

test("media DNS produces literal candidates and honors IPv6 without disabling IPv4", async () => {
  const resolve = async (host: string) => {
    assert.equal(host, "media.example.com");
    return [{ address: "2001:db8::1", family: 6 }, { address: "192.0.2.1", family: 4 }, { address: "192.0.2.1", family: 4 }];
  };
  assert.deepEqual(await resolveVoiceMediaAddresses("media.example.com", false, resolve), ["192.0.2.1"]);
  assert.deepEqual(await resolveVoiceMediaAddresses("media.example.com", true, resolve), ["2001:db8::1", "192.0.2.1"]);
  assert.deepEqual(await resolveVoiceMediaAddresses("[2001:db8::1]", false, resolve), []);
  assert.deepEqual(await resolveVoiceMediaAddresses("[2001:db8::1]", true, resolve), ["2001:db8::1"]);
  assert.deepEqual(await resolveVoiceMediaAddresses("192.0.2.1", false, resolve), ["192.0.2.1"]);
  assert.deepEqual(await resolveVoiceMediaAddresses("media.example.com", true, async () => { throw new Error("DNS unavailable"); }), []);
});
