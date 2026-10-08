import assert from "node:assert/strict";
import { test } from "node:test";
import { observeMobileViewport, type MobileViewport } from "./mobile-viewport.js";

function browser(hasVisualViewport = true) {
  let editing = false;
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
  const document = Object.assign(new EventTarget(), { activeElement: { matches: () => editing } });
  const win = Object.assign(new EventTarget(), {
    innerHeight: 800, innerWidth: 390, document,
    visualViewport: hasVisualViewport ? viewport : null,
    requestAnimationFrame(callback: FrameRequestCallback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  });
  const updates: MobileViewport[] = [];
  const stop = observeMobileViewport(win as unknown as Window, value => updates.push(value));
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); };
  const focus = (value: boolean) => { editing = value; document.dispatchEvent(new Event(value ? "focusin" : "focusout")); };
  const resize = (height: number) => { viewport.height = height; viewport.dispatchEvent(new Event("resize")); flush(); };
  return { win, viewport, document, updates, frames, stop, flush, focus, resize };
}

test("overlay keyboards track visible height and offset, then restore on dismissal", () => {
  const b = browser();
  b.focus(true);
  b.viewport.offsetTop = 25;
  b.resize(460);
  assert.deepEqual(b.updates.at(-1), { height: 460, top: 25, keyboardOpen: true });
  b.focus(false);
  b.viewport.offsetTop = 0;
  b.resize(800);
  assert.deepEqual(b.updates.at(-1), { height: 800, top: 0, keyboardOpen: false });
  b.stop();
});

test("content-resizing WebViews preserve the pre-keyboard baseline, including without visualViewport", () => {
  for (const supported of [true, false]) {
    const b = browser(supported);
    b.focus(true);
    b.win.innerHeight = b.viewport.height = 450;
    b.win.dispatchEvent(new Event("resize"));
    b.flush();
    assert.deepEqual(b.updates.at(-1), { height: 450, top: 0, keyboardOpen: true });
    b.stop();
  }
});

test("pinch zoom and orientation changes do not masquerade as a keyboard", () => {
  const b = browser();
  b.focus(true);
  b.viewport.scale = 2;
  b.viewport.offsetTop = 100;
  b.resize(400);
  assert.deepEqual(b.updates.at(-1), { height: 800, top: 0, keyboardOpen: false });
  b.viewport.scale = 1;
  b.viewport.offsetTop = 0;
  b.win.innerWidth = 800;
  b.win.innerHeight = 390;
  b.resize(390);
  assert.equal(b.updates.at(-1)?.keyboardOpen, false);
  b.stop();
});

test("viewport events coalesce and disposal removes listeners and pending work", () => {
  const b = browser();
  const signalAll = () => {
    b.win.dispatchEvent(new Event("resize"));
    b.viewport.dispatchEvent(new Event("resize"));
    b.viewport.dispatchEvent(new Event("scroll"));
    b.focus(true);
    b.focus(false);
  };
  signalAll();
  assert.equal(b.frames.size, 1);
  b.flush();
  assert.equal(b.updates.length, 2);
  signalAll();
  b.stop();
  signalAll();
  assert.equal(b.frames.size, 0);
  b.flush();
  assert.equal(b.updates.length, 2);
});
