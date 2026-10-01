import assert from "node:assert/strict";
import test from "node:test";
import { AdminApiError, createAdminApi } from "./admin-api.js";
import { adminResponses } from "../../../src/shared/admin-responses.js";
import { strToU8, zipSync } from "fflate";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("an old authentication failure cannot expire a replacement admin session", async () => {
  let token = "old-session";
  let expired = 0;
  const response = deferred<Response>();
  const api = createAdminApi({ csrfToken: () => token, onUnauthorized: () => expired++, fetch: () => response.promise });
  const pending = api.overview();
  token = "replacement-session";
  response.resolve(json({ code: "AUTH_REQUIRED" }, 401));
  await assert.rejects(pending, error => error instanceof AdminApiError && error.code === "REQUEST_CANCELLED");
  assert.equal(expired, 0);
});

test("invalidating while decoding JSON aborts the old work but permits a fresh request", async () => {
  const body = deferred<unknown>(), decoding = deferred<void>();
  let signal: AbortSignal | null | undefined;
  let calls = 0;
  const api = createAdminApi({ csrfToken: () => "same-session", fetch: async (_url, init) => {
    const response = json({ ok: true });
    if (++calls === 1) {
      signal = init?.signal;
      response.json = () => { decoding.resolve(); return body.promise; };
    }
    return response;
  } });
  const pending = api.changePassword("test-password");
  await decoding.promise;
  api.invalidate();
  assert.equal(signal?.aborted, true);
  body.resolve({ ok: true });
  await assert.rejects(pending, error => error instanceof AdminApiError && error.code === "REQUEST_CANCELLED");
  assert.deepEqual(await api.changePassword("replacement-test-password"), { ok: true });
});

test("external cancellation skips fetch when already aborted and ignores a late 401", async () => {
  const controller = new AbortController(), response = deferred<Response>();
  let calls = 0, expired = 0;
  const api = createAdminApi({ csrfToken: () => "same-session", onUnauthorized: () => expired++, fetch: () => { calls++; return response.promise; } });
  const pending = api.overview(controller.signal);
  controller.abort();
  response.resolve(json({ code: "AUTH_REQUIRED" }, 401));
  await assert.rejects(pending, error => error instanceof AdminApiError && error.code === "REQUEST_CANCELLED");
  await assert.rejects(api.overview(controller.signal), error => error instanceof AdminApiError && error.code === "REQUEST_CANCELLED");
  assert.equal(expired, 0);
  assert.equal(calls, 1);
});

test("invalidating during a backup body read prevents publishing its bytes", async () => {
  const body = deferred<Blob>(), decoding = deferred<void>();
  const api = createAdminApi({ csrfToken: () => "same-session", fetch: async () => {
    const response = new Response();
    response.blob = () => { decoding.resolve(); return body.promise; };
    return response;
  } });
  const pending = api.backup();
  await decoding.promise;
  api.invalidate();
  body.resolve(new Blob(["test backup"]));
  await assert.rejects(pending, error => error instanceof AdminApiError && error.code === "REQUEST_CANCELLED");
});

test("a successful response from an old session cannot publish into a new session", async () => {
  let token = "old-session";
  const response = deferred<Response>();
  const api = createAdminApi({ csrfToken: () => token, fetch: () => response.promise });
  const pending = api.dismissLegacyNotice();
  token = "replacement-session";
  response.resolve(json({ ok: true }));
  await assert.rejects(pending, error => error instanceof AdminApiError && error.code === "REQUEST_CANCELLED");
});

test("skin validation finishing after the session changes cannot submit an upload", async () => {
  let token = "old-session";
  let requests = 0;
  let confirmations = 0;
  const skin = { schemaVersion: 1, id: "late-test-skin", name: "Test", version: "1.0.0", author: "Test", license: "MIT", minAppVersion: "0.2.4", entry: "skin.css" };
  const file = new File([zipSync({ "manifest.json": strToU8(JSON.stringify(skin)), "skin.css": strToU8('[data-ws-part="home"] { color: #123456; }') })], "test.wskin");
  const bytes = await file.arrayBuffer();
  const validation = deferred<ArrayBuffer>();
  file.arrayBuffer = () => validation.promise;
  const api = createAdminApi({ csrfToken: () => token, fetch: async () => { requests++; return json({}); } });
  const pending = api.uploadSkin(file, () => { confirmations++; return true; });
  token = "replacement-session";
  validation.resolve(bytes);
  await assert.rejects(pending, error => error instanceof AdminApiError && error.code === "REQUEST_CANCELLED");
  assert.equal(requests, 0);
  assert.equal(confirmations, 0);
});

test("admin mutations read the current CSRF token and encode resource IDs", async () => {
  let token = "first-test-token";
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const api = createAdminApi({ csrfToken: () => token, fetch: async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return json({ ok: true });
  } });
  await api.changePassword("test-password");
  token = "replacement-test-token";
  await api.revokeInvite("a/b ?");
  assert.equal(new Headers(calls[0].init.headers).get("x-csrf-token"), "first-test-token");
  assert.equal(new Headers(calls[1].init.headers).get("x-csrf-token"), token);
  assert.equal(calls[1].url, "/api/admin/invites/a%2Fb%20%3F/revoke");
  assert.equal(calls[0].init.body, JSON.stringify({ newPassword: "test-password" }));
});

test("skin uploads preserve the binary body, validate the package and honor replacement cancellation", async () => {
  const skin = { schemaVersion: 1, id: "api-test-skin", name: "Test", version: "1.0.0", author: "Test", license: "MIT", minAppVersion: "0.2.4", entry: "skin.css" };
  const file = new File([zipSync({ "manifest.json": strToU8(JSON.stringify(skin)), "skin.css": strToU8('[data-ws-part="home"] { color: #123456; }') })], "test.wskin");
  let requests = 0;
  const api = createAdminApi({ csrfToken: () => "upload-test-token", fetch: async (url, init) => {
    requests++;
    assert.equal(url, "/api/admin/skins/api-test-skin");
    assert.equal(init?.body, file);
    assert.equal(new Headers(init.headers).get("content-type"), "application/octet-stream");
    assert.equal(new Headers(init.headers).get("x-csrf-token"), "upload-test-token");
    return json({ ok: true, skin: { ...skin, installedAt: 1 } });
  } });
  assert.equal(await api.uploadSkin(file, () => false), null);
  assert.equal(requests, 0);
  assert.equal((await api.uploadSkin(file))?.id, skin.id);
  assert.equal(requests, 1);
  await assert.rejects(api.uploadSkin(new File(["not a zip"], "broken.wskin")));
  assert.equal(requests, 1);
});

test("backup downloads use the common expired-session path and retain binary data", async () => {
  let expired = 0;
  const api = createAdminApi({ csrfToken: () => "", onUnauthorized: () => expired++, fetch: async () => new Response("Expired", { status: 401 }) });
  await assert.rejects(api.backup(), error => error instanceof AdminApiError && error.status === 401);
  assert.equal(expired, 1);
  const binary = createAdminApi({ csrfToken: () => "", fetch: async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("accept"), "application/octet-stream");
    return new Response(new Uint8Array([0, 1, 255]));
  } });
  assert.deepEqual(new Uint8Array(await (await binary.backup()).arrayBuffer()), new Uint8Array([0, 1, 255]));
});

test("login errors retain their code without expiring an unrelated session or sending CSRF", async () => {
  let expired = 0;
  const api = createAdminApi({ csrfToken: () => "private-test-token", onUnauthorized: () => expired++, fetch: async (_url, init) => {
    assert.equal(new Headers(init?.headers).has("x-csrf-token"), false);
    return json({ code: "INVALID_PASSWORD" }, 401);
  } });
  await assert.rejects(api.login("admin", "incorrect"), error => error instanceof AdminApiError && error.code === "INVALID_PASSWORD" && error.status === 401);
  assert.equal(expired, 0);
});

test("expired sessions notify the page even when the error response is not JSON", async () => {
  let expired = 0;
  const api = createAdminApi({ csrfToken: () => "", onUnauthorized: () => expired++, fetch: async () => new Response("Proxy authentication required", { status: 401 }) });
  await assert.rejects(api.overview(), error => error instanceof AdminApiError && error.status === 401);
  assert.equal(expired, 1);
});

test("successful HTTP status cannot turn an incomplete settings or login response into success", async () => {
  for (const value of [{}, null, [], { ok: true }, { ok: true, settings: { target: "voice.example:9987" } }]) {
    const api = createAdminApi({ csrfToken: () => "", fetch: async () => json(value) });
    await assert.rejects(api.settings(), error => error instanceof AdminApiError && error.code === "INVALID_ADMIN_RESPONSE");
    await assert.rejects(api.login("admin", "test"), error => error instanceof AdminApiError && error.code === "INVALID_ADMIN_RESPONSE");
  }
  assert.throws(() => adminResponses.session({ authenticated: true, mustChangePassword: false }), /INVALID_ADMIN_RESPONSE/);
  assert.deepEqual(adminResponses.session({ authenticated: false }), { authenticated: false, mustChangePassword: undefined, csrfToken: undefined });
});

test("nested malformed list entries are rejected before replacing the current page snapshot", async () => {
  const api = createAdminApi({ csrfToken: () => "", fetch: async () => json({ sessions: [{ id: "incomplete" }] }) });
  await assert.rejects(api.sessions(), error => error instanceof AdminApiError && error.code === "INVALID_ADMIN_RESPONSE");
  assert.throws(() => adminResponses.logs({ available: true, sessions: [], entries: [{ timestamp: null, level: "INFO", message: "test", context: { nested: {} } }] }), /INVALID_ADMIN_RESPONSE/);
});

test("HTTP failures and network failures are normalized without exposing arbitrary response text", async () => {
  const failed = createAdminApi({ csrfToken: () => "", fetch: async () => json({ code: "WEBRTC_PORT_LOCKED" }, 409) });
  await assert.rejects(failed.dismissLegacyNotice(), error => error instanceof AdminApiError && error.code === "WEBRTC_PORT_LOCKED");
  const offline = createAdminApi({ csrfToken: () => "", fetch: async () => { throw new Error("private network details"); } });
  await assert.rejects(offline.overview(), error => error instanceof AdminApiError && error.message === "REQUEST_FAILED");
});
