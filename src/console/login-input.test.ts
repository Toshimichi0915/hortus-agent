/** The login view's canvas → page coordinates (login-input.ts). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { button, modifiers, pagePoint } from "./login-input.ts";

test("a point on a canvas drawn smaller than the page scales up to the page's CSS px", () => {
  // a 1280 × 900 page shown at 640 × 450, 100 px from the viewport's left and 50 from its top
  const box = { left: 100, top: 50, width: 640, height: 450 };
  assert.deepEqual(pagePoint(100 + 75, 50 + 57.5, box, 1280, 900), { x: 150, y: 115 });
  // larger than the page (a wide screen): scales down
  assert.deepEqual(pagePoint(300, 225, { left: 0, top: 0, width: 2560, height: 1800 }, 1280, 900), {
    x: 150,
    y: 112.5,
  });
});

test("the device pixel ratio and the backing size do not enter: only the box and the frame's w × h", () => {
  // the same CSS box whatever the canvas's width attribute (a 2x JPEG) or the owner's screen
  const box = { left: 0, top: 0, width: 800, height: 600 };
  assert.deepEqual(pagePoint(400, 300, box, 1024, 768), { x: 512, y: 384 });
});

test("outside the canvas is clamped to the page; no frame or no size is no point", () => {
  const box = { left: 10, top: 10, width: 100, height: 100 };
  assert.deepEqual(pagePoint(0, 500, box, 200, 200), { x: 0, y: 199 });
  assert.equal(pagePoint(50, 50, box, 0, 0), undefined);
  assert.equal(pagePoint(50, 50, { ...box, width: 0 }, 200, 200), undefined);
});

test("modifiers and buttons as CDP has them", () => {
  assert.equal(modifiers({ altKey: true, ctrlKey: false, metaKey: true, shiftKey: true }), 13);
  assert.equal(modifiers({ altKey: false, ctrlKey: true, metaKey: false, shiftKey: false }), 2);
  assert.deepEqual([0, 1, 2, 3].map(button), ["left", "middle", "right", "left"]);
});
