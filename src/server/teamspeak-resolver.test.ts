import assert from "node:assert/strict";
import test from "node:test";
import type { AddrResolver, ResolvedAddr } from "@echosixhiya/teamspeak-client";
import { WebSpeakTeamSpeakResolver } from "./teamspeak-resolver.js";

function fixedResolver(result: ResolvedAddr[], onResolve?: (signal?: AbortSignal) => void): AddrResolver {
  return {
    resolve: async (_address, signal) => {
      onResolve?.(signal);
      return result;
    },
  };
}

test("private short hostnames use local DNS directly without cloud nickname discovery", async () => {
  let baseCalls = 0;
  const resolver = new WebSpeakTeamSpeakResolver({
    localLookup: async (hostname) => {
      assert.equal(hostname, "teamspeak");
      return [{ address: "172.18.0.6", family: 4 }];
    },
    baseResolver: {
      resolve: async () => {
        baseCalls++;
        return [];
      },
    },
  });

  const result = await resolver.resolve("teamspeak:9988");
  assert.equal(result[0]?.addr, "172.18.0.6:9988");
  assert.equal(result[0]?.source, "Direct");
  assert.equal(baseCalls, 0);
});

test("undotted nickname discovery is bounded and falls back to the direct host", async () => {
  let baseSignal: AbortSignal | undefined;
  const resolver = new WebSpeakTeamSpeakResolver({
    localLookup: async () => [],
    baseResolver: {
      resolve: async (_address, signal) => {
        baseSignal = signal;
        return new Promise<ResolvedAddr[]>(() => undefined);
      },
    },
    localAliasLookupTimeoutMs: 20,
    nicknameLookupTimeoutMs: 25,
  });

  const result = await resolver.resolve("teamspeak:9987");
  assert.equal(result[0]?.addr, "teamspeak:9987");
  assert.equal(result[0]?.source, "Direct");
  assert.equal(baseSignal?.aborted, true);
});

test("dotted hostnames preserve the SDK resolver path", async () => {
  const expected: ResolvedAddr[] = [{ addr: "voice.example.com:9987", source: "Direct", expiry: new Date(0) }];
  let lookupCalls = 0;
  let baseCalls = 0;
  const resolver = new WebSpeakTeamSpeakResolver({
    localLookup: async () => {
      lookupCalls++;
      return [];
    },
    baseResolver: fixedResolver(expected, () => { baseCalls++; }),
  });

  assert.deepEqual(await resolver.resolve("voice.example.com:9987"), expected);
  assert.equal(lookupCalls, 0);
  assert.equal(baseCalls, 1);
});

test("DNS resolution failures continue through bounded nickname discovery", async () => {
  const expected: ResolvedAddr[] = [{ addr: "public.example.com:9987", source: "Nickname", expiry: new Date(0) }];
  const resolver = new WebSpeakTeamSpeakResolver({
    localLookup: async () => { throw new Error("ENOTFOUND"); },
    baseResolver: fixedResolver(expected),
    nicknameLookupTimeoutMs: 100,
  });

  assert.deepEqual(await resolver.resolve("public-alias"), expected);
});
