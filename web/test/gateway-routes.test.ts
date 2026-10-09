import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { scoreGateway, selectGateway, setGatewayOrigins, markGatewayFailed } from "../src/voice/gateway-routes.js";
import { createVoiceConnection, type ConnectionFailure } from "../src/voice/connection.js";
test("gateway scoring penalizes jitter and failed probes",()=>{
 assert.ok(scoreGateway([60,61,60]) < scoreGateway([20,130,30]));
 assert.ok(scoreGateway([60,61,60]) < scoreGateway([1]));
 assert.equal(scoreGateway([]),Infinity);
});
test("only configured HTTPS origins are probed and a failed entry falls back",async t=>{
 const old=Object.getOwnPropertyDescriptor(globalThis,'location');
 Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:'https://entry.example',protocol:'https:',host:'entry.example'}});
 t.after(()=>{setGatewayOrigins([]);if(old)Object.defineProperty(globalThis,'location',old);else Reflect.deleteProperty(globalThis,'location');});
 const calls:string[]=[];
 t.mock.method(globalThis,'fetch',async input=>{const url=String(input);calls.push(url);if(url.startsWith('https://entry.example'))throw Error('offline');return new Response('{"status":"ok"}');});
 setGatewayOrigins(['https://entry.example','https://relay.example','http://untrusted.example']);
 assert.equal(await selectGateway(new AbortController().signal),'https://relay.example');
 assert.ok(calls.some(url=>url.startsWith('https://relay.example')));
 assert.ok(!calls.some(url=>url.startsWith('http://')));
 markGatewayFailed('https://relay.example');calls.length=0;
 await selectGateway(new AbortController().signal);
 assert.ok(!calls.some(url=>url.startsWith('https://relay.example')));
});
test("an aborted route selection cannot cache a destination",async t=>{
 const old=Object.getOwnPropertyDescriptor(globalThis,'location');
 Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:'https://abort.example'}});
 t.after(()=>{setGatewayOrigins([]);if(old)Object.defineProperty(globalThis,'location',old);else Reflect.deleteProperty(globalThis,'location');});
 setGatewayOrigins(['https://abort.example','https://alternate.example']);
 const controller=new AbortController();controller.abort();
 t.mock.method(globalThis,'fetch',async()=>{throw Error('must not fetch');});
 assert.equal(await selectGateway(controller.signal),'https://abort.example');
});

function configureOrigins(t: TestContext, origins: string[]) {
  const old = Object.getOwnPropertyDescriptor(globalThis, "location");
  const entry = new URL(origins[0]!);
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: entry.origin, protocol: entry.protocol, host: entry.host } });
  setGatewayOrigins(origins);
  t.after(() => {
    setGatewayOrigins([]);
    if (old) Object.defineProperty(globalThis, "location", old);
    else Reflect.deleteProperty(globalThis, "location");
  });
}

function fixtureConnection(t: TestContext) {
  const failures: ConnectionFailure[] = [];
  const connection = createVoiceConnection({
    onSocket() {}, onMessage() {}, onAudio() {}, onClose() {}, onFailure: failure => failures.push(failure),
  });
  t.after(() => connection.stop());
  return { connection, failures };
}

test("the fourth configured gateway can be selected when preceding entries are unavailable", async t => {
  const origins = ["https://four-entry.example", "https://four-macau.example", "https://four-shenzhen.example", "https://four-aliyun.example"];
  configureOrigins(t, origins);
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async input => {
    const url = String(input); calls.push(url);
    if (!url.startsWith(origins[3]!)) throw Error("offline");
    return new Response('{"status":"ok"}');
  });
  assert.equal(await selectGateway(new AbortController().signal), origins[3]);
  assert.equal(calls.filter(url => url.startsWith(origins[3]!)).length, 3);
});

for (const status of [502, 504]) {
  test(`ticket HTTP ${status} becomes a retryable network failure and cools the failed entry`, async t => {
    const primary = `https://proxy-${status}.example`, alternate = `https://backup-${status}.example`;
    configureOrigins(t, [primary, alternate]);
    const calls: string[] = [];
    let alternateReady = false;
    t.mock.method(globalThis, "fetch", async input => {
      const url = String(input); calls.push(url);
      if (url.endsWith("/api/join-ticket")) return new Response("<html>Proxy unavailable</html>", { status });
      if (url.startsWith(alternate) && !alternateReady) throw Error("offline");
      return new Response('{"status":"ok"}');
    });
    const { connection, failures } = fixtureConnection(t);
    connection.start("{}", Promise.resolve());
    await nextTurn();
    assert.deepEqual(failures.map(failure => failure.code), ["REQUEST_FAILED"]);
    alternateReady = true; calls.length = 0;
    assert.equal(await selectGateway(new AbortController().signal), alternate);
    assert.equal(calls.some(url => url.startsWith(primary)), false, "A proxy failure must invalidate the cached destination");
  });
}

test("a ticket deadline cools its selected entry before aborting the owning request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const primary = "https://timeout-primary.example", alternate = "https://timeout-backup.example";
  configureOrigins(t, [primary, alternate]);
  let alternateReady = false, requestSignal: AbortSignal | null = null;
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/api/join-ticket")) {
      requestSignal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => requestSignal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    }
    if (url.startsWith(alternate) && !alternateReady) throw Error("offline");
    return new Response('{"status":"ok"}');
  });
  const { connection, failures } = fixtureConnection(t);
  connection.start("{}", Promise.resolve());
  await nextTurn();
  assert.ok(requestSignal);
  t.mock.timers.tick(15_000);
  await nextTurn();
  assert.equal((requestSignal as AbortSignal).aborted, true);
  assert.deepEqual(failures.map(failure => failure.code), ["REQUEST_TIMEOUT"]);
  alternateReady = true; calls.length = 0;
  assert.equal(await selectGateway(new AbortController().signal), alternate);
  assert.equal(calls.some(url => url.startsWith(primary)), false);
});

test("business rejections keep their error code and do not cool a healthy gateway", async t => {
  const primary = "https://business-primary.example", alternate = "https://business-backup.example";
  configureOrigins(t, [primary, alternate]);
  t.mock.method(globalThis, "fetch", async input => {
    const url = String(input);
    if (url.endsWith("/api/join-ticket")) return new Response('{"code":"INVITE_INVALID"}', { status: 400 });
    if (url.startsWith(alternate)) throw Error("offline");
    return new Response('{"status":"ok"}');
  });
  const { connection, failures } = fixtureConnection(t);
  connection.start("{}", Promise.resolve());
  await nextTurn();
  assert.deepEqual(failures.map(failure => failure.code), ["INVITE_INVALID"]);
  assert.equal(await selectGateway(new AbortController().signal), primary);
});

test("a retired ticket request cannot cool a healthy gateway after a late proxy failure", async t => {
  const primary = "https://retired-primary.example", alternate = "https://retired-backup.example";
  configureOrigins(t, [primary, alternate]);
  let reply!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", async input => {
    const url = String(input);
    if (url.endsWith("/api/join-ticket")) return new Promise<Response>(resolve => { reply = resolve; });
    if (url.startsWith(alternate)) throw Error("offline");
    return new Response('{"status":"ok"}');
  });
  const { connection, failures } = fixtureConnection(t);
  connection.start("{}", Promise.resolve());
  await nextTurn();
  assert.ok(reply);
  connection.stop();
  reply(new Response("Proxy timeout", { status: 504 }));
  await nextTurn();
  assert.deepEqual(failures, []);
  assert.equal(await selectGateway(new AbortController().signal), primary);
});
