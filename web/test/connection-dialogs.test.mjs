import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { effectScope, nextTick, reactive, ref } from "vue";

let vite, useWebClientConnection;
before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL("../", import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  ({ useWebClientConnection } = await vite.ssrLoadModule("/src/composables/useWebClientConnection.ts"));
});
after(async () => { await vite?.close(); });
function mount(t) {
  const scope = effectScope(), errors = ref(""), message = ref(""), switched = ref(""), calls = [];
  const dialog = reactive({ open: true, channelId: "2", password: "draft", error: "", submitting: false });
  const serverHost = ref("fixture.invalid"), serverPort = ref("9987");
  const connection = scope.run(() => useWebClientConnection({
    initialized: ref(true), accessMode: ref("fixed"), isConnecting: ref(false), errorCode: errors,
    errorMessage: message, channelSwitchedChannelId: switched,
    nickname: ref("Preview"), channelName: ref("Room"), serverHost, serverPort,
    serverPassword: ref(""), rememberIdentity: ref(false), identityMaterial: ref(""), accelerationRelayId: ref(""),
    inviteToken: "", selectedChannelId: ref("2"), channels: ref([]), clientId: ref(1),
    channelPasswordDialog: dialog, serverPasswordDialog: reactive({ open: false, password: "", errorCode: "" }),
    chatTab: ref("channel"), switchChannel: (...args) => calls.push(args),
    clearError: () => { errors.value = ""; message.value = ""; }, t: key => key,
  }));
  t.after(() => scope.stop());
  return { dialog, connection, errors, message, switched, calls, serverHost, serverPort };
}

test("pasting a nickname clears the prefilled port and preserves a custom override", t => {
  const { connection, serverHost, serverPort } = mount(t);
  serverHost.value = "https://named.myteamspeak.com/lookup?name=team%20eco";
  assert.equal(serverPort.value, "");
  assert.equal(connection.currentServerTarget(), "team eco");
  serverPort.value = "10000";
  serverHost.value = "another guild";
  assert.equal(connection.currentServerTarget(), "another guild:10000");
});

test("a waiting channel password request cannot be submitted twice", t => {
  const { connection, calls, dialog } = mount(t);
  connection.submitChannelPassword(); connection.submitChannelPassword();
  assert.equal(dialog.submitting, true);
  assert.deepEqual(calls, [["2", "draft"]]);
});

test("an ordinary channel error preserves the password and allows retry", async t => {
  const { connection, dialog, errors, message, calls } = mount(t);
  connection.submitChannelPassword();
  message.value = "Channel operation timed out"; errors.value = "COMMAND_TIMEOUT";
  await nextTick();
  assert.equal(dialog.open, true);
  assert.equal(dialog.submitting, false);
  assert.equal(dialog.password, "draft");
  assert.equal(dialog.error, "Channel operation timed out");
  assert.equal(errors.value, "");
  connection.submitChannelPassword();
  assert.equal(calls.length, 2);
  assert.equal(dialog.error, "");
});

test("a successful channel switch closes and clears the password dialog", async t => {
  const { connection, dialog, switched } = mount(t);
  connection.submitChannelPassword(); switched.value = "2";
  await nextTick();
  assert.deepEqual({ ...dialog }, { open: false, channelId: "", password: "", error: "", submitting: false });
});
