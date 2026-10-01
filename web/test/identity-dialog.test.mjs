import assert from "node:assert/strict";
import { before, after, beforeEach, afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { effectScope, ref } from "vue";

let vite, useWebClientIdentity, scope, identity, material, remember, notices;
const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const bytes = value => new TextEncoder().encode(value).buffer;
const file = pending => ({ size: 10, arrayBuffer: () => pending.promise });

before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL("../", import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  ({ useWebClientIdentity } = await vite.ssrLoadModule("/src/composables/useWebClientIdentity.ts"));
});
beforeEach(() => { material = ref("previous-material"); remember = ref(false); notices = []; });
afterEach(() => {
  scope?.stop();
  if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
  else delete globalThis.document;
});
after(async () => { await vite?.close(); });
function mount(extra = {}) {
  scope = effectScope();
  identity = scope.run(() => useWebClientIdentity({ identityMaterial: material, rememberIdentity: remember,
    t: key => key, showToast: message => notices.push(message), ...extra }));
  identity.show();
}

test("only the latest chosen file can replace identity text", async () => {
  mount();
  const a = deferred(), b = deferred();
  const first = identity.readFile(file(a)), second = identity.readFile(file(b));
  b.resolve(bytes("new selection")); await second;
  a.resolve(bytes("old selection")); await first;
  assert.equal(identity.text.value, "new selection");
});
test("an old read rejection cannot replace a newer read result", async () => {
  mount();
  const a = deferred();
  const first = identity.readFile(file(a));
  await identity.readFile({ size: 3, arrayBuffer: async () => bytes("new") });
  a.reject(new Error("read failed")); await first;
  assert.equal(identity.error.value, "");
  assert.equal(identity.text.value, "new");
});
test("closing and reopening the dialog retires its pending file", async () => {
  mount();
  const a = deferred(), first = identity.readFile(file(a));
  identity.close(); identity.show();
  a.resolve(bytes("old dialog")); await first;
  assert.equal(identity.open.value, true);
  assert.equal(identity.text.value, "");
});
test("manual editing wins over an already pending file read", async () => {
  mount();
  const a = deferred(), first = identity.readFile(file(a));
  identity.text.value = "new manual input";
  a.resolve(bytes("file")); await first;
  assert.equal(identity.text.value, "new manual input");
});
test("rejecting a new oversized file also retires the previous selection", async () => {
  mount();
  const a = deferred(), first = identity.readFile(file(a));
  await identity.readFile({ size: 128 * 1024 + 1, arrayBuffer: () => { throw new Error("must not read"); } });
  a.resolve(bytes("old file")); await first;
  assert.equal(identity.text.value, "");
  assert.equal(identity.error.value, "identityImportErrorTooLarge");
});
test("unmount prevents a pending file from writing back", async () => {
  mount();
  const a = deferred(), first = identity.readFile(file(a));
  scope.stop(); a.resolve(bytes("file")); await first;
  assert.equal(identity.text.value, "");
});
test("unmount prevents a pending parse from replacing identity or notifying", async () => {
  const parsed = deferred(); mount({ parse: () => parsed.promise });
  identity.text.value = "submitted";
  const pending = identity.submit(); scope.stop();
  parsed.resolve("new-material"); await pending;
  assert.equal(material.value, "previous-material");
  assert.equal(remember.value, false);
  assert.deepEqual(notices, []);
});
test("normal import commits once and keeps the busy close guard", async () => {
  const parsed = deferred(); let calls = 0;
  mount({ parse: value => { assert.equal(value, "submitted"); calls++; return parsed.promise; } });
  identity.text.value = "submitted";
  const pending = identity.submit();
  await identity.submit(); identity.close();
  assert.equal(identity.open.value, true);
  assert.equal(identity.busy.value, true);
  parsed.resolve("new-material"); await pending;
  assert.equal(material.value, "new-material");
  assert.equal(remember.value, true);
  assert.equal(identity.open.value, false);
  assert.equal(identity.text.value, "");
  assert.equal(identity.busy.value, false);
  assert.equal(calls, 1);
  assert.deepEqual(notices, ["identityImportSuccess"]);
});

test("an obsolete read cannot clear a newer file's reading state", async () => {
  mount(); const a = deferred(), b = deferred();
  const first = identity.readFile(file(a)), second = identity.readFile(file(b));
  a.resolve(bytes("old")); await first;
  assert.equal(identity.reading.value, true);
  b.resolve(bytes("new")); await second;
  assert.equal(identity.reading.value, false);
});
test("submitting waits for the selected file and editing cancels the old read", async () => {
  let submitted = ""; mount({ parse: async value => { submitted = value; return "new-material"; } });
  identity.text.value = "previous text";
  const read = deferred(), pending = identity.readFile(file(read));
  await identity.submit(); assert.equal(submitted, "");
  identity.text.value = "manual text";
  await identity.submit();
  read.resolve(bytes("obsolete file")); await pending;
  assert.equal(submitted, "manual text");
  assert.equal(identity.text.value, "");
  assert.equal(identity.open.value, false);
});
test("text edits retire a pending parse without losing the new draft", async () => {
  const parsed = deferred(); mount({ parse: () => parsed.promise });
  identity.text.value = "old"; const pending = identity.submit();
  identity.text.value = "new";
  parsed.resolve("obsolete-material"); await pending;
  assert.equal(material.value, "previous-material");
  assert.equal(identity.text.value, "new");
  assert.equal(identity.busy.value, false);
  assert.deepEqual(notices, []);
});
test("reset retires a parse and its late rejection cannot affect a new submission", async () => {
  const a = deferred(), b = deferred(); let count = 0;
  mount({ parse: () => ++count === 1 ? a.promise : b.promise });
  identity.text.value = "old"; const first = identity.submit();
  identity.reset(); identity.show(); identity.text.value = "new";
  const second = identity.submit();
  a.reject(new Error("obsolete failure")); await first;
  assert.equal(identity.error.value, ""); assert.equal(identity.busy.value, true);
  b.resolve("new-material"); await second;
  assert.equal(material.value, "new-material");
});
test("current parse failure preserves the draft and allows retry", async () => {
  mount({ parse: async () => { throw new Error("invalid"); } });
  identity.text.value = "invalid draft"; await identity.submit();
  assert.equal(identity.text.value, "invalid draft");
  assert.equal(identity.error.value, "identityImportErrorInvalidKey");
  assert.equal(identity.busy.value, false);
  assert.equal(material.value, "previous-material");
  identity.close(); assert.equal(identity.open.value, false);
});
test("file decoding retains UTF-8 and both UTF-16 BOM forms", async () => {
  mount();
  for (const data of [new Uint8Array(bytes("测试")), new Uint8Array([0xff, 0xfe, 0x4b, 0x6d, 0xd5, 0x8b]), new Uint8Array([0xfe, 0xff, 0x6d, 0x4b, 0x8b, 0xd5])]) {
    await identity.readFile({ size: data.length, arrayBuffer: async () => data.buffer });
    assert.equal(identity.text.value, "测试");
    assert.equal(identity.error.value, ""); assert.equal(identity.reading.value, false);
  }
  await identity.readFile({ size: 1, arrayBuffer: async () => new Uint8Array([0xff]).buffer });
  assert.equal(identity.error.value, "identityImportErrorMalformed");
  assert.equal(identity.text.value, "测试");
  await identity.readFile({ size: 0, arrayBuffer: async () => bytes("") });
  assert.equal(identity.error.value, "identityImportErrorEmpty");
});

function exportDom(t, { clickFailure = false, removeFailure = false } = {}) {
  const created = [], revoked = [], links = [], timers = new Map();
  t.mock.method(URL, "createObjectURL", () => { const url = `blob:test-${created.length}`; created.push(url); return url; });
  t.mock.method(URL, "revokeObjectURL", url => revoked.push(url));
  t.mock.method(globalThis, "setTimeout", (callback, delay) => { assert.equal(delay, 1000); const id = {}; timers.set(id, callback); return id; });
  t.mock.method(globalThis, "clearTimeout", id => timers.delete(id));
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    body: { append(link) { link.appended = true; } },
    createElement(tag) { assert.equal(tag, "a"); const link = {
      clicked: false, removed: false,
      click() { if (clickFailure) throw new Error("click failed"); this.clicked = true; },
      remove() { if (removeFailure) throw new Error("remove failed"); this.removed = true; },
    }; links.push(link); return link; },
  } });
  return { created, revoked, links, timers };
}
test("export coalesces pending clicks, removes its anchor and revokes its URL", async t => {
  const dom = exportDom(t), serialized = deferred(); let calls = 0;
  mount({ serialize: value => { calls++; assert.equal(value, "previous-material"); return serialized.promise; } });
  remember.value = true;
  const pending = identity.exportIdentity(); await identity.exportIdentity();
  serialized.resolve("exported ini"); await pending;
  assert.equal(calls, 1); assert.equal(dom.links[0].download, "webspeak-identity.ini");
  assert.equal(dom.links[0].clicked, true); assert.equal(dom.links[0].removed, true);
  assert.equal(identity.exporting.value, false);
  for (const callback of [...dom.timers.values()]) callback();
  assert.deepEqual(dom.revoked, dom.created); assert.equal(dom.timers.size, 0);
});
test("unmount discards a pending export without creating a download or toast", async t => {
  const dom = exportDom(t), serialized = deferred(); mount({ serialize: () => serialized.promise });
  remember.value = true; const pending = identity.exportIdentity(); scope.stop();
  serialized.resolve("old identity"); await pending;
  assert.deepEqual(dom.created, []); assert.deepEqual(notices, []);
});
test("identity changes retire old exports even if the original identity is restored", async t => {
  const dom = exportDom(t), old = deferred(), latest = deferred(); let calls = 0;
  mount({ serialize: () => ++calls === 1 ? old.promise : latest.promise }); remember.value = true;
  const first = identity.exportIdentity(); material.value = "replacement"; material.value = "previous-material";
  const second = identity.exportIdentity(); old.reject(new Error("obsolete")); await first;
  assert.equal(identity.exporting.value, true); assert.deepEqual(notices, []);
  latest.resolve("current identity"); await second;
  assert.equal(dom.created.length, 1); scope.stop();
  assert.deepEqual(dom.revoked, dom.created); assert.equal(dom.timers.size, 0);
});
test("turning remembered identity off prevents a late export", async t => {
  const dom = exportDom(t), serialized = deferred(); mount({ serialize: () => serialized.promise });
  remember.value = true; const pending = identity.exportIdentity(); remember.value = false;
  serialized.resolve("identity"); await pending;
  assert.deepEqual(dom.created, []); assert.deepEqual(notices, []);
});
test("failed download clicks release URLs even if removing the anchor also fails", async t => {
  const dom = exportDom(t, { clickFailure: true, removeFailure: true }); mount({ serialize: async () => "identity" });
  remember.value = true; await identity.exportIdentity();
  assert.deepEqual(dom.revoked, dom.created); assert.equal(dom.timers.size, 0);
  assert.equal(identity.exporting.value, false);
  assert.deepEqual(notices, ["identityExportError"]);
});

test("startup restoration cannot overwrite an identity imported while storage was pending", async () => {
  mount({ parse: async () => "imported-material" });
  const stored = deferred(), pending = identity.restore(() => stored.promise);
  identity.text.value = "imported"; await identity.submit();
  stored.resolve("stored-material"); await pending;
  assert.equal(material.value, "imported-material");
});
test("reset and disposal retire startup identity restoration", async () => {
  mount();
  const stored = deferred(), pending = identity.restore(() => stored.promise);
  identity.reset(); stored.resolve("stored-material"); await pending;
  assert.equal(material.value, "previous-material");
  const late = deferred(), closing = identity.restore(() => late.promise);
  scope.stop(); late.resolve("late-material"); await closing;
  assert.equal(material.value, "previous-material");
});
test("restoring optional identity preserves a newer remember preference", async () => {
  mount(); remember.value = true;
  const stored = deferred(), pending = identity.restore(() => stored.promise);
  remember.value = false; stored.resolve("stored-material"); await pending;
  assert.equal(remember.value, false);
  assert.equal(material.value, "previous-material");
});
test("current startup identity restoration still succeeds", async () => {
  mount(); await identity.restore(async () => "stored-material");
  assert.equal(remember.value, true); assert.equal(material.value, "stored-material");
});
test("optional storage failure leaves the current identity usable", async () => {
  mount(); await identity.restore(async () => { throw new Error("storage unavailable"); });
  assert.equal(material.value, "previous-material"); assert.deepEqual(notices, []);
});
