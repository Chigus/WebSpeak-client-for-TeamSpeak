import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import express from "express";
import { WebSpeakDatabase } from "../../src/persistence/database.js";
import type { Logger } from "../../src/logger.js";
import { AdminService } from "../../src/admin/admin-service.js";
import { AdminSessionStore } from "../../src/admin/admin-session.js";
import { createAdminRouter } from "../../src/admin/admin-router.js";
import { createAdminApi } from "../src/services/admin-api.js";
import { adminResponses } from "../../src/shared/admin-responses.js";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

test("browser admin API consumes the actual HTTP router and preserves keep/replace/remove secrets", async t => {
  const directory = mkdtempSync(join(tmpdir(), "webspeak-admin-api-"));
  const database = new WebSpeakDatabase(join(directory, "test.db"));
  t.after(() => {
    database.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.includes("webspeak-admin-api-"));
    rmSync(directory, { recursive: true, force: true });
  });
  const service = new AdminService(database, Buffer.alloc(32, 7), logger, join(directory, "absent-config.json"), undefined, "test-version");
  await service.initialize();
  await service.changePassword("test-only-admin-password");
  const app = express();
  app.use(express.json());
  app.use("/api/admin", createAdminRouter({ service, sessions: new AdminSessionStore(), logger, getActiveSessions: () => 0, getPeakSessions: () => 0, startedAt: Date.now(), version: "test-version" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  let cookie = "";
  let csrf = "";
  const api = createAdminApi({ csrfToken: () => csrf, fetch: async (path, init) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", origin);
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(`${origin}${path}`, { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return response;
  } });
  assert.equal((await api.session()).authenticated, false);
  csrf = (await api.login("admin", "test-only-admin-password")).csrfToken;
  assert.equal((await api.session()).authenticated, true);
  assert.equal((await api.overview()).gateway.version, "test-version");
  const original = await api.settings();
  for (const passwordAction of ["replace", "keep", "remove"] as const) {
    const body = {
      ...original, passwordAction, ...(passwordAction === "replace" ? { serverPassword: "test-server-password" } : {}),
      relayNodes: [{ id: "relay-test", name: "Test relay", target: "relay.example.invalid:1234", enabled: passwordAction !== "remove", tokenAction: passwordAction, ...(passwordAction === "replace" ? { token: "test-relay-token" } : {}) }],
    };
    const saved = await api.saveSettings(body);
    assert.equal(saved.settings.hasPassword, passwordAction !== "remove");
    assert.equal(service.getConnectionPolicy().serverPassword, passwordAction === "remove" ? "" : "test-server-password");
    assert.equal(saved.settings.relayNodes[0].hasToken, passwordAction !== "remove");
    assert.equal(service.getAccelerationRelayOptions()[0]?.token, passwordAction === "remove" ? undefined : "test-relay-token");
  }
  const settings = service.getAdminSettings();
  assert.deepEqual(adminResponses.settings({ ...settings, passwordAction: "remove", serverPassword: "injected" }), settings);
  const created = await api.createInvite({ channel: "Lobby", expiresInHours: 1, maxUses: 1 });
  assert.equal((await api.invites()).invites[0].id, created.invite.id);
  await api.revokeInvite(created.invite.id);
  assert.equal((await api.invites()).invites[0].status, "revoked");
  assert.deepEqual((await api.sessions()).sessions, []);
  assert.equal((await api.diagnostics()).gateway.version, "test-version");
  assert.equal((await api.logs()).available, false);
  assert.ok((await api.audit()).events.length > 0);
  assert.equal((await api.skins()).defaultSkinId, "builtin.light");
  const backup = Buffer.from(await (await api.backup()).arrayBuffer());
  assert.equal(backup.subarray(0, 16).toString(), "SQLite format 3\0");
  await api.logout();
  assert.equal((await api.session()).authenticated, false);
});
