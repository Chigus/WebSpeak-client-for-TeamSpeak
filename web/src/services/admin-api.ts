import { adminResponses, type AdminResponseReader } from "../../../src/shared/admin-responses.js";
import type { AdminSettingsInput, ManagedInviteInput } from "../../../src/shared/admin-inputs.js";

export class AdminApiError extends Error {
  constructor(readonly code: string, readonly status = 0, message = code) {
    super(message);
    this.name = "AdminApiError";
  }
}

interface AdminApiOptions {
  csrfToken(): string;
  onUnauthorized?(): void;
  fetch?: typeof fetch;
}

export function createAdminApi(options: AdminApiOptions) {
  const fetcher = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  async function transport(path: string, init: RequestInit = {}, authenticated = true): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    if (init.method && init.method !== "GET") {
      const token = authenticated ? options.csrfToken() : "";
      if (token) headers.set("x-csrf-token", token);
    }
    let response: Response;
    try {
      response = await fetcher(`/api/admin${path}`, { ...init, headers });
    } catch {
      throw new AdminApiError("REQUEST_FAILED");
    }
    // Notify even if a proxy returned HTML instead of a JSON error body.
    if (response.status === 401 && authenticated) options.onUnauthorized?.();
    if (!response.ok) {
      const value: unknown = await response.json().catch(() => undefined);
      const code = value && typeof value === "object" && "code" in value && typeof value.code === "string" && value.code
        ? value.code : "REQUEST_FAILED";
      const message = value && typeof value === "object" && "message" in value && typeof value.message === "string" ? value.message : code;
      throw new AdminApiError(code, response.status, message);
    }
    return response;
  }
  async function decode<T>(response: Response, read: AdminResponseReader<T>): Promise<T> {
    const value: unknown = await response.json().catch(() => undefined);
    try { return read(value); }
    catch { throw new AdminApiError("INVALID_ADMIN_RESPONSE", response.status); }
  }
  async function request<T>(path: string, read: AdminResponseReader<T>, method = "GET", body?: unknown, authenticated = true): Promise<T> {
    const response = await transport(path, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }, authenticated);
    return decode(response, read);
  }

  return {
    session: () => request("/session", adminResponses.session),
    login: (username: string, password: string) => request("/login", adminResponses.login, "POST", { username, password }, false),
    changePassword: (newPassword: string) => request("/change-password", adminResponses.ok, "POST", { newPassword }),
    logout: () => request("/logout", adminResponses.ok, "POST", {}),
    overview: () => request("/overview", adminResponses.overview),
    settings: () => request("/server", adminResponses.settings),
    saveSettings: (body: AdminSettingsInput) => request("/server", adminResponses.savedSettings, "PUT", body),
    probe: (body: Pick<AdminSettingsInput, "target" | "serverPassword" | "passwordAction">) => request("/server/test", adminResponses.probe, "POST", body),
    sessions: () => request("/sessions", adminResponses.sessions),
    terminateSession: (id: string) => request(`/sessions/${encodeURIComponent(id)}/terminate`, adminResponses.ok, "POST", {}),
    invites: () => request("/invites", adminResponses.invites),
    createInvite: (body: ManagedInviteInput) => request("/invites", adminResponses.createdInvite, "POST", body),
    revokeInvite: (id: string) => request(`/invites/${encodeURIComponent(id)}/revoke`, adminResponses.ok, "POST", {}),
    diagnostics: () => request("/diagnostics", adminResponses.diagnostics),
    logs: () => request("/logs?limit=100", adminResponses.logs),
    audit: () => request("/audit?limit=50", adminResponses.audit),
    skins: () => request("/skins", adminResponses.skins),
    setDefaultSkin: (id: string) => request("/skins/default", adminResponses.defaultSkin, "PUT", { id }),
    setSkinEnabled: (id: string, enabled: boolean) => request(`/skins/${encodeURIComponent(id)}/enabled`, adminResponses.updatedSkin, "PUT", { enabled }),
    deleteSkin: (id: string) => request(`/skins/${encodeURIComponent(id)}`, adminResponses.ok, "DELETE", {}),
    async uploadSkin(file: File, confirmReplace?: (id: string) => boolean) {
      const { importSkinPack } = await import("./skin-pack.js");
      const skin = await importSkinPack(file);
      if (confirmReplace && !confirmReplace(skin.id)) return null;
      const response = await transport(`/skins/${encodeURIComponent(skin.id)}`, {
        method: "PUT", headers: { "content-type": "application/octet-stream" }, body: file,
      });
      return (await decode(response, adminResponses.uploadedSkin)).skin;
    },
    async backup() { return (await transport("/backup", { headers: { accept: "application/octet-stream" } })).blob(); },
    dismissLegacyNotice: () => request("/legacy-import/dismiss", adminResponses.ok, "POST", {}),
  };
}
