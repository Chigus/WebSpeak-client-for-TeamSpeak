import assert from "node:assert/strict";
import test from "node:test";
import { combineTeamSpeakTarget, isValidTeamSpeakPort, splitTeamSpeakTarget, suggestedTeamSpeakPort } from "./teamspeak-target.js";

test("nickname fields round-trip without forcing a default port", () => {
  for (const value of ["team eco", "another guild", "A+B & 50%", "literal%20name", "\u4e2d\u6587\u670d\u52a1\u5668"]) {
    const fields = splitTeamSpeakTarget(value);
    assert.deepEqual(fields, { address: value, port: "" });
    assert.equal(combineTeamSpeakTarget(fields.address, fields.port), value);
    const invitation = new URL("https://webspeak.example/");
    invitation.searchParams.set("server", value);
    assert.equal(splitTeamSpeakTarget(new URL(invitation.href).searchParams.get("server")).address, value);
  }
  assert.deepEqual(splitTeamSpeakTarget("guild:9987"), { address: "guild", port: "9987" });
  assert.equal(combineTeamSpeakTarget("guild", "9987"), "guild:9987");
  assert.equal(combineTeamSpeakTarget("guild:9988", ""), "guild:9988");
});

test("lookup URLs are decoded before combining address and port", () => {
  assert.deepEqual(splitTeamSpeakTarget("https://named.myteamspeak.com/lookup?name=A%2BB+%26+50%25"), { address: "A+B & 50%", port: "" });
  assert.equal(combineTeamSpeakTarget("https://named.myteamspeak.com/lookup?name=team%20eco", ""), "team eco");
  assert.equal(combineTeamSpeakTarget("https://named.myteamspeak.com/lookup?name=team%20eco", "9987"), "team eco:9987");
  const value = "https://named.myteamspeak.com/lookup?name=some.name%3A12#9988";
  const fields = splitTeamSpeakTarget(value);
  assert.equal(combineTeamSpeakTarget(fields.address, fields.port), value);
  const explicit = "https://named.myteamspeak.com/lookup?name=teamspeak";
  assert.deepEqual(splitTeamSpeakTarget(explicit), { address: explicit, port: "" });
  assert.equal(combineTeamSpeakTarget(explicit, ""), explicit);
});

test("IP, DNS, IPv6 and legacy port fields retain their behavior", () => {
  for (const [value, address, port] of [
    ["8.8.8.8", "8.8.8.8", "9987"],
    ["voice.example.com#9988", "voice.example.com", "9988"],
    ["[2606:4700:4700::1111]:9988", "2606:4700:4700::1111", "9988"],
  ]) {
    assert.deepEqual(splitTeamSpeakTarget(value), { address, port });
    const canonical = combineTeamSpeakTarget(address!, port!);
    assert.deepEqual(splitTeamSpeakTarget(canonical), { address, port });
  }
  assert.deepEqual(splitTeamSpeakTarget("voice.example.com", "9999"), { address: "voice.example.com", port: "9999" });
  assert.equal(combineTeamSpeakTarget("voice.example.com", ""), "voice.example.com:9987");
  assert.equal(combineTeamSpeakTarget("[2606:4700:4700::1111]:9988", ""), "[2606:4700:4700::1111]:9988");
  assert.equal(isValidTeamSpeakPort(""), true);
  for (const port of ["0", "65536", "abc"]) assert.equal(isValidTeamSpeakPort(port), false);
});

test("changing address kind clears only the prefilled port and restores host defaults", () => {
  assert.equal(suggestedTeamSpeakPort("voice.example.com", "team eco", "9987"), "");
  assert.equal(suggestedTeamSpeakPort("voice.example.com", "team eco", "9999"), "9999");
  assert.equal(suggestedTeamSpeakPort("team eco", "other guild", "9987"), "9987");
  assert.equal(suggestedTeamSpeakPort("team eco", "voice.example.com", ""), "9987");
  assert.equal(suggestedTeamSpeakPort("voice.example.com", "guild:9988", "9987"), "9988");
});
