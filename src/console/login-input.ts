/**
 * The login view's canvas as `login.input` (src/browser/login-view.ts): where a pointer lands on the remote page, and a
 * key's modifiers. It runs in web/ and imports nothing of node's.
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A pointer at (clientX, clientY) over the canvas laid out in `box` (its getBoundingClientRect, CSS px), as the remote
 * page's CSS px: the last frame's `w` × `h` (the screencast's deviceWidth and deviceHeight). Neither the canvas's
 * backing size nor the device pixel ratio on either side enters: client coordinates and the box are both CSS px, and
 * the canvas has no border or padding. Clamped to the page; undefined before a frame or while the canvas has no size.
 */
export function pagePoint(
  clientX: number,
  clientY: number,
  box: Box,
  w: number,
  h: number,
): { x: number; y: number } | undefined {
  if (!(box.width > 0 && box.height > 0 && w > 0 && h > 0)) return undefined;
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  return {
    x: clamp(((clientX - box.left) * w) / box.width, w - 1),
    y: clamp(((clientY - box.top) * h) / box.height, h - 1),
  };
}

/** CDP's `modifiers` bit field: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export const modifiers = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

/** A DOM MouseEvent's `button` as CDP's. */
export const button = (b: number): "left" | "middle" | "right" => (["left", "middle", "right"] as const)[b] ?? "left";
