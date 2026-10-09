import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createRenderer, nextTick, shallowRef, markRaw } from "vue";
let vite, useWebClientScreenShare;
const renderer = createRenderer({ createComment: text => ({ text }), createText: text => ({ text }), createElement: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null });
before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL("../", import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  ({ useWebClientScreenShare } = await vite.ssrLoadModule("/src/composables/useWebClientScreenShare.ts"));
});
after(async () => { await vite?.close(); });
function mount(t, initialStream = null) {
  const listeners = new Set(), starts = [], storage = new Map(); let exits = 0, ui;
  class Element {}
  class Video extends Element { srcObject = null; volume = 1; plays = 0; async play() { this.plays++; } }
  const doc = { fullscreenElement: null, addEventListener: (_event, fn) => listeners.add(fn), removeEventListener: (_event, fn) => listeners.delete(fn), async exitFullscreen() { exits++; doc.fullscreenElement = null; for (const fn of listeners) fn(); } };
  for (const [key, value] of Object.entries({ HTMLElement: Element, HTMLVideoElement: Video, document: doc, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else delete globalThis[key]; });
  }
  const viewing = shallowRef(true), stream = shallowRef(initialStream), volume = shallowRef(.4), streams = [], relays = shallowRef([]);
  const app = renderer.createApp({ setup() { ui = useWebClientScreenShare({ relays, streams, viewing, viewingStreamId: shallowRef("s"), remoteStream: stream, remoteVolume: volume, error: shallowRef(""), errorCode: shallowRef(""), startScreenShare: async (...args) => starts.push(args), joinScreenShare() {}, leaveScreenShare() {}, nickname: shallowRef("Self"), avatarStyle: () => ({}), t: key => key }); return () => null; } });
  app.mount({});
  return { ui, app, doc, relays, viewing, stream, volume, streams, starts, storage, listeners, exits: () => exits, video: () => markRaw(new Video()), player: () => markRaw(new Element()) };
}

test("a newly mounted or replaced video receives the existing stream and volume", async t => {
  const media = { id: "stream" }, f = mount(t, media);
  try {
    const first = f.video(); f.ui.setVideoElement(first); await nextTick();
    assert.equal(first.srcObject, media); assert.equal(first.volume, .4);
    const second = f.video(); f.ui.setVideoElement(second); await nextTick();
    assert.equal(first.srcObject, null); assert.equal(second.srcObject, media); assert.equal(second.volume, .4);
    f.volume.value = .7; await nextTick(); assert.equal(second.volume, .7);
  } finally { f.app.unmount(); }
});

test("unmount detaches video and retires a pending binding without stopping its stream", async t => {
  let stops = 0; const media = { getTracks: () => [{ stop: () => stops++ }] }, f = mount(t, media);
  try { const video = f.video(); f.ui.setVideoElement(video); await nextTick();
    f.volume.value = .8; f.app.unmount(); await nextTick();
    assert.equal(video.srcObject, null); assert.equal(stops, 0); assert.equal(f.listeners.size, 0);
  } finally { if (f.listeners.size) f.app.unmount(); }
});

test("absent player is never fullscreen and does not request fullscreen exit", async t => {
  const f = mount(t);
  try { f.ui.syncFullscreen(); assert.equal(f.ui.fullscreen.value, false); f.viewing.value = false; await nextTick(); assert.equal(f.exits(), 0); }
  finally { f.app.unmount(); }
});

test("removing a fullscreen player exits only that player's fullscreen", async t => {
  const f = mount(t);
  try { const player = f.player(); f.ui.setPlayerElement(player); f.doc.fullscreenElement = player; f.ui.syncFullscreen();
    assert.equal(f.ui.fullscreen.value, true); f.ui.setPlayerElement(null); await nextTick();
    assert.equal(f.exits(), 1); assert.equal(f.ui.fullscreen.value, false);
    f.ui.setPlayerElement(f.player()); f.doc.fullscreenElement = f.player(); f.ui.setPlayerElement(null);
    assert.equal(f.exits(), 1);
  } finally { f.app.unmount(); }
});

test("known screen owner IDs cannot fall back to another member with the same nickname", t => {
  const f = mount(t);
  try { f.streams.push({ streamId: "s", ownerClientId: 7, ownerPeerId: "peer", ownerNickname: "Same", source: "browser" });
    assert.equal(f.ui.streamForMember({ id: 8, nickname: "Same" }), null);
    assert.equal(f.ui.streamForMember({ id: 7, nickname: "Renamed" }).streamId, "s");
    f.streams[0] = { streamId: "ts", ownerPeerId: "ts-7", ownerNickname: "Same", source: "teamspeak" };
    assert.equal(f.ui.streamForMember({ id: 8, nickname: "Same" }), null);
    f.streams[0] = { streamId: "legacy", ownerPeerId: "unknown", ownerNickname: "Same", source: "browser" };
    assert.equal(f.ui.streamForMember({ id: 8, nickname: "Same" }).streamId, "legacy");
  } finally { f.app.unmount(); }
});

test("share settings submit the selected resolution and frame rate", async t => {
  const f = mount(t);
  try { f.ui.settingsOpen.value = true; f.ui.resolutionPreset.value = "720p"; f.ui.frameRate.value = 30; await f.ui.startWithSettings();
    assert.deepEqual(f.starts, [[true, { maxWidth: 1280, maxHeight: 720, maxFrameRate: 30 }]]);
    assert.equal(f.ui.settingsOpen.value, false); assert.equal(f.storage.get("webspeak:screen-share-framerate"), "30");
  } finally { f.app.unmount(); }
});

test("server routes are enabled only when configured and selection persists", async t => {
  const f = mount(t);
  try {
    assert.deepEqual(f.ui.routeOptions.value.map(x => x.available), [true, false, false]);
    f.ui.route.value = "macau"; await f.ui.startWithSettings();
    assert.equal(f.starts.length, 0);
    f.relays.value = ["macau", "shenzhen"];
    await f.ui.startWithSettings();
    assert.equal(f.starts[0][1].route, "macau");
    assert.equal(f.storage.get("webspeak:screen-share-route"), "macau");
    f.relays.value = []; await f.ui.startWithSettings();
    assert.equal(f.starts.length, 1);
    assert.equal(f.ui.route.value, "macau");
  } finally { f.app.unmount(); }
});
