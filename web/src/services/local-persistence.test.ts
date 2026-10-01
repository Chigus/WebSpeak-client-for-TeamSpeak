import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { loadLocalPreferences, saveInstalledSkin, saveLocalPreferences } from "./local-persistence.js";
import type { InstalledSkin } from "./skin-pack.js";

// Control IndexedDB's request and transaction completion separately. These tests
// exercise the public storage APIs, including cancellation before opening the DB.
const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
let opening: any;
let transactions: Transaction[] = [];
class Transaction {
  oncomplete?: () => void; onerror?: () => void; onabort?: () => void;
  getRequest: any; putRequest: any; written: unknown; aborted = false;
  objectStore() { return {
    get: () => this.getRequest = {},
    put: (value: unknown) => { this.written = value; return this.putRequest = {}; },
  }; }
  abort() { this.aborted = true; this.onabort?.(); }
  read(value: unknown) { this.getRequest.result = value; this.getRequest.onsuccess(); }
  writtenSuccessfully() { this.putRequest.onsuccess(); }
  commit() { assert.equal(this.aborted, false); this.oncomplete?.(); }
}
const database = { transaction: () => { const tx = new Transaction(); transactions.push(tx); return tx; } };
const sample = { id: "sample.a", css: "", assets: {} } as InstalledSkin;
before(() => Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
  open: () => opening = { result: database },
} }));
beforeEach(() => { transactions = []; });
after(() => {
  if (descriptor) Object.defineProperty(globalThis, "indexedDB", descriptor);
  else Reflect.deleteProperty(globalThis, "indexedDB");
});

test("cancelling a skin while IndexedDB opens prevents the delayed write", async () => {
  const owner = new AbortController();
  const pending = saveInstalledSkin(sample, owner.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  owner.abort(); opening.onsuccess();
  await rejected;
  assert.equal(transactions.length, 0);
});
test("a successful request is not reported as durable until its transaction commits", async () => {
  let settled = false;
  const pending = saveInstalledSkin(sample).then(() => { settled = true; });
  await nextTurn(); const tx = transactions[0];
  tx.writtenSuccessfully(); await nextTurn();
  assert.equal(settled, false);
  tx.commit(); await pending;
  assert.equal(settled, true);
});
test("retiring a skin aborts its outstanding write transaction", async () => {
  const owner = new AbortController();
  const pending = saveInstalledSkin(sample, owner.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await nextTurn(); const tx = transactions[0];
  tx.writtenSuccessfully(); owner.abort(); await rejected;
  assert.equal(tx.aborted, true);
});
test("skin preferences merge current unrelated fields in the same transaction", async () => {
  const pending = saveLocalPreferences({ schemaVersion: 1, skinId: "builtin.dark" });
  await nextTurn(); assert.equal(transactions.length, 1);
  const tx = transactions[0];
  tx.read({ schemaVersion: 1, language: "de", inputGain: 0.5, volumesByUid: { member: 0.2 } });
  assert.deepEqual(tx.written, { id: "singleton", schemaVersion: 1, language: "de", inputGain: 0.5, skinId: "builtin.dark", volumesByUid: { member: 0.2 } });
  tx.writtenSuccessfully(); tx.commit(); await pending;
});
test("cancelling a pending preference merge aborts it without blocking the caller", async () => {
  const owner = new AbortController();
  const pending = saveLocalPreferences({ schemaVersion: 1, skinId: "sample.a" }, owner.signal);
  await nextTurn(); const tx = transactions[0];
  owner.abort(); await pending;
  assert.equal(tx.aborted, true);
  assert.equal(tx.written, undefined);
});
test("storage read success still returns its original data after transaction completion", async () => {
  const pending = loadLocalPreferences();
  await nextTurn(); const tx = transactions[0];
  tx.read({ schemaVersion: 1, skinId: "builtin.dark" }); tx.commit();
  assert.deepEqual(await pending, { schemaVersion: 1, skinId: "builtin.dark", volumesByUid: {} });
});
