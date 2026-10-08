export interface MobileViewport {
  height: number;
  top: number;
  keyboardOpen: boolean;
}

/** Follow the visible area in browsers/WebViews that overlay the soft keyboard. */
export function observeMobileViewport(win: Window, update: (viewport: MobileViewport) => void): () => void {
  const viewport = win.visualViewport;
  let baselineHeight = win.innerHeight;
  let baselineWidth = win.innerWidth;
  let frame = 0;
  let disposed = false;

  const measure = () => {
    frame = 0;
    if (disposed) return;
    const active = win.document.activeElement;
    const editing = Boolean(active?.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]), textarea, [contenteditable="true"]'));
    const zoomed = viewport && Math.abs(viewport.scale - 1) > 0.01;
    // Pinch zoom must not be interpreted as a keyboard or shrink the page itself.
    const height = Math.round(!zoomed && viewport ? viewport.height : win.innerHeight);
    if (!editing || baselineWidth !== win.innerWidth) {
      baselineHeight = win.innerHeight;
      baselineWidth = win.innerWidth;
    }
    update({
      height,
      top: !zoomed && viewport ? Math.round(viewport.offsetTop) : 0,
      keyboardOpen: !zoomed && editing && baselineHeight - height > 120,
    });
  };
  const schedule = () => { if (!disposed && !frame) frame = win.requestAnimationFrame(measure); };
  win.addEventListener("resize", schedule);
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  win.document.addEventListener("focusin", schedule);
  win.document.addEventListener("focusout", schedule);
  measure();
  return () => {
    disposed = true;
    win.cancelAnimationFrame(frame);
    win.removeEventListener("resize", schedule);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    win.document.removeEventListener("focusin", schedule);
    win.document.removeEventListener("focusout", schedule);
  };
}
