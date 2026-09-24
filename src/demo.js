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
 * Painted straight into an RGBA8 buffer rather than onto a canvas.
 *
 * Keeping the demo free of the DOM is what lets a check import it: the false
 * "these two drawings are the same" warning the demo used to raise could only
 * be pinned down by carving the demo itself, and `document` does not exist in
 * Node. `toImageData` promotes the result wherever a real ImageData is needed.
 *
 * @param {number} w @param {number} h
 * @param {Array<[number, number, number, number, string]>} rects x, y, w, h, colour
 * @returns {{width: number, height: number, data: Uint8ClampedArray}}
 */
function paint(w, h, rects) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (const [x, y, rw, rh, color] of rects) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    for (let j = Math.max(0, y); j < Math.min(h, y + rh); j++) {
      for (let i = Math.max(0, x); i < Math.min(w, x + rw); i++) {
        const k = (j * w + i) * 4;
        data[k] = r;
        data[k + 1] = g;
        data[k + 2] = b;
        data[k + 3] = 255;
      }
    }
  }
  return { width: w, height: h, data };
}

/**
 * The car points along +Z, which is toward the front camera.
 * @returns {{front: {width: number, height: number, data: Uint8ClampedArray},
 *   right: {width: number, height: number, data: Uint8ClampedArray},
 *   top: {width: number, height: number, data: Uint8ClampedArray}}}
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
