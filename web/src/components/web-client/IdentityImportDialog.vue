<template>
  <div
    class="modal-backdrop identity-import-backdrop"
    @click.self="emit('close')"
    tabindex="-1"
  >
    <section
      ref="dialog"
      class="identity-import-modal"
      data-ws-part="home.identity-import-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="identity-import-title"
      tabindex="-1"
      @keydown.esc="emit('close')"
    >
      <header
        class="identity-import-header"
        data-ws-part="home.identity-import.header"
      >
        <div
          ><h2 id="identity-import-title">{{ t("identityImportTitle") }}</h2
          ><p>{{ t("identityImportDescription") }}</p></div
        >
        <button
          type="button"
          class="qq-modal-close identity-import-close"
          data-ws-part="home.identity-import.close"
          :aria-label="t('close')"
          :disabled="busy"
          @click="emit('close')"
          ><Icon
            name="close"
            :size="18"
        /></button>
      </header>
      <textarea
        v-model="text"
        class="identity-import-textarea"
        data-ws-part="home.identity-import.textarea"
        :aria-label="t('identityImportTitle')"
        :placeholder="t('identityImportPlaceholder')"
        :disabled="busy"
        maxlength="131072"
        spellcheck="false"
      ></textarea>
      <div
        :class="['identity-drop-zone', { active: dropActive }]"
        data-ws-part="home.identity-import.drop-zone"
        role="group"
        :aria-disabled="busy"
        :tabindex="busy ? -1 : 0"
        @click="chooseFile"
        @keydown.enter.prevent="chooseFile"
        @keydown.space.prevent="chooseFile"
        @dragover.prevent="dropActive = !busy"
        @dragleave.prevent="dropActive = false"
        @drop.prevent.stop="onDrop"
      >
        <Icon
          name="paperclip"
          :size="18"
        /><span>{{ t("identityDropZone") }}</span>
        <button
          type="button"
          class="identity-file-button"
          data-ws-part="home.identity-import.file-button"
          :disabled="busy"
          @click.stop="chooseFile"
          >{{ t("identityChooseFile") }}</button
        >
      </div>
      <input
        ref="fileInput"
        class="identity-file-input"
        type="file"
        accept=".ini,.txt,.identity,.wsi,text/plain"
        :disabled="busy"
        @change="onFileChange"
      />
      <p
        v-if="error"
        class="identity-import-error"
        data-ws-part="home.identity-import.error"
        role="alert"
        >{{ error }}</p
      >
      <p
        class="identity-import-security"
        data-ws-part="home.identity-import.security"
        ><Icon
          name="lock"
          :size="14"
        />
        {{ t("identityImportSecurity") }}</p
      >
      <footer
        class="identity-import-footer"
        data-ws-part="home.identity-import.footer"
      >
        <button
          type="button"
          class="text-button identity-import-cancel"
          data-ws-part="home.identity-import.cancel"
          :disabled="busy"
          @click="emit('close')"
          >{{ t("identityImportCancel") }}</button
        >
        <button
          type="button"
          class="primary-button identity-import-submit"
          data-ws-part="home.identity-import.submit"
          :disabled="busy || reading || !text.trim()"
          @click="emit('submit')"
          >{{ busy ? t("connecting") : t("identityImportSubmit") }}</button
        >
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import Icon from "../Icon.vue";

const props = defineProps<{ busy: boolean; reading: boolean; error: string; t: (key: string) => string }>();
const text = defineModel<string>({ required: true });
const emit = defineEmits<{ close: []; submit: []; file: [file: File] }>();
const dialog = ref<HTMLElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const dropActive = ref(false);
let previousFocus: HTMLElement | null = null;

onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialog.value?.focus();
});
onUnmounted(() => { if (previousFocus?.isConnected) previousFocus.focus(); });
function chooseFile() { if (!props.busy) fileInput.value?.click(); }
function onFileChange(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file && !props.busy) emit("file", file);
}
function onDrop(event: DragEvent) {
  dropActive.value = false;
  const file = event.dataTransfer?.files[0];
  if (file && !props.busy) emit("file", file);
}
</script>
