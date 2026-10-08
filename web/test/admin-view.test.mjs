import assert from "node:assert/strict";
import { before, after, beforeEach, afterEach, test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import vuePlugin from "@vitejs/plugin-vue";

// Mount the actual SFC setup and router with a headless Vue renderer. HTTP is
// controlled to reorder responses; DOM layout and real authentication are not
// claimed by these lifecycle tests.
let vite, AdminView, createRenderer, createRouter, createMemoryHistory, ssrContextKey, reactive;
let app, router, state, handler, serverModel, operationsModel, skinsModel;
const globals = new Map();
function global(name, value) {
  if (!globals.has(name)) globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const settings = (extra = {}) => ({
  target: "voice.example:9987", hasPassword: false, accessMode: "fixed", siteName: "Original",
  welcomeText: "", welcomeTextEn: "", welcomeTextDe: "", welcomeTextRu: "", welcomeTextJa: "",
  welcomeDefaults: { zh: "", en: "", de: "", ru: "", ja: "" },
  lastTestAt: null, lastTestLatencyMs: null, lastTestError: null,
  webRtcEnabled: false, webRtcUdpStart: 40000, webRtcUdpEnd: 40099,
  relayConfigured: false, relayEnabled: false, relayName: "", relayTarget: "", hasRelayToken: false,
  relayNodes: [], internalPort: 3040, updatedAt: "2026-10-01T00:00:00Z", ...extra,
});
const overview = { gateway: { status: "running", version: "test", uptimeSeconds: 0 },
  teamSpeak: { target: "voice.example:9987", status: "unknown", lastTestAt: null, latencyMs: null, lastError: null },
  sessions: { active: 0, peak: 0, limit: 100 }, recentEvents: [], legacyConfigImported: false };
const session = nickname => ({ id: nickname, nickname, target: "voice.example:9987", state: "connected", createdAt: "2026-10-01T00:00:00Z", ageSeconds: 0, tsClientId: 1, channelId: "1", memberCount: 1 });
const defaults = path => ({
  "/session": { authenticated: true, mustChangePassword: false, csrfToken: "test-csrf" },
  "/server": settings(), "/overview": overview, "/sessions": { sessions: [] }, "/invites": { invites: [] },
  "/diagnostics": { gateway: { version: "test", node: "test", platform: "test", arch: "test" }, database: { schemaVersion: 1 }, sessions: { created: 0 } },
  "/logs?limit=100": { available: false, entries: [], sessions: [] }, "/audit?limit=50": { events: [] },
  "/skins": { skins: [], defaultSkinId: "builtin.light" },
})[path];

before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL("../", import.meta.url)),
    plugins: [vuePlugin()], server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  ({ createRenderer, ssrContextKey, reactive } = await import("vue"));
  ({ createRouter, createMemoryHistory } = await import("vue-router"));
  ({ default: AdminView } = await vite.ssrLoadModule("/src/views/AdminView.vue"));
});
beforeEach(() => {
  const storage = new Map();
  global("localStorage", { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) });
  global("window", { confirm: () => true, setTimeout, clearTimeout });
  global("location", { origin: "https://gateway.example" });
  global("document", undefined);
  handler = (path) => Promise.resolve(json(defaults(path)));
  global("fetch", (url, init) => handler(String(url).replace("/api/admin", ""), init));
});
afterEach(() => { app?.unmount(); app = null; });
after(async () => {
  await vite?.close();
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

async function mount(path = "/admin/server") {
  const renderer = createRenderer({
    createComment: text => ({ text }), createText: text => ({ text }), createElement: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null,
  });
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }] });
  await router.push(path);
  await router.isReady();
  app = renderer.createApp({ ...AdminView, render: () => null });
  app.provide(ssrContextKey, { modules: new Set() });
  app.use(router);
  app.mount({});
  state = app._instance.setupState;
  serverModel = reactive(state.serverSettings);
  operationsModel = reactive(state.adminOperations);
  skinsModel = reactive(state.adminSkins);
  await nextTurn();
  assert.equal(state.loading, false);
}

test("saving settings preserves edits made after the request started", async () => {
  await mount();
  const save = deferred();
  handler = (path, init) => path === "/server" && init.method === "PUT" ? save.promise : Promise.resolve(json(defaults(path)));
  serverModel.serverForm.siteName = "Submitted";
  serverModel.serverForm.passwordAction = "replace";
  serverModel.serverForm.serverPassword = "submitted-test-password";
  const pending = serverModel.saveServerSettings();
  serverModel.serverForm.siteName = "New draft";
  serverModel.serverForm.serverPassword = "new-test-password";
  save.resolve(json({ ok: true, settings: settings({ siteName: "Submitted", hasPassword: true }) }));
  await pending;
  assert.equal(serverModel.serverForm.siteName, "New draft");
  assert.equal(serverModel.serverForm.serverPassword, "new-test-password");
  assert.equal(serverModel.serverForm.passwordAction, "replace");
  assert.equal(serverModel.serverForm.hasPassword, true);
});

test("changing the target while probing discards the old server result", async () => {
  await mount();
  const probe = deferred();
  handler = path => path === "/server/test" ? probe.promise : Promise.resolve(json(defaults(path)));
  const pending = serverModel.testServerConnection();
  serverModel.serverForm.address = "replacement.example";
  probe.resolve(json({ ok: true, checkType: "protocol", passwordVerified: false, latencyMs: 20, serverName: "Old", requiresPassword: false }));
  await pending;
  assert.equal(serverModel.testResult, null);
  assert.equal(serverModel.serverForm.lastTestAt, null);
});

test("an older operations refresh cannot overwrite the newer snapshot", async () => {
  await mount();
  const first = deferred();
  let queries = 0;
  handler = path => path === "/sessions"
    ? (++queries === 1 ? first.promise : Promise.resolve(json({ sessions: [session("New")] })))
    : Promise.resolve(json(defaults(path)));
  const old = operationsModel.loadOperations();
  await operationsModel.loadOperations();
  first.resolve(json({ sessions: [session("Old")] }));
  await old;
  assert.deepEqual(operationsModel.operations.sessions.map(item => item.nickname), ["New"]);
});

test("unmounting the admin page prevents late login from navigating back", async () => {
  handler = path => Promise.resolve(json(path === "/session" ? { authenticated: false } : defaults(path)));
  await mount("/admin/login");
  const login = deferred();
  handler = path => path === "/login" ? login.promise : Promise.resolve(json(defaults(path)));
  const pending = state.login();
  app.unmount(); app = null;
  await router.push("/");
  login.resolve(json({ ok: true, mustChangePassword: false, csrfToken: "new-test-csrf" }));
  await pending;
  assert.equal(router.currentRoute.value.path, "/");
});

test("refreshing skins preserves a default selection edited during the request", async () => {
  await mount("/admin/skins");
  const skins = deferred();
  handler = path => path === "/skins" ? skins.promise : Promise.resolve(json(defaults(path)));
  const pending = skinsModel.loadSkinCatalog();
  skinsModel.skinDefaultId = "builtin.dark";
  skins.resolve(json({ skins: [], defaultSkinId: "builtin.light" }));
  await pending;
  assert.equal(skinsModel.skinDefaultId, "builtin.dark");
});

test("a successful settings save clears submitted secrets and updates their stored status", async () => {
  await mount();
  serverModel.serverForm.passwordAction = "replace";
  serverModel.serverForm.serverPassword = "submitted-test-password";
  serverModel.addRelayNode();
  Object.assign(serverModel.serverForm.relayNodes[0], { name: "Relay", target: "relay.example:9000", token: "submitted-test-token" });
  const relay = { ...serverModel.serverForm.relayNodes[0], hasToken: true };
  handler = (path, init) => Promise.resolve(json(path === "/server" && init.method === "PUT"
    ? { ok: true, settings: settings({ hasPassword: true, relayNodes: [relay] }) } : defaults(path)));
  await serverModel.saveServerSettings();
  assert.equal(serverModel.serverForm.serverPassword, "");
  assert.equal(serverModel.serverForm.passwordAction, "keep");
  assert.equal(serverModel.serverForm.hasPassword, true);
  assert.equal(serverModel.serverForm.relayNodes[0].token, "");
  assert.equal(serverModel.serverForm.relayNodes[0].tokenAction, "keep");
  assert.equal(serverModel.serverForm.relayNodes[0].hasToken, true);
  assert.equal(serverModel.serverSaving, false);
  assert.equal(state.errorMessage, "");
});

test("ICE settings load, submit and preserve edits made during a pending save", async () => {
  await mount();
  const network = { webRtcPublicHost: "media.example.com", webRtcIpv6Enabled: true, webRtcStunServer: "stun:stun.example.com:3478" };
  handler = path => Promise.resolve(json(path === "/server" ? settings(network) : defaults(path)));
  await serverModel.loadServerSettings();
  for (const [key, value] of Object.entries(network)) assert.equal(serverModel.serverForm[key], value);
  const save = deferred();
  handler = (path, init) => {
    if (path !== "/server" || init.method !== "PUT") return Promise.resolve(json(defaults(path)));
    const submitted = JSON.parse(init.body);
    for (const [key, value] of Object.entries(network)) assert.equal(submitted[key], value);
    return save.promise;
  };
  const pending = serverModel.saveServerSettings();
  serverModel.serverForm.webRtcPublicHost = "new-media.example.com";
  serverModel.serverForm.webRtcIpv6Enabled = false;
  serverModel.serverForm.webRtcStunServer = "";
  save.resolve(json({ ok: true, settings: settings(network) }));
  await pending;
  assert.equal(serverModel.serverForm.webRtcPublicHost, "new-media.example.com");
  assert.equal(serverModel.serverForm.webRtcIpv6Enabled, false);
  assert.equal(serverModel.serverForm.webRtcStunServer, "");
});

test("settings saves preserve relay edits, removals and additions made while awaiting the server", async () => {
  await mount();
  serverModel.addRelayNode(); serverModel.addRelayNode();
  for (const [i, node] of serverModel.serverForm.relayNodes.entries()) Object.assign(node, { name: `Relay ${i}`, target: "relay.example:9000", token: "old-token" });
  const submitted = serverModel.serverForm.relayNodes.map(node => ({ ...node, hasToken: true }));
  const save = deferred();
  handler = (path, init) => path === "/server" && init.method === "PUT" ? save.promise : Promise.resolve(json(defaults(path)));
  const pending = serverModel.saveServerSettings();
  Object.assign(serverModel.serverForm.relayNodes[0], { name: "New name", token: "new-token" });
  serverModel.removeRelayNode(1); serverModel.addRelayNode();
  const addedId = serverModel.serverForm.relayNodes[1].id;
  save.resolve(json({ ok: true, settings: settings({ relayNodes: submitted }) }));
  await pending;
  assert.deepEqual(serverModel.serverForm.relayNodes.map(node => node.id), [submitted[0].id, addedId]);
  assert.equal(serverModel.serverForm.relayNodes[0].name, "New name");
  assert.equal(serverModel.serverForm.relayNodes[0].token, "new-token");
  assert.equal(serverModel.serverForm.relayNodes[0].tokenAction, "replace");
  assert.equal(serverModel.serverForm.relayNodes[0].hasToken, true);
});

test("duplicate saves submit once and failed saves retain the draft", async () => {
  await mount();
  const save = deferred(); let calls = 0;
  handler = (path, init) => path === "/server" && init.method === "PUT"
    ? (++calls, save.promise) : Promise.resolve(json(defaults(path)));
  Object.assign(serverModel.serverForm, { siteName: "Unsaved", passwordAction: "replace", serverPassword: "unsaved-test-password" });
  const pending = serverModel.saveServerSettings();
  await serverModel.saveServerSettings();
  assert.equal(calls, 1);
  assert.equal(serverModel.serverSaving, true);
  save.resolve(json({ code: "REQUEST_FAILED" }, 500));
  await pending;
  assert.equal(serverModel.serverSaving, false);
  assert.equal(serverModel.serverForm.siteName, "Unsaved");
  assert.equal(serverModel.serverForm.serverPassword, "unsaved-test-password");
  assert.ok(state.errorMessage);
});

test("only the latest probe publishes its result and a valid probe still updates the timestamp", async () => {
  await mount();
  const old = deferred(); let probes = 0;
  const result = name => ({ ok: true, checkType: "protocol", passwordVerified: false, latencyMs: 20, serverName: name, requiresPassword: false });
  handler = path => path === "/server/test" ? (++probes === 1 ? old.promise : Promise.resolve(json(result("New")))) : Promise.resolve(json(defaults(path)));
  const pending = serverModel.testServerConnection();
  serverModel.serverForm.address = "new.example";
  await serverModel.testServerConnection();
  old.resolve(json(result("Old"))); await pending;
  assert.equal(serverModel.testResult.serverName, "New");
  assert.equal(serverModel.serverForm.lastTestLatencyMs, 20);
  assert.ok(serverModel.serverForm.lastTestAt);
  assert.equal(serverModel.testing, false);
  assert.equal(state.errorMessage, "");
});

test("an obsolete refresh failure cannot clear a newer spinner or publish an error", async () => {
  await mount("/admin/operations");
  const old = deferred(), latest = deferred(); let calls = 0;
  handler = path => path === "/sessions" ? (++calls === 1 ? old.promise : latest.promise) : Promise.resolve(json(defaults(path)));
  const first = operationsModel.loadOperations(), second = operationsModel.loadOperations();
  old.resolve(json({ code: "REQUEST_FAILED" }, 500)); await first;
  assert.equal(operationsModel.operationsLoading, true);
  assert.equal(state.errorMessage, "");
  latest.resolve(json({ sessions: [session("New")] })); await second;
  assert.equal(operationsModel.operationsLoading, false);
  assert.equal(operationsModel.operations.sessions[0].nickname, "New");
});

test("leaving a management section discards its pending read and returning loads fresh data", async () => {
  await mount("/admin/operations");
  const old = deferred();
  handler = path => path === "/sessions" ? old.promise : Promise.resolve(json(defaults(path)));
  const pending = operationsModel.loadOperations();
  state.errorMessage = "Previous section error";
  await router.push("/admin/server");
  await nextTurn();
  old.resolve(json({ sessions: [session("Old")] })); await pending;
  assert.deepEqual(operationsModel.operations.sessions, []);
  assert.equal(operationsModel.operationsLoading, false);
  assert.equal(state.errorMessage, "");
  handler = path => Promise.resolve(json(path === "/sessions" ? { sessions: [session("Current")] } : defaults(path)));
  await router.push("/admin/operations"); await nextTurn();
  assert.equal(operationsModel.operations.sessions[0].nickname, "Current");
});

test("a failed logout preserves the authenticated draft and a successful logout clears private state", async () => {
  await mount("/admin/operations");
  serverModel.serverForm.siteName = "Draft"; serverModel.serverForm.serverPassword = "private-test-password";
  operationsModel.inviteForm.expiresInHours = 48; operationsModel.inviteForm.maxUses = 10;
  operationsModel.createdInvite = { token: "test-only-invite", link: "https://gateway.example/?invite=test-only-invite" };
  handler = path => Promise.resolve(path === "/logout" ? json({ code: "REQUEST_FAILED" }, 500) : json(defaults(path)));
  await state.logout();
  assert.equal(state.screen, "admin");
  assert.equal(serverModel.serverForm.siteName, "Draft");
  assert.equal(serverModel.serverForm.serverPassword, "private-test-password");
  assert.equal(operationsModel.createdInvite?.token, "test-only-invite");
  assert.equal(state.loggingOut, false);
  assert.ok(state.errorMessage);
  handler = path => Promise.resolve(json(path === "/logout" ? { ok: true } : defaults(path)));
  await state.logout();
  assert.equal(state.screen, "login");
  assert.equal(state.csrfToken, "");
  assert.equal(serverModel.serverForm.serverPassword, "");
  assert.equal(operationsModel.operations.diagnostics.node, "");
  assert.equal(operationsModel.inviteForm.expiresInHours, 24);
  assert.equal(operationsModel.inviteForm.maxUses, 0);
  assert.equal(operationsModel.createdInvite, null);
  assert.equal(router.currentRoute.value.path, "/admin/login");
});

test("an old 401 cannot log out a newly authenticated page", async () => {
  await mount("/admin/operations");
  const old = deferred();
  handler = path => path === "/sessions" ? old.promise : Promise.resolve(json(path === "/logout" ? { ok: true } : defaults(path)));
  const pending = operationsModel.loadOperations();
  await state.logout();
  handler = path => Promise.resolve(json(path === "/login" ? { ok: true, mustChangePassword: false, csrfToken: "new-test-csrf" } : defaults(path)));
  await state.login();
  old.resolve(json({ code: "AUTH_REQUIRED" }, 401)); await pending;
  assert.equal(state.screen, "admin");
  assert.equal(state.csrfToken, "new-test-csrf");
  assert.equal(router.currentRoute.value.path, "/admin");
  assert.equal(state.errorMessage, "");
});

test("a current 401 resets the page without leaving an error or loading spinner", async () => {
  await mount("/admin/operations");
  serverModel.serverForm.serverPassword = "private-test-password";
  handler = () => Promise.resolve(json({ code: "AUTH_REQUIRED" }, 401));
  await operationsModel.loadOperations(); await nextTurn();
  assert.equal(state.screen, "login");
  assert.equal(serverModel.serverForm.serverPassword, "");
  assert.equal(operationsModel.operations.diagnostics.version, "");
  assert.equal(operationsModel.operationsLoading, false);
  assert.equal(state.errorMessage, "");
  assert.equal(router.currentRoute.value.path, "/admin/login");
});

test("unmounting during a backup download cannot trigger a late file download", async () => {
  await mount("/admin/operations");
  const backup = deferred(); let downloads = 0;
  global("document", { createElement() { downloads++; return { click() {} }; } });
  handler = path => path === "/backup" ? backup.promise : Promise.resolve(json(defaults(path)));
  const pending = operationsModel.downloadBackup();
  app.unmount(); app = null;
  backup.resolve(new Response(new Uint8Array([0, 1, 255]))); await pending;
  assert.equal(downloads, 0);
  assert.equal(state.errorMessage, "");
});

test("skin mutations are serialized and failure restores the last saved default", async () => {
  await mount("/admin/skins");
  const save = deferred(); let calls = 0;
  handler = path => path === "/skins/default" ? (++calls, save.promise) : Promise.resolve(json(defaults(path)));
  skinsModel.skinDefaultId = "builtin.dark";
  const pending = skinsModel.saveSkinDefault();
  await skinsModel.saveSkinDefault();
  assert.equal(calls, 1);
  assert.equal(skinsModel.skinBusy, true);
  save.resolve(json({ code: "REQUEST_FAILED" }, 500)); await pending;
  assert.equal(skinsModel.skinDefaultId, "builtin.light");
  assert.equal(skinsModel.skinBusy, false);
  assert.ok(skinsModel.skinManagerError);
});

test("a settings response cannot restore probe metadata after the draft password changes", async () => {
  await mount();
  const save = deferred();
  handler = (path, init) => path === "/server" && init.method === "PUT" ? save.promise : Promise.resolve(json(defaults(path)));
  const pending = serverModel.saveServerSettings();
  serverModel.serverForm.passwordAction = "replace";
  serverModel.serverForm.serverPassword = "new-test-password";
  save.resolve(json({ ok: true, settings: settings({ lastTestAt: "2020-01-01T00:00:00Z", lastTestLatencyMs: 30 }) }));
  await pending;
  assert.equal(serverModel.serverForm.lastTestAt, null);
  assert.equal(serverModel.serverForm.lastTestLatencyMs, null);
});

test("a settings response cannot overwrite a newer probe completed during the save", async () => {
  await mount();
  const save = deferred();
  handler = (path, init) => path === "/server" && init.method === "PUT" ? save.promise : Promise.resolve(json(path === "/server/test"
    ? { ok: true, checkType: "protocol", passwordVerified: false, latencyMs: 10, serverName: "Current", requiresPassword: false } : defaults(path)));
  const pending = serverModel.saveServerSettings();
  await serverModel.testServerConnection();
  const testedAt = serverModel.serverForm.lastTestAt;
  save.resolve(json({ ok: true, settings: settings({ lastTestAt: "2020-01-01T00:00:00Z", lastTestLatencyMs: 30 }) }));
  await pending;
  assert.equal(serverModel.serverForm.lastTestAt, testedAt);
  assert.equal(serverModel.serverForm.lastTestLatencyMs, 10);
});

test("duplicate invite revocation sends one mutation", async () => {
  await mount("/admin/operations");
  const revoke = deferred(); let calls = 0;
  handler = path => path === "/invites/test/revoke" ? (++calls, revoke.promise) : Promise.resolve(json(defaults(path)));
  const pending = operationsModel.revokeInvite({ id: "test" });
  const duplicate = operationsModel.revokeInvite({ id: "test" });
  revoke.resolve(json({ ok: true }));
  await Promise.all([pending, duplicate]);
  assert.equal(calls, 1);
});
