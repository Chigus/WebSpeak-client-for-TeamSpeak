import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { MemberAvatarLoader } from "./member-avatars.js";
import type { TSClientAvatar } from "./ts-client.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const avatar = (value: string): TSClientAvatar => ({ cacheKey: value, data: Buffer.from(`GIF89a${value}`) });
const dataUrl = (value: string) => `data:image/gif;base64,${avatar(value).data.toString("base64")}`;

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const members = new Map<number, { id: number; uid: string; avatar?: string }>();
  const cache = new Map<string, string | null>();
  const calls: number[] = [];
  const published: Array<{ id: number; uid: string; avatar: string }> = [];
  const errors: unknown[] = [];
  const state = { current: true, load: async (_id: number, uid: string): Promise<TSClientAvatar | null> => avatar(uid) };
  const loader = new MemberAvatarLoader({
    members, cache, isCurrent: () => state.current,
    load: (id, uid) => { calls.push(id); return state.load(id, uid); },
    publish: (id, uid, image) => published.push({ id, uid, avatar: image }),
    onError: (_id, _uid, error) => errors.push(error),
  });
  const add = (id: number, uid = `user-${id}`) => { members.set(id, { id, uid }); };
  const tick = async (ms = 0) => { t.mock.timers.tick(ms); await nextTurn(); };
  t.after(() => loader.close());
  return { loader, members, cache, calls, published, errors, state, add, tick };
}

test("avatar batches deduplicate identities and contain optional download failures", async t => {
  const f = fixture(t);
  f.add(1); f.add(2, "user-1"); f.add(3); f.add(4); f.add(5, ""); f.add(6);
  f.cache.set("user-6", null);
  f.state.load = async id => {
    if (id === 3) return { cacheKey: "invalid", data: Buffer.from("not an image") };
    if (id === 4) throw new Error("Permission denied");
    return avatar("one");
  };
  f.loader.schedule(); f.loader.schedule();
  await f.tick();
  assert.deepEqual(f.calls, [2, 3, 4]);
  assert.deepEqual(f.published, [1, 2].map(id => ({ id, uid: "user-1", avatar: dataUrl("one") })));
  assert.equal(f.members.get(1)?.avatar, dataUrl("one"));
  assert.equal(f.members.get(2)?.avatar, dataUrl("one"));
  assert.equal(f.cache.get("user-3"), null);
  assert.equal(f.cache.get("user-4"), null);
  assert.equal(f.errors.length, 1);
  f.loader.schedule(); await f.tick();
  assert.equal(f.calls.length, 3, "known absent/denied avatars must not cause a retry loop");
});

for (const outcome of ["success", "failure"] as const) {
  test(`a late old avatar ${outcome} cannot cache data or unlock a newer batch`, async t => {
    const f = fixture(t);
    f.add(1);
    const old = deferred<TSClientAvatar | null>();
    const fresh = deferred<TSClientAvatar | null>();
    f.state.load = () => old.promise;
    f.loader.schedule(); await f.tick();
    f.loader.reset();
    f.state.load = () => fresh.promise;
    f.loader.schedule(); await f.tick();
    if (outcome === "success") old.resolve(avatar("old"));
    else old.reject(new Error("Old connection failed"));
    await nextTurn();
    assert.equal(f.cache.size, 0);
    assert.equal(f.errors.length, 0);
    f.loader.schedule(); await f.tick(250);
    assert.deepEqual(f.calls, [1, 1], "the newer pending batch must still own the work");
    fresh.resolve(avatar("fresh")); await nextTurn();
    assert.equal(f.cache.get("user-1"), dataUrl("fresh"));
    assert.deepEqual(f.published, [{ id: 1, uid: "user-1", avatar: dataUrl("fresh") }]);
  });
}

test("closing a scheduled avatar loader clears its timer, cache and future work", async t => {
  const f = fixture(t);
  f.add(1); f.cache.set("other", dataUrl("other"));
  f.loader.schedule(100);
  f.loader.close(); f.loader.close();
  f.loader.schedule(); await f.tick(1_000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.cache.size, 0);
});

test("client ID reuse cannot attach a departed member's avatar to its replacement", async t => {
  const f = fixture(t);
  f.add(1, "departed");
  const pending = deferred<TSClientAvatar | null>();
  f.state.load = () => pending.promise;
  f.loader.schedule(); await f.tick();
  f.add(1, "replacement");
  pending.resolve(avatar("old")); await nextTurn();
  assert.equal(f.cache.size, 0);
  assert.equal(f.published.length, 0);
  f.state.load = async () => avatar("new");
  await f.tick(250);
  assert.equal(f.members.get(1)?.avatar, dataUrl("new"));
  assert.deepEqual(f.published.map(message => message.uid), ["replacement"]);
});

test("avatar work keeps a 50-member batch and cancels the delayed remainder on close", async t => {
  const f = fixture(t);
  for (let id = 1; id <= 55; id++) f.add(id);
  f.loader.schedule(); await f.tick();
  assert.equal(f.calls.length, 50);
  await f.tick(249);
  assert.equal(f.calls.length, 50);
  await f.tick(1);
  assert.equal(f.calls.length, 55);
  f.add(56); f.loader.schedule(250); f.loader.close();
  await f.tick(250);
  assert.equal(f.calls.length, 55);
});

test("members arriving during an active batch are scheduled without overlapping downloads", async t => {
  const f = fixture(t);
  const pending = deferred<TSClientAvatar | null>();
  f.add(1);
  f.state.load = () => pending.promise;
  f.loader.schedule(); await f.tick();
  f.add(2); f.loader.schedule(); await f.tick();
  assert.deepEqual(f.calls, [1]);
  f.state.load = async () => avatar("second");
  pending.resolve(avatar("first")); await nextTurn();
  await f.tick(250);
  assert.deepEqual(f.calls, [1, 2]);
  assert.deepEqual(f.published.map(message => message.id), [1, 2]);
});
