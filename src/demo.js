// @ts-check
/**
 * A built-in demo so the page is never an empty prompt.
 *
 * Deliberately a car, and deliberately three *differently sized* images
 * (24x12, 12x12, 12x24). It is asymmetric on every axis, so if the view-to-axis
 * mapping is ever wrong it is obvious at a glance rather than subtly off.
 */

const BODY = '#d94f4f';
const ROOF = '#bf3a3a';
const GLASS = '#7fd6e8';
const TYRE = '#23262e';
const LIGHT = '#ffd76e';

/**
 * @param {number} w @param {number} h
 * @param {Array<[number, number, number, number, string]>} rects x, y, w, h, colour
 * @returns {ImageData}
 */
function paint(w, h, rects) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.imageSmoothingEnabled = false;
  for (const [x, y, rw, rh, color] of rects) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, rw, rh);
  }
  return ctx.getImageData(0, 0, w, h);
}

/**
 * The car points along +Z, which is toward the front camera.
 * @returns {{front: ImageData, right: ImageData, top: ImageData}}
 */
export function buildDemoViews() {
  // Seen from the side: 24 long, 12 tall.
  const right = paint(24, 12, [
    [2, 8, 5, 4, TYRE],
    [16, 8, 5, 4, TYRE],
    [1, 5, 22, 4, BODY],
    [6, 2, 12, 3, ROOF],
    [7, 3, 10, 2, GLASS],
    [0, 6, 2, 2, LIGHT],
  ]);

  // Seen head-on: 12 wide, 12 tall.
  const front = paint(12, 12, [
    [0, 8, 3, 4, TYRE],
    [9, 8, 3, 4, TYRE],
    [0, 5, 12, 4, BODY],
    [2, 2, 8, 3, ROOF],
    [3, 3, 6, 2, GLASS],
    [1, 6, 2, 2, LIGHT],
    [9, 6, 2, 2, LIGHT],
  ]);

  // Seen from above: 12 wide, 24 long.
  const top = paint(12, 24, [
    [1, 1, 10, 22, BODY],
    [0, 4, 12, 16, BODY],
    [2, 6, 8, 11, ROOF],
    [3, 7, 6, 4, GLASS],
    [3, 14, 6, 3, GLASS],
  ]);

  return { front, right, top };
}
