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
    noiseSuppressionEnabled: ref(true), noiseSuppressionLevel: ref("medium"),
    receiveNoiseSuppressionEnabled: ref(false), receiveNoiseSuppressionLevel: ref("medium"),
    microphoneNoiseSuppressionState: ref("off"), receiveNoiseSuppressionState: ref("off"), stereoInputEnabled: ref(false),
    notificationVolume: ref(1), micLevel: ref(0), microphoneTestActive: ref(false),
    accompanimentActive: ref(false), accompanimentErrorCode: ref(""), whisperTargetIds: new Set(),
    prepareInputDevices: async () => {}, setStereoInputEnabled: async () => {}, stopMicrophoneTest: () => stops.push("stop"),
    setNoiseSuppressionEnabled: async () => {}, setNoiseSuppressionLevel: async () => {},
    setReceiveNoiseSuppressionEnabled: async () => {}, setReceiveNoiseSuppressionLevel: async () => {},
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

function whisperFixture(t) {
  const sent = [], captures = new Set();
  const target = { focus() {}, setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id) };
  const fixture = mount(t, { whisperTargetIds: new Set([7]), setWhisperActive: active => sent.push(active) });
  return { ...fixture, sent, captures, pointer: (id = 1, button = 0, isPrimary = true) => ({ pointerId: id, button, isPrimary, currentTarget: target }) };
}
const keyEvent = (key, extra = {}) => ({ key, preventDefault() {}, ...extra });

test("secondary buttons and non-primary pointers cannot start whispering", t => {
  const { controls, pointer, sent } = whisperFixture(t);
  controls.onWhisperPttDown(pointer(1, 2));
  controls.onWhisperPttDown(pointer(2, 0, false));
  assert.deepEqual(sent, []);
});

test("only the pointer that started whispering may release it", t => {
  const { controls, pointer, sent, captures } = whisperFixture(t);
  controls.onWhisperPttDown(pointer());
  controls.onWhisperPttUp(pointer(2));
  assert.equal(controls.whisperPttActive.value, true);
  controls.onWhisperPttDown(pointer(2));
  controls.onWhisperPttUp(pointer());
  controls.onWhisperPttUp(pointer());
  assert.deepEqual(sent, [true, false]);
  assert.equal(captures.size, 0);
});

test("capture failure does not leave whisper enabled", t => {
  const { controls, pointer, sent } = whisperFixture(t);
  const event = pointer();
  event.currentTarget.setPointerCapture = () => { throw new Error("pointer no longer active"); };
  assert.doesNotThrow(() => controls.onWhisperPttDown(event));
  assert.deepEqual(sent, []);
});

test("keyboard whisper ignores repeat and unrelated releases", t => {
  const { controls, sent, pointer } = whisperFixture(t);
  controls.onWhisperPttKeyDown(keyEvent(" "));
  controls.onWhisperPttKeyDown(keyEvent(" ", { repeat: true }));
  controls.onWhisperPttKeyUp(keyEvent("Enter"));
  controls.onWhisperPttUp(pointer());
  assert.equal(controls.whisperPttActive.value, true);
  controls.onWhisperPttKeyUp(keyEvent(" "));
  controls.onWhisperPttKeyDown(keyEvent("Enter"));
  controls.stopWhisperTalk();
  controls.onWhisperPttKeyUp(keyEvent("Enter"));
  assert.deepEqual(sent, [true, false, true, false]);
});

test("scope disposal releases an active whisper and its capture", t => {
  const { controls, sent, captures, pointer, scope } = whisperFixture(t);
  controls.onWhisperPttDown(pointer());
  scope.stop();
  assert.deepEqual(sent, [true, false]);
  assert.equal(captures.size, 0);
});

test("stereo selection maps both modes and gives a source-channel error an actionable message", async t => {
  const selected = [];
  const { controls } = mount(t, { setStereoInputEnabled: async enabled => {
    selected.push(enabled);
    if (enabled) throw Object.assign(new Error("Only one input channel"), { name: "StereoInputUnavailableError" });
  } });
  await controls.onStereoInputChange({ target: { value: "stereo" } });
  assert.match(controls.settingsError.value, /未提供双声道/);
  assert.match(controls.settingsError.value, /立体声回录或虚拟输入/);
  await controls.onStereoInputChange({ target: { value: "mono" } });
  assert.deepEqual(selected, [true, false]);
  assert.equal(controls.settingsError.value, "");
});

test("a late stereo permission failure cannot replace a newer successful mono selection", async t => {
  const old = deferred();
  const { controls } = mount(t, { setStereoInputEnabled: enabled => enabled ? old.promise : Promise.resolve() });
  const pending = controls.onStereoInputChange({ target: { value: "stereo" } });
  await controls.onStereoInputChange({ target: { value: "mono" } });
  old.reject(new DOMException("Old permission request", "NotAllowedError"));
  await pending;
  assert.equal(controls.settingsError.value, "");
});

test("successful stereo selection retires an earlier output-device error", async t => {
  const old = deferred();
  const { controls } = mount(t, { setOutputDevice: () => old.promise });
  const pending = controls.onOutputDeviceChange(deviceEvent);
  await controls.onStereoInputChange({ target: { value: "stereo" } });
  old.reject(new Error("Old output request"));
  await pending;
  assert.equal(controls.settingsError.value, "");
});

test("closing settings suppresses a pending stereo selection's late failure", async t => {
  const selection = deferred();
  const { controls, settingsOpen } = mount(t, { setStereoInputEnabled: () => selection.promise });
  const pending = controls.onStereoInputChange({ target: { value: "stereo" } });
  settingsOpen.value = false;
  selection.reject(new DOMException("Input busy", "NotReadableError"));
  await pending;
  assert.equal(controls.settingsError.value, "");
});

test("input and received noise controls dispatch independently and reject unknown levels", async t => {
  const changes = [];
  const { controls } = mount(t, {
    setNoiseSuppressionEnabled: async enabled => changes.push(["input", enabled]),
    setReceiveNoiseSuppressionEnabled: async enabled => changes.push(["receive", enabled]),
    setNoiseSuppressionLevel: async level => changes.push(["input-level", level]),
    setReceiveNoiseSuppressionLevel: async level => changes.push(["receive-level", level]),
  });
  await controls.onNoiseSuppressionToggle({ target: { checked: false } });
  await controls.onReceiveNoiseSuppressionToggle({ target: { checked: true } });
  for (const level of ["light", "medium", "heavy"]) {
    await controls.onNoiseSuppressionLevelChange({ target: { value: level } });
    await controls.onReceiveNoiseSuppressionLevelChange({ target: { value: level } });
  }
  await controls.onNoiseSuppressionLevelChange({ target: { value: "invalid" } });
  await controls.onReceiveNoiseSuppressionLevelChange({ target: { value: "invalid" } });
  assert.deepEqual(changes, [
    ["input", false], ["receive", true],
    ["input-level", "light"], ["receive-level", "light"],
    ["input-level", "medium"], ["receive-level", "medium"],
    ["input-level", "heavy"], ["receive-level", "heavy"],
  ]);
});

test("stereo input bypasses only input suppression while received controls remain available", async t => {
  const changes = [], inputEvent = { target: { checked: true } };
  const { controls } = mount(t, {
    stereoInputEnabled: ref(true),
    setNoiseSuppressionEnabled: async () => changes.push("input"),
    setNoiseSuppressionLevel: async () => changes.push("input-level"),
    setReceiveNoiseSuppressionEnabled: async value => changes.push(["receive", value]),
    setReceiveNoiseSuppressionLevel: async value => changes.push(["receive-level", value]),
  });
  await controls.onNoiseSuppressionToggle(inputEvent);
  await controls.onNoiseSuppressionLevelChange({ target: { value: "heavy" } });
  await controls.onReceiveNoiseSuppressionToggle({ target: { checked: true } });
  await controls.onReceiveNoiseSuppressionLevelChange({ target: { value: "heavy" } });
  assert.equal(inputEvent.target.checked, false);
  assert.equal(controls.inputNoiseSuppressionStatusKey.value, "noiseSuppressionStereoBypass");
  assert.deepEqual(changes, [["receive", true], ["receive-level", "heavy"]]);
});

test("noise status distinguishes requested settings from actual processing on each side", t => {
  const inputState = ref("off"), receiveState = ref("off"), receiveEnabled = ref(true), stereoEnabled = ref(false);
  const { controls } = mount(t, {
    microphoneNoiseSuppressionState: inputState, receiveNoiseSuppressionState: receiveState,
    receiveNoiseSuppressionEnabled: receiveEnabled, stereoInputEnabled: stereoEnabled,
  });
  assert.equal(controls.inputNoiseSuppressionStatusKey.value, "noiseSuppressionWaiting");
  assert.equal(controls.receiveNoiseSuppressionStatusKey.value, "noiseSuppressionWaiting");
  inputState.value = "loading";
  receiveState.value = "active";
  assert.equal(controls.inputNoiseSuppressionStatusKey.value, "noiseSuppressionLoading");
  assert.equal(controls.receiveNoiseSuppressionStatusKey.value, "noiseSuppressionActive");
  inputState.value = "active";
  receiveState.value = "failed";
  assert.equal(controls.inputNoiseSuppressionStatusKey.value, "noiseSuppressionActive");
  assert.equal(controls.receiveNoiseSuppressionStatusKey.value, "noiseSuppressionFailed");
  receiveEnabled.value = false;
  assert.equal(controls.receiveNoiseSuppressionStatusKey.value, "noiseSuppressionDisabled");
  stereoEnabled.value = true;
  assert.equal(controls.inputNoiseSuppressionStatusKey.value, "noiseSuppressionStereoBypass");
});

test("failed suppression changes report inside the open dialog and restore the committed control value", async t => {
  const event = { target: { checked: true } }, toasts = [];
  const { controls } = mount(t, {
    noiseSuppressionEnabled: ref(false), showToast: message => toasts.push(message),
    setNoiseSuppressionEnabled: async () => { throw new Error("failed"); },
  });
  await controls.onNoiseSuppressionToggle(event);
  assert.equal(event.target.checked, false);
  assert.equal(controls.settingsError.value, "noiseSuppressionChangeFailed");
  assert.deepEqual(toasts, []);
});

test("a dock suppression failure is handled and shown as a toast", async t => {
  const toasts = [];
  const { controls, settingsOpen } = mount(t, {
    showToast: message => toasts.push(message),
    setReceiveNoiseSuppressionEnabled: async () => { throw new Error("failed"); },
  });
  settingsOpen.value = false;
  await controls.onReceiveNoiseSuppressionToggle({ target: { checked: true } });
  assert.equal(controls.settingsError.value, "");
  assert.deepEqual(toasts, ["noiseSuppressionChangeFailed"]);
});

test("a newer noise choice retires a previous input failure", async t => {
  const pending = deferred();
  const { controls } = mount(t, { setNoiseSuppressionLevel: () => pending.promise });
  const old = controls.onNoiseSuppressionLevelChange({ target: { value: "heavy" } });
  await controls.onReceiveNoiseSuppressionLevelChange({ target: { value: "light" } });
  pending.reject(new Error("old"));
  await old;
  assert.equal(controls.settingsError.value, "");
});

test("closing and reopening settings retires a pending suppression error", async t => {
  const pending = deferred(), toasts = [];
  const { controls, settingsOpen } = mount(t, {
    setReceiveNoiseSuppressionEnabled: () => pending.promise, showToast: message => toasts.push(message),
  });
  const old = controls.onReceiveNoiseSuppressionToggle({ target: { checked: true } });
  settingsOpen.value = false;
  settingsOpen.value = true;
  pending.reject(new Error("old"));
  await old;
  assert.equal(controls.settingsError.value, "");
  assert.deepEqual(toasts, []);
});

test("unmount retires a dock suppression failure without sending a late toast", async t => {
  const pending = deferred(), toasts = [];
  const { controls, settingsOpen, scope } = mount(t, {
    setNoiseSuppressionEnabled: () => pending.promise, showToast: message => toasts.push(message),
  });
  settingsOpen.value = false;
  const old = controls.onNoiseSuppressionToggle({ target: { checked: false } });
  scope.stop();
  pending.reject(new Error("old"));
  await old;
  assert.deepEqual(toasts, []);
});
