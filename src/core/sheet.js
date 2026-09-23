// @ts-check
/**
 * Slicing one reference sheet into separate views.
 *
 * Artists rarely keep three tidy files; they keep one PNG with the front, the
 * side and the top laid out side by side. Asking them to cut it up by hand
 * before the tool will look at it is exactly the kind of busywork this project
 * exists to remove.
 *
 * Detection is by empty gutters rather than connected components. A character's
 * separated limbs or a floating headlight would each be their own component and
 * the sheet would shatter into fragments; a run of fully transparent rows or
 * columns, on the other hand, is precisely what a person means by "these are
 * different drawings".
 */

/** Alpha at or above this counts as content. */
const ALPHA = 128;

/**
 * @typedef {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}} RgbaImage
 */

/**
 * @typedef {Object} Cell
 * @property {number} x @property {number} y
 * @property {number} w @property {number} h
 */

/**
 * Split a sheet into cells along its empty gutters, top band by top band, then
 * left to right within each - reading order, which is how the sheet was laid
 * out in the first place.
 *
 * @param {RgbaImage} image
 * @param {{gap?: number, minSize?: number}} [opts] gap: transparent lines that
 *   count as a separator; minSize: cells smaller than this are specks, not art
 * @returns {Cell[]}
 */
export function detectCells(image, opts = {}) {
  const gap = Math.max(1, Math.round(opts.gap ?? 1));
  const minSize = Math.max(1, Math.round(opts.minSize ?? 2));
  const { width: w, height: h, data } = image;

  const rowHas = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] >= ALPHA) { rowHas[y] = 1; break; }
    }
  }

  /** @type {Cell[]} */
  const cells = [];
  for (const band of runs(rowHas, gap)) {
    const colHas = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      for (let y = band.start; y <= band.end; y++) {
        if (data[(y * w + x) * 4 + 3] >= ALPHA) { colHas[x] = 1; break; }
      }
    }
    for (const strip of runs(colHas, gap)) {
      const cell = tighten(image, strip.start, band.start, strip.end - strip.start + 1, band.end - band.start + 1);
      if (cell && cell.w >= minSize && cell.h >= minSize) cells.push(cell);
    }
  }
  return cells;
}

/**
 * Runs of set values, ignoring gaps shorter than `gap`.
 * @param {Uint8Array} flags
 * @param {number} gap
 * @returns {Array<{start: number, end: number}>}
 */
function runs(flags, gap) {
  /** @type {Array<{start: number, end: number}>} */
  const out = [];
  let start = -1;
  let emptyRun = 0;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) {
      if (start < 0) start = i;
      emptyRun = 0;
    } else if (start >= 0) {
      emptyRun++;
      if (emptyRun >= gap) {
        out.push({ start, end: i - emptyRun });
        start = -1;
        emptyRun = 0;
      }
    }
  }
  if (start >= 0) out.push({ start, end: flags.length - 1 });
  return out;
}

/**
 * Shrink a rectangle to the content inside it.
 * @param {RgbaImage} image
 * @returns {Cell | null}
 */
function tighten(image, x0, y0, w, h) {
  const { width, data } = image;
  let minX = x0 + w, minY = y0 + h, maxX = -1, maxY = -1;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (data[(y * width + x) * 4 + 3] < ALPHA) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Copy a rectangle out of a sheet.
 * @param {RgbaImage} image
 * @param {Cell} cell
 * @returns {{width: number, height: number, data: Uint8ClampedArray}}
 */
export function cropCell(image, cell) {
  const out = new Uint8ClampedArray(cell.w * cell.h * 4);
  for (let y = 0; y < cell.h; y++) {
    const src = ((cell.y + y) * image.width + cell.x) * 4;
    out.set(image.data.subarray(src, src + cell.w * 4), y * cell.w * 4);
  }
  return { width: cell.w, height: cell.h, data: out };
}

/** Every way three cells could be front, right and top. */
const TRIPLES = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2],
  [1, 2, 0], [2, 0, 1], [2, 1, 0],
];

/**
 * Guess which cell is which view.
 *
 * With three cells the sizes give it away, because orthographic views have to
 * agree on the axes they share: front and right are the same height, top is as
 * wide as front, and top is as deep as right is wide. Usually exactly one
 * arrangement satisfies all three, and that is the answer - no guessing from
 * layout conventions that every artist follows differently.
 *
 * Failing that, reading order with the common front / right / top ordering,
 * which the UI lets you correct in a click.
 *
 * @param {Cell[]} cells
 * @returns {Array<string | null>} a view name per cell, or null to ignore it
 */
export function guessViews(cells) {
  const order = ['front', 'right', 'top', 'back', 'left', 'bottom'];

  if (cells.length === 3) {
    const near = (a, b) => Math.abs(a - b) <= 1;
    /** @type {number[][]} */
    const solutions = [];
    for (const [f, r, t] of TRIPLES) {
      const F = cells[f], R = cells[r], T = cells[t];
      if (near(F.h, R.h) && near(T.w, F.w) && near(T.h, R.w)) solutions.push([f, r, t]);
    }
    // Only trust it when the sizes leave no room for argument.
    if (solutions.length === 1) {
      const out = /** @type {Array<string|null>} */ ([null, null, null]);
      const [f, r, t] = solutions[0];
      out[f] = 'front';
      out[r] = 'right';
      out[t] = 'top';
      return out;
    }
  }

  return cells.map((_, i) => order[i] ?? null);
}
