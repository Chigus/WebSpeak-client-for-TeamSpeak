import { onMounted, onUnmounted, type Ref } from "vue";

export function useDialogFocus(dialog: Ref<HTMLElement | null>, close: () => void, fallbackFocus?: () => HTMLElement | null) {
  let previousFocus: HTMLElement | null = null;
  onMounted(() => {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const autofocus = dialog.value?.querySelector<HTMLElement>("[autofocus]:not(:disabled)");
    (autofocus ?? dialog.value)?.focus();
  });
  onUnmounted(() => {
    const target = previousFocus?.isConnected && previousFocus !== document.body ? previousFocus : fallbackFocus?.();
    target?.focus();
  });

  function onDialogKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab" && dialog.value) {
      const controls = Array.from(dialog.value.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], audio[controls], [tabindex="0"]',
      )).filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
      const current = controls.indexOf(document.activeElement as HTMLElement);
      if (!controls.length || current < 0 || (event.shiftKey ? current === 0 : current === controls.length - 1)) {
        event.preventDefault();
        (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
      }
    }
  }
  return { onDialogKeydown };
}
