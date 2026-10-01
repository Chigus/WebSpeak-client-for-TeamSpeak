import { onScopeDispose, reactive, ref, type Ref } from "vue";
import type { AdminSession, ManagedInvite, AdminLog, AdminConnectionRecord } from "../../../src/shared/admin-responses.js";
import type { copy } from "../i18n/admin.js";
import { isAdminRequestCancelled, type AdminApi } from "../services/admin-api.js";
import { createAdminRequests } from "../services/admin-requests.js";

interface Options {
  api: AdminApi;
  errorMessage: Ref<string>;
  errorText(code?: string): string;
  tr(key: keyof typeof copy.zh, vars?: Record<string, string | number>): string;
  refreshOverview(): Promise<void>;
}

export function useAdminOperations(options: Options) {
  const requests = createAdminRequests();
  const operationsLoading = ref(false), terminatingSession = ref(""), inviteSubmitting = ref(false);
  const revokingInvites = reactive(new Set<string>());
  const inviteForm = reactive({ channel: "", expiresInHours: 24, maxUses: 0 });
  const createdInvite = ref<{ token: string; link: string } | null>(null);
  const operations = reactive({ sessions: [] as AdminSession[], invites: [] as ManagedInvite[],
    diagnostics: { version: "", node: "", platform: "", arch: "", schemaVersion: 0, createdSessions: 0 },
    logs: { available: false, entries: [] as AdminLog[], sessions: [] as AdminConnectionRecord[] }, audit: [] as Array<{ event: string; createdAt: string }> });
  let noticeTimer: number | undefined;
  function cancelRequests() {
    requests.reset();
    operationsLoading.value = false; terminatingSession.value = ""; inviteSubmitting.value = false;
    revokingInvites.clear();
    if (noticeTimer !== undefined) window.clearTimeout(noticeTimer);
    noticeTimer = undefined;
  }
  function reset() {
    cancelRequests();
    createdInvite.value = null;
    operations.sessions = []; operations.invites = []; operations.audit = [];
    operations.logs = { available: false, entries: [], sessions: [] };
    operations.diagnostics = { version: "", node: "", platform: "", arch: "", schemaVersion: 0, createdSessions: 0 };
    Object.assign(inviteForm, { channel: "", expiresInHours: 24, maxUses: 0 });
  }
  onScopeDispose(reset);
  function report(error: unknown) {
    if (!isAdminRequestCancelled(error)) options.errorMessage.value = options.errorText((error as { code?: string }).code);
  }
  async function loadOperations() {
    const request = requests.begin("load");
    operationsLoading.value = true;
    try {
      const [sessions, invites, diagnostics, logs, audit] = await Promise.all([
        options.api.sessions(request.signal), options.api.invites(request.signal), options.api.diagnostics(request.signal), options.api.logs(request.signal), options.api.audit(request.signal),
      ]);
      if (!request.isCurrent()) return;
      operations.sessions = sessions.sessions;
      operations.invites = invites.invites;
      operations.diagnostics = { ...diagnostics.gateway, schemaVersion: diagnostics.database.schemaVersion, createdSessions: diagnostics.sessions.created };
      operations.logs = logs;
      operations.audit = audit.events;
    } catch (error) { if (request.isCurrent()) report(error); }
    finally { if (request.isCurrent()) operationsLoading.value = false; request.finish(); }
  }
  async function terminateSession(session: AdminSession) {
    if (terminatingSession.value || !window.confirm(options.tr("confirmTerminate", { nickname: session.nickname }))) return;
    const request = requests.begin("terminate");
    terminatingSession.value = session.id; options.errorMessage.value = "";
    try {
      await options.api.terminateSession(session.id, request.signal);
      if (request.isCurrent()) await Promise.all([loadOperations(), options.refreshOverview()]);
    } catch (error) { if (request.isCurrent()) report(error); }
    finally { if (request.isCurrent()) terminatingSession.value = ""; request.finish(); }
  }
  async function createInvite() {
    if (inviteSubmitting.value) return;
    const request = requests.begin("invite"), channel = inviteForm.channel;
    inviteSubmitting.value = true; options.errorMessage.value = ""; createdInvite.value = null;
    try {
      const result = await options.api.createInvite({ ...inviteForm }, request.signal);
      if (!request.isCurrent()) return;
      createdInvite.value = { token: result.token, link: `${location.origin}/?invite=${encodeURIComponent(result.token)}` };
      if (inviteForm.channel === channel) inviteForm.channel = "";
      await loadOperations();
    } catch (error) { if (request.isCurrent()) report(error); }
    finally { if (request.isCurrent()) inviteSubmitting.value = false; request.finish(); }
  }
  async function revokeInvite(invite: ManagedInvite) {
    if (revokingInvites.has(invite.id) || !window.confirm(options.tr("confirmRevoke"))) return;
    const request = requests.begin(`revoke:${invite.id}`);
    revokingInvites.add(invite.id);
    try {
      await options.api.revokeInvite(invite.id, request.signal);
      if (request.isCurrent()) await loadOperations();
    } catch (error) { if (request.isCurrent()) report(error); }
    finally { if (request.isCurrent()) revokingInvites.delete(invite.id); request.finish(); }
  }
  async function copyInviteLink() {
    if (!createdInvite.value) return;
    const request = requests.begin("copy");
    try {
      await navigator.clipboard.writeText(createdInvite.value.link);
      if (!request.isCurrent()) return;
      const message = options.tr("copiedLink");
      options.errorMessage.value = message;
      if (noticeTimer !== undefined) window.clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => { if (options.errorMessage.value === message) options.errorMessage.value = ""; noticeTimer = undefined; }, 2200);
    } catch (error) { if (request.isCurrent()) report(error); }
    finally { request.finish(); }
  }
  async function downloadBackup() {
    const request = requests.begin("backup");
    try {
      const blob = await options.api.backup(request.signal);
      if (!request.isCurrent()) return;
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = `webspeak-backup-${new Date().toISOString().slice(0, 10)}.db`; anchor.click();
      } finally { URL.revokeObjectURL(url); }
      await loadOperations();
    } catch (error) { if (request.isCurrent()) report(error); }
    finally { request.finish(); }
  }
  return { operations, operationsLoading, terminatingSession, inviteSubmitting, revokingInvites, inviteForm, createdInvite,
    loadOperations, terminateSession, createInvite, revokeInvite, copyInviteLink, downloadBackup, cancelRequests, reset };
}
