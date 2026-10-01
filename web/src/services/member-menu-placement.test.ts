import assert from "node:assert/strict";
import { test } from "node:test";
import { placeMemberMenu, placeMemberSubmenu } from "./member-menu-placement.js";

test("the complete menu stays inside a short desktop window", () => {
  assert.deepEqual(placeMemberMenu({ x: 167, y: 309 }, { width: 188, height: 271 }, { width: 1280, height: 568 }), { x: 167, y: 285 });
});

test("a submenu near the bottom moves up without moving off the right edge", () => {
  assert.deepEqual(placeMemberSubmenu({ left: 180, right: 340, top: 507 }, { width: 220, height: 84 }, { width: 1280, height: 568 }), { x: 346, y: 472 });
});

test("a submenu opens to the left when the right side has no room", () => {
  assert.deepEqual(placeMemberSubmenu({ left: 1020, right: 1220, top: 200 }, { width: 220, height: 180 }, { width: 1280, height: 720 }), { x: 794, y: 200 });
});

test("oversized measured content remains reachable from the viewport inset", () => {
  assert.deepEqual(placeMemberMenu({ x: -40, y: 500 }, { width: 900, height: 600 }, { width: 800, height: 400 }), { x: 12, y: 12 });
});

test("placement uses rendered dimensions including CSS zoom", () => {
  const result = placeMemberMenu({ x: 1500, y: 800 }, { width: 282, height: 406.5 }, { width: 1600, height: 900 });
  assert.deepEqual(result, { x: 1306, y: 481.5 });
  assert.equal(result.y + 406.5, 888);
});
