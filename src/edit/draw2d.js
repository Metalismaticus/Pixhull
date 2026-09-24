// @ts-check
/**
 * Painting on a drawing, not on the model.
 *
 * The four tools the editor already has - brush, fill, eraser, picker - applied
 * to the pixels of a source view instead of to voxel faces. Nothing here knows
 * about voxels, and nothing here rebuilds anything: a drawing is ahead of the
 * model until the artist presses "Build model" (screen specification
 * `docs/specs/2026-09-24-3-view-editing-2d-3d.md`, section 4.4).
 *
 * Free of the DOM like `src/core/`: an image is {width, height, data} in RGBA8,
 * so the same code runs in the page and under Node, and `tests/edit/view-paint`
 * measures exactly what the canvas does.
 */

/** @typedef {{width: number, height: number, data: Uint8ClampedArray}} RgbaImage */

/**
 * Alpha at or above this counts as opaque - the same threshold the carve reads
 * a drawing with (`src/core/views.js`, ALPHA_THRESHOLD). One number, so a pixel
 * the picker calls transparent is the same pixel the carve ignores.
 */
export const ALPHA_THRESHOLD = 128;

/** @type {WeakMap<object, number>} */
const IMAGE_TOKENS = new WeakMap();
let lastImageToken = 0;

/**
 * A stable identity for one drawing object.
 *
 * Two drawings of the same size are not the same drawing, and an undo step
 * recorded on one must never be written into the other: a slot can be emptied
 * and refilled with a blank sheet of exactly the grid's size, and `width` and
 * `height` would happily agree while every pixel underneath belongs to another
 * picture. Numbers are handed out here and kept in a `WeakMap`, so an entry can
 * name the image it was recorded on without holding it alive.
 *
 * @param {RgbaImage} img
 * @returns {number}
 */
export function imageToken(img) {
  let id = IMAGE_TOKENS.get(img);
  if (id === undefined) {
    id = ++lastImageToken;
    IMAGE_TOKENS.set(img, id);
  }
  return id;
}

/**
 * A fully transparent drawing, square, at the grid's own size.
 *
 * Square and uncropped on purpose: a drawing exactly N×N lands on the grid
 * cell for cell, which sidesteps the rounding in `autoPlace` that costs a
 * column when the widths of two views have opposite parity (`docs/BATCH.md`,
 * "Найдено по ходу").
 *
 * @param {number} n grid size
 * @returns {RgbaImage}
 */
export function blankSheet(n) {
  const size = Math.max(1, Math.round(n));
  return { width: size, height: size, data: new Uint8ClampedArray(size * size * 4) };
}

/**
 * The square a brush of radius `r` covers, clipped to the drawing.
 * @param {number} x @param {number} y @param {number} r
 * @param {number} w @param {number} h
 */
export function brushBox(x, y, r, w, h) {
  return {
    x0: Math.max(0, x - r),
    y0: Math.max(0, y - r),
    x1: Math.min(w - 1, x + r),
    y1: Math.min(h - 1, y + r),
  };
}

/**
 * @param {RgbaImage} img
 * @param {number} x @param {number} y
 * @returns {boolean} the point is inside the drawing
 */
export function inside(img, x, y) {
  return x >= 0 && y >= 0 && x < img.width && y < img.height;
}

/**
 * Lay the colour down over a square of side 2r+1.
 * @param {RgbaImage} img
 * @param {number} x @param {number} y @param {number} r
 * @param {number} rgb packed 0xRRGGBB
 * @returns {number} pixels actually changed
 */
export function paintAt(img, x, y, r, rgb) {
  if (!inside(img, x, y)) return 0;
  const { data, width } = img;
  const red = (rgb >> 16) & 255, green = (rgb >> 8) & 255, blue = rgb & 255;
  const b = brushBox(x, y, r, img.width, img.height);
  let count = 0;
  for (let py = b.y0; py <= b.y1; py++) {
    for (let px = b.x0; px <= b.x1; px++) {
      const o = (py * width + px) * 4;
      if (data[o] === red && data[o + 1] === green && data[o + 2] === blue && data[o + 3] === 255) continue;
      data[o] = red; data[o + 1] = green; data[o + 2] = blue; data[o + 3] = 255;
      count++;
    }
  }
  return count;
}

/**
 * Make a square of pixels transparent. Alpha 0 and the colour cleared with it,
 * so an erased pixel cannot come back as a ghost through a PNG round trip.
 * @param {RgbaImage} img
 * @param {number} x @param {number} y @param {number} r
 * @returns {number} pixels actually changed
 */
export function eraseAt(img, x, y, r) {
  if (!inside(img, x, y)) return 0;
  const { data, width } = img;
  const b = brushBox(x, y, r, img.width, img.height);
  let count = 0;
  for (let py = b.y0; py <= b.y1; py++) {
    for (let px = b.x0; px <= b.x1; px++) {
      const o = (py * width + px) * 4;
      if (data[o] === 0 && data[o + 1] === 0 && data[o + 2] === 0 && data[o + 3] === 0) continue;
      data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 0;
      count++;
    }
  }
  return count;
}

/**
 * The colour under the point, or null when there is none.
 *
 * A transparent pixel has no colour to pick: returning black would hand the
 * artist a colour that was never in the drawing.
 * @param {RgbaImage} img
 * @param {number} x @param {number} y
 * @returns {number | null} packed 0xRRGGBB
 */
export function pickAt(img, x, y) {
  if (!inside(img, x, y)) return null;
  const o = (y * img.width + x) * 4;
  if (img.data[o + 3] < ALPHA_THRESHOLD) return null;
  return (img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2];
}

/**
 * Flood the connected run of one colour, four-connected.
 *
 * Transparent counts as a colour: filling the empty space around a drawing is
 * the commonest thing an artist does with a fill tool, and refusing it because
 * "there is nothing there" would be the tool lying about what it sees. Every
 * pixel under the alpha threshold is one region, whatever RGB it carries -
 * otherwise a PNG whose transparent pixels are black in one corner and white in
 * another would fill as two.
 *
 * @param {RgbaImage} img
 * @param {number} x @param {number} y
 * @param {number} rgb packed 0xRRGGBB
 * @param {number} [limit] most pixels to visit
 * @returns {{count: number, capped: boolean}}
 */
export function fillAt(img, x, y, rgb, limit = Infinity) {
  if (!inside(img, x, y)) return { count: 0, capped: false };
  const { data, width, height } = img;
  const red = (rgb >> 16) & 255, green = (rgb >> 8) & 255, blue = rgb & 255;

  const seed = (y * width + x) * 4;
  const seedClear = data[seed + 3] < ALPHA_THRESHOLD;
  const sr = data[seed], sg = data[seed + 1], sb = data[seed + 2], sa = data[seed + 3];
  // Already the colour being asked for: the same early return that keeps a fill
  // drag cheap on the model (`src/edit/tools.js`).
  if (!seedClear && sr === red && sg === green && sb === blue && sa === 255) {
    return { count: 0, capped: false };
  }

  /** @param {number} o */
  const matches = (o) => (seedClear
    ? data[o + 3] < ALPHA_THRESHOLD
    : data[o] === sr && data[o + 1] === sg && data[o + 2] === sb && data[o + 3] === sa);

  const seen = new Uint8Array(width * height);
  /** @type {number[]} */
  const stack = [y * width + x];
  seen[y * width + x] = 1;
  let count = 0;
  let capped = false;
  while (stack.length > 0) {
    if (count >= limit) { capped = true; break; }
    const p = /** @type {number} */ (stack.pop());
    const o = p * 4;
    data[o] = red; data[o + 1] = green; data[o + 2] = blue; data[o + 3] = 255;
    count++;
    const px = p % width, py = (p - px) / width;
    if (px > 0 && !seen[p - 1] && matches(o - 4)) { seen[p - 1] = 1; stack.push(p - 1); }
    if (px < width - 1 && !seen[p + 1] && matches(o + 4)) { seen[p + 1] = 1; stack.push(p + 1); }
    if (py > 0 && !seen[p - width] && matches(o - width * 4)) { seen[p - width] = 1; stack.push(p - width); }
    if (py < height - 1 && !seen[p + width] && matches(o + width * 4)) {
      seen[p + width] = 1;
      stack.push(p + width);
    }
  }
  return { count, capped };
}

/**
 * One stroke on one drawing, as an undo step.
 *
 * The whole drawing is copied when the stroke opens and the changed rectangle
 * is cut out of it when the stroke closes, so what the history keeps is the
 * patch and not the sheet: a dab on a 512×512 drawing costs eight bytes, the
 * same way a dab on the model does (`src/edit/history.js`).
 */
export class ViewStroke {
  /**
   * @param {string} name which of the six views
   * @param {RgbaImage} img the drawing itself; it is edited in place
   */
  constructor(name, img) {
    this.name = name;
    this.img = img;
    this.token = imageToken(img);
    this.width = img.width;
    this.height = img.height;
    this.before = img.data.slice();
    /** pixels the tools reported changing, for the status line */
    this.count = 0;
  }

  /**
   * Close the stroke. Null when nothing moved - a stroke that changed no pixel
   * is dropped rather than filling the stack with no-ops.
   * @returns {import('./history.js').ViewEntry | null}
   */
  finish() {
    const { data } = this.img;
    const w = this.width, h = this.height;
    const before = this.before;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        if (data[o] === before[o] && data[o + 1] === before[o + 1]
          && data[o + 2] === before[o + 2] && data[o + 3] === before[o + 3]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null;
    const rect = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    return {
      kind: 'view',
      name: this.name,
      token: this.token,
      width: w,
      height: h,
      rect,
      before: cutRect(before, w, rect),
      after: cutRect(data, w, rect),
    };
  }
}

/**
 * @param {Uint8ClampedArray} data @param {number} width
 * @param {{x: number, y: number, w: number, h: number}} rect
 * @returns {Uint8ClampedArray}
 */
function cutRect(data, width, rect) {
  const out = new Uint8ClampedArray(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++) {
    const src = ((rect.y + y) * width + rect.x) * 4;
    out.set(data.subarray(src, src + rect.w * 4), y * rect.w * 4);
  }
  return out;
}

/**
 * Write a patch back into a drawing.
 * @param {RgbaImage} img
 * @param {{x: number, y: number, w: number, h: number}} rect
 * @param {Uint8ClampedArray} patch
 */
export function pasteRect(img, rect, patch) {
  for (let y = 0; y < rect.h; y++) {
    img.data.set(
      patch.subarray(y * rect.w * 4, (y + 1) * rect.w * 4),
      ((rect.y + y) * img.width + rect.x) * 4
    );
  }
}
