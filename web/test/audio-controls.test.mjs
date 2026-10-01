import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { effectScope, ref } from "vue";

let vite, useWebClientAudioControls;
before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL("../", import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  ({ useWebClientAudioControls } = await vite.ssrLoadModule("/src/composables/useWebClientAudioControls.ts"));
});
after(async () => { await vite?.close(); });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mount(t, extra = {}) {
  const scope = effectScope(), settingsOpen = ref(false), stops = [];
  const controls = scope.run(() => useWebClientAudioControls({
    settingsOpen, microphoneMuted: ref(false), inputVolume: ref(1), voxThreshold: ref(.01),
    notificationVolume: ref(1), micLevel: ref(0), microphoneTestActive: ref(false),
    accompanimentActive: ref(false), accompanimentErrorCode: ref(""), whisperTargetIds: new Set(),
    prepareInputDevices: async () => {}, stopMicrophoneTest: () => stops.push("stop"),
    localizedMessage: value => value, t: key => key, ...extra,
  }));
  t.after(() => scope.stop());
  settingsOpen.value = true;
  return { controls, settingsOpen, scope, stops };
}
const deviceEvent = { target: { value: "device" } };

test("a previous opening cannot publish its preparation error after reopening", async t => {
  const first = deferred(), second = deferred(); let calls = 0;
  const { controls, settingsOpen } = mount(t, { prepareInputDevices: () => (++calls === 1 ? first.promise : second.promise) });
  await Promise.resolve(); settingsOpen.value = false; await Promise.resolve(); settingsOpen.value = true; await Promise.resolve();
  first.reject(new DOMException("old", "NotAllowedError")); await Promise.resolve();
  assert.equal(controls.settingsError.value, "");
  second.reject(new DOMException("current", "NotFoundError")); await Promise.resolve();
  assert.match(controls.settingsError.value, /未找到可用的麦克风/);
});

test("a completed newer device selection retires older errors", async t => {
  const old = deferred();
  const { controls } = mount(t, { setOutputDevice: () => old.promise, setInputDevice: async () => {} });
  await Promise.resolve();
  const pending = controls.onOutputDeviceChange(deviceEvent);
  await controls.onInputDeviceChange(deviceEvent);
  old.reject(new Error("old output")); await pending;
  assert.equal(controls.settingsError.value, "");
});

test("an earlier selection cannot replace the current selection's error", async t => {
  const old = deferred();
  const { controls } = mount(t, { setInputDevice: () => old.promise, setOutputDevice: async () => { throw new Error("current output"); } });
  await Promise.resolve();
  const pending = controls.onInputDeviceChange(deviceEvent);
  await controls.onOutputDeviceChange(deviceEvent);
  old.reject(new DOMException("old input", "NotAllowedError")); await pending;
  assert.equal(controls.settingsError.value, "current output");
});

test("closing immediately cancels the test UI and ignores its late rejection", async t => {
  const testStart = deferred();
  const { controls, settingsOpen, stops } = mount(t, { startMicrophoneTest: () => testStart.promise });
  await Promise.resolve();
  const pending = controls.toggleMicTest(); settingsOpen.value = false;
  assert.equal(stops.length, 1);
  testStart.reject(new Error("old recording")); await pending;
  assert.equal(controls.settingsError.value, "");
});

test("unmount stops recording and retires device preparation", async t => {
  const preparation = deferred();
  const { controls, scope, stops } = mount(t, { prepareInputDevices: () => preparation.promise });
  await Promise.resolve(); scope.stop();
  assert.equal(stops.length, 1);
  preparation.reject(new DOMException("old", "NotAllowedError")); await Promise.resolve();
  assert.equal(controls.settingsError.value, "");
});
