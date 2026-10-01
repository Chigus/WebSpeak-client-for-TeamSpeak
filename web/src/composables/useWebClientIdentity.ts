import { onScopeDispose, ref, watch, type Ref } from "vue";
import { exportTeamSpeakIdentity, IdentityImportError, importIdentityText } from "../services/identity-import.js";

interface IdentityOptions {
  identityMaterial: Ref<string>;
  rememberIdentity: Ref<boolean>;
  t: (key: string) => string;
  showToast: (message: string) => void;
  parse?: (text: string) => Promise<string>;
  serialize?: (material: string) => Promise<string>;
}

/** Page-owned identity operations; the dialog only renders state and emits input. */
export function useWebClientIdentity({ identityMaterial, rememberIdentity, t, showToast,
  parse = importIdentityText, serialize = exportTeamSpeakIdentity }: IdentityOptions) {
  const open = ref(false);
  const text = ref("");
  const error = ref("");
  const busy = ref(false);
  const reading = ref(false);
  const exporting = ref(false);
  let generation = 0;
  let exportGeneration = 0;
  let identityRevision = 0;
  let disposed = false;
  const downloads = new Map<string, ReturnType<typeof setTimeout> | undefined>();
  const isCurrent = (operation: number) => !disposed && open.value && operation === generation;

  function invalidate() {
    generation++;
    reading.value = false;
    busy.value = false;
  }
  watch(text, () => { invalidate(); error.value = ""; }, { flush: "sync" });
  watch([identityMaterial, rememberIdentity], () => {
    identityRevision++;
    exportGeneration++;
    exporting.value = false;
  }, { flush: "sync" });

  function show() {
    if (disposed || busy.value) return;
    invalidate();
    text.value = "";
    error.value = "";
    open.value = true;
  }
  function close() {
    if (busy.value) return;
    invalidate();
    open.value = false;
  }
  function reset() {
    invalidate();
    identityRevision++;
    exportGeneration++;
    exporting.value = false;
    open.value = false;
    text.value = "";
    error.value = "";
    for (const url of downloads.keys()) releaseDownload(url);
  }
  async function readFile(file?: Pick<File, "size" | "arrayBuffer">) {
    if (!file || disposed || !open.value || busy.value) return;
    invalidate();
    const operation = generation;
    error.value = "";
    if (file.size > 128 * 1024) {
      error.value = t("identityImportErrorTooLarge");
      return;
    }
    reading.value = true;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isCurrent(operation)) return;
      let encoding = "utf-8";
      if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
      else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
      text.value = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      error.value = text.value.trim() ? "" : t("identityImportErrorEmpty");
    } catch {
      if (isCurrent(operation)) error.value = t("identityImportErrorMalformed");
    } finally {
      if (isCurrent(operation)) reading.value = false;
    }
  }
  async function submit() {
    if (disposed || !open.value || busy.value || reading.value) return;
    invalidate();
    const operation = generation;
    busy.value = true;
    error.value = "";
    try {
      const material = await parse(text.value);
      if (!isCurrent(operation)) return;
      invalidate();
      rememberIdentity.value = true;
      identityMaterial.value = material;
      open.value = false;
      text.value = "";
      showToast(t("identityImportSuccess"));
    } catch (failure) {
      if (!isCurrent(operation)) return;
      const code = failure instanceof IdentityImportError ? failure.code : "invalid-key";
      error.value = t(({
        empty: "identityImportErrorEmpty", "too-large": "identityImportErrorTooLarge",
        multiple: "identityImportErrorMultiple", malformed: "identityImportErrorMalformed",
        "invalid-key": "identityImportErrorInvalidKey", unsupported: "identityImportErrorUnsupported",
      } as const)[code]);
    } finally { if (isCurrent(operation)) busy.value = false; }
  }
  async function exportIdentity() {
    if (disposed || exporting.value || !rememberIdentity.value || !identityMaterial.value) return;
    const operation = ++exportGeneration;
    const current = () => !disposed && operation === exportGeneration;
    exporting.value = true;
    let url: string | undefined;
    let link: HTMLAnchorElement | undefined;
    try {
      const content = await serialize(identityMaterial.value);
      if (!current()) return;
      url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
      downloads.set(url, undefined);
      link = document.createElement("a");
      link.href = url;
      link.download = "webspeak-identity.ini";
      document.body.append(link);
      link.click();
      const downloadUrl = url;
      downloads.set(url, setTimeout(() => releaseDownload(downloadUrl), 1000));
      showToast(t("identityExportSuccess"));
    } catch {
      if (url) releaseDownload(url);
      if (current()) showToast(t("identityExportError"));
    } finally {
      try { link?.remove(); } catch { /* URL cleanup is independent of DOM removal. */ }
      if (current()) exporting.value = false;
    }
  }
  function releaseDownload(url: string) {
    if (!downloads.has(url)) return;
    clearTimeout(downloads.get(url));
    downloads.delete(url);
    try { URL.revokeObjectURL(url); } catch { /* Continue releasing other owned URLs. */ }
  }
  async function restore(load: () => Promise<string | null>) {
    if (disposed) return;
    const revision = ++identityRevision;
    try {
      const stored = await load();
      if (!disposed && revision === identityRevision && stored) {
        rememberIdentity.value = true;
        identityMaterial.value = stored;
      }
    } catch { /* Optional local storage cannot prevent a new browser session. */ }
  }
  onScopeDispose(() => { disposed = true; reset(); });
  return { open, text, error, busy, reading, exporting, show, close, reset, restore, readFile, submit, exportIdentity };
}
