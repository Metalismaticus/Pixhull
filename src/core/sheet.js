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

/** Every way six cells could pair up into three opposite pairs. */
const PAIRINGS = sixPairings();

/**
 * The fifteen ways to split six cells into three unordered pairs, each pair
 * written smaller index first so reading order decides which member is the
 * near side.
 * @returns {number[][][]}
 */
function sixPairings() {
  /** @type {number[][][]} */
  const out = [];
  const rest = [1, 2, 3, 4, 5];
  for (let a = 0; a < 5; a++) {
    const left = rest.filter((_, i) => i !== a);
    for (let b = 0; b < 3; b++) {
      const tail = left.filter((_, i) => i !== 0 && i !== b + 1);
      out.push([[0, rest[a]], [left[0], left[b + 1]], [tail[0], tail[1]]]);
    }
  }
  return out;
}

/** Which two view names a solved pair carries, near side first. */
const PAIR_ROLES = [['front', 'back'], ['right', 'left'], ['top', 'bottom']];

/**
 * Guess which cell is which view.
 *
 * With three cells the sizes give it away, because orthographic views have to
 * agree on the axes they share: front and right are the same height, top is as
 * wide as front, and top is as deep as right is wide. Usually exactly one
 * arrangement satisfies all three, and that is the answer - no guessing from
 * layout conventions that every artist follows differently.
 *
 * With six the same arithmetic runs one level up. Opposite views are the same
 * size as each other, so the cells fall into three pairs, and the three pairs
 * carry the axes X×Y, Z×Y and X×Z - which pair is which is again decided by
 * the axes they share. Sizes cannot tell front from back, so within a pair the
 * near side is the one that comes first in reading order.
 *
 * Failing that, reading order: `front, right, top` for three cells, and the
 * model's own view order for anything else. That fallback is what the tool's
 * own exported sheets are laid out in, and what the owner's six-cell reference
 * sheet turned out to be laid out in too - under the old `front, right, top,
 * back, left, bottom` guess four of its six drawings went to the wrong slot,
 * and the model came out 3 360 885 voxels instead of 3 174 409.
 *
 * @param {Cell[]} cells
 * @returns {Array<string | null>} a view name per cell, or null to ignore it
 */
export function guessViews(cells) {
  const solved = solveBySize(cells);
  if (solved) return solved;

  const order = cells.length === 3
    ? ['front', 'right', 'top']
    : ['front', 'back', 'right', 'left', 'top', 'bottom'];
  return cells.map((_, i) => order[i] ?? null);
}

/**
 * The part of `guessViews` that is arithmetic rather than convention: names
 * the cells when their sizes admit exactly one answer, null when they do not.
 *
 * Exported so the dialog can say which of the two it is showing. A guess from
 * reading order that announces itself as an identification is the one way this
 * screen can mislead.
 *
 * @param {Cell[]} cells
 * @returns {Array<string | null> | null}
 */
export function solveBySize(cells) {
  if (cells.length === 6) return solveSix(cells);
  if (cells.length !== 3) return null;

  const near = (a, b) => Math.abs(a - b) <= 1;
  /** @type {number[][]} */
  const solutions = [];
  for (const [f, r, t] of TRIPLES) {
    const F = cells[f], R = cells[r], T = cells[t];
    if (near(F.h, R.h) && near(T.w, F.w) && near(T.h, R.w)) solutions.push([f, r, t]);
  }
  // Only trust it when the sizes leave no room for argument.
  if (solutions.length !== 1) return null;
  const out = /** @type {Array<string|null>} */ ([null, null, null]);
  const [f, r, t] = solutions[0];
  out[f] = 'front';
  out[r] = 'right';
  out[t] = 'top';
  return out;
}

/**
 * Name six cells from their sizes alone, or give up.
 *
 * Give up loudly rather than quietly: a cube projects six identical squares,
 * every arrangement of them fits, and picking one would be a coin toss dressed
 * up as arithmetic. Only an arrangement nothing else can match is returned.
 *
 * @param {Cell[]} cells
 * @returns {Array<string | null> | null}
 */
function solveSix(cells) {
  // A pixel of slack: a drawing may sit a pixel wider than its opposite when
  // an edge column is a single anti-aliased pixel short of opaque.
  const near = (a, b) => Math.abs(a - b) <= 1;
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Array<string|null> | null} */
  let answer = null;

  for (const pairing of PAIRINGS) {
    if (!pairing.every(([i, j]) => near(cells[i].w, cells[j].w) && near(cells[i].h, cells[j].h))) continue;
    // Which pair spans which axes: front/back is X×Y, right/left Z×Y, top/bottom X×Z.
    for (const [a, b, c] of TRIPLES) {
      const FB = cells[pairing[a][0]], RL = cells[pairing[b][0]], TB = cells[pairing[c][0]];
      if (!near(FB.h, RL.h) || !near(TB.w, FB.w) || !near(TB.h, RL.w)) continue;
      const out = /** @type {Array<string|null>} */ (new Array(6).fill(null));
      [a, b, c].forEach((slot, role) => {
        out[pairing[slot][0]] = PAIR_ROLES[role][0];
        out[pairing[slot][1]] = PAIR_ROLES[role][1];
      });
      const key = out.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      answer = out;
      if (seen.size > 1) return null;
    }
  }
  return answer;
}
