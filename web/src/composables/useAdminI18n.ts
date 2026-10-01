import type { Ref } from "vue";
import type { SiteLanguage } from "../../../src/site-copy.js";
import type { AdminConnectionRecord, ManagedInvite } from "../../../src/shared/admin-responses.js";
import { copy, germanCopy, russianCopy, japaneseCopy, type AdminTranslationKey } from "../i18n/admin.js";

const translations: Record<SiteLanguage, Record<AdminTranslationKey, string>> = {
  zh: copy.zh, en: copy.en, de: germanCopy, ru: russianCopy, ja: japaneseCopy,
};
const locales: Record<SiteLanguage, string> = { zh: "zh-CN", en: "en-US", de: "de-DE", ru: "ru-RU", ja: "ja-JP" };
const sessionLabels: Record<string, AdminTranslationKey> = {
  connecting: "sessionConnecting", authenticating: "sessionAuthenticating", syncing: "sessionSyncing",
  connected: "sessionConnected", interrupted: "sessionInterrupted", reconnecting: "sessionReconnecting",
  disconnecting: "sessionDisconnecting", failed: "sessionFailed", idle: "sessionIdle",
};
const connectionLabels: Record<AdminConnectionRecord["status"], AdminTranslationKey> = {
  active: "connectionActive", connecting: "connectionConnecting", disconnected: "connectionDisconnected", failed: "connectionFailed",
};
const inviteLabels: Record<ManagedInvite["status"], AdminTranslationKey> = {
  active: "active", expired: "expired", exhausted: "exhausted", revoked: "revoked",
};
const eventLabels: Record<string, AdminTranslationKey> = {
  ADMIN_LOGIN_FAILED: "adminLoginFailedEvent", CONNECTION_TEST_SUCCEEDED: "connectionTestSucceededEvent", CONNECTION_TEST_FAILED: "connectionTestFailedEvent",
  ADMIN_LOGIN_SUCCEEDED: "loginEvent", ADMIN_LOGOUT: "logoutEvent", SETTINGS_CHANGED: "settingsEvent",
  ADMIN_INITIALIZED: "initializedEvent", LEGACY_CONFIG_IMPORTED: "importedEvent", CONNECTION_TEST: "testEvent",
};
const errorLabels: Record<string, AdminTranslationKey> = {
  INVALID_PASSWORD: "invalidPassword", INVALID_ADMIN_PASSWORD: "setupPasswordShort", PASSWORD_CHANGE_REQUIRED: "changePasswordLead", RATE_LIMITED: "rateLimited",
  INVALID_WEBRTC_PORT_RANGE: "invalidWebRtcPortRangeError", WEBRTC_PORT_LOCKED: "webRtcPortLockedError",
  INVALID_RELAY_NAME: "invalidRelayNameError", INVALID_RELAY_TARGET: "invalidRelayTargetError", INVALID_RELAY_TOKEN: "invalidRelayTokenError",
  INVALID_TARGET: "invalidTargetError", PING_UNAVAILABLE: "icmpUnavailableError", HOST_NOT_FOUND: "probeHostNotFoundError",
  UNREACHABLE: "probeUnreachableError", TIMEOUT: "probeTimeoutError", PROTOCOL_NEGOTIATION_FAILED: "probeProtocolError",
  SERVER_REJECTED: "probeRejectedError", TARGET_NOT_ALLOWED: "targetNotAllowedError",
};
const connectionErrors: Record<string, AdminTranslationKey> = {
  PASSWORD_REQUIRED: "serverPasswordRequiredError", SERVER_PASSWORD_REQUIRED: "serverPasswordRequiredError",
  INVALID_PASSWORD: "invalidServerPasswordError", INVALID_SERVER_PASSWORD: "invalidServerPasswordError",
  INVALID_TARGET: "serverAddress", INVALID_NICKNAME: "invalidNicknameError", HOST_NOT_FOUND: "hostNotFoundError",
  UNREACHABLE: "networkUnreachableError", CONNECTION_REFUSED: "connectionRefusedError", CONNECTION_RESET: "connectionResetError",
  TIMEOUT: "networkTimeoutError", PROTOCOL_NEGOTIATION_FAILED: "protocolFailureError", SERVER_REJECTED: "serverRejectedError",
  PING_UNAVAILABLE: "pingUnavailableError", CONNECTION_FAILED: "connectionFailed",
};
const keyFor = (labels: Record<string, AdminTranslationKey>, code: string) => Object.hasOwn(labels, code) ? labels[code] : undefined;

export function useAdminI18n(language: Ref<SiteLanguage>) {
  function tr(key: AdminTranslationKey, vars: Record<string, string | number> = {}): string {
    let value = translations[language.value][key];
    for (const [name, replacement] of Object.entries(vars)) value = value.replaceAll(`{{${name}}}`, String(replacement));
    return value;
  }
  function formatDate(value: string | null) {
    return value ? new Intl.DateTimeFormat(locales[language.value], { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
  }
  function formatUptime(seconds: number) {
    return tr("uptimeText", { hours: Math.floor(seconds / 3600), minutes: Math.floor((seconds % 3600) / 60) });
  }
  function formatAge(seconds: number | null) {
    if (seconds == null) return "—";
    if (seconds < 60) return tr("ageSeconds", { seconds });
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return tr("ageMinutes", { minutes });
    return tr("ageHoursMinutes", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
  }
  function sessionStateLabel(state: string) { const key = keyFor(sessionLabels, state); return key ? tr(key) : state; }
  function connectionStatusLabel(status: AdminConnectionRecord["status"]) { return tr(connectionLabels[status]); }
  function inviteStatusLabel(status: ManagedInvite["status"]) { return tr(inviteLabels[status]); }
  function eventName(event: string) {
    const key = keyFor(eventLabels, event);
    return key ? tr(key) : language.value === "zh" ? tr("systemEvent") : event.replaceAll("_", " ");
  }
  function errorText(code?: string) { return tr(keyFor(errorLabels, code || "") ?? "requestFailed"); }
  function connectionFailureText(code?: string) { const key = keyFor(connectionErrors, code || ""); return key ? tr(key) : errorText(code); }
  return { tr, formatDate, formatUptime, formatAge, sessionStateLabel, connectionStatusLabel, inviteStatusLabel, eventName, errorText, connectionFailureText };
}
