// @ts-check
/**
 * Source views: the up-to-six orthographic images the model is carved from.
 *
 * Deliberately free of the DOM. An image arrives as plain {width, height,
 * data} in RGBA8, whether a browser decoded it or Node did, so the carve runs
 * identically in the page and in the MCP server - one implementation, not two
 * that have to agree.
 *
 * Deliberately permissive about size. Art arrives at 50x48 or 37x91, from
 * whatever canvas the artist was already working in, and the tool's job is to
 * place it on the voxel grid - not to send the artist back to resize things.
 * Each view keeps its own pixel offset inside the grid so mismatched views can
 * be lined up by eye instead of by arithmetic.
 */

import { DIR_PX, DIR_NX, DIR_PY, DIR_NY, DIR_PZ, DIR_NZ } from './volume.js';

import { alignViews } from './align.js';

/** Order matters: it is the UI order and the serialisation order. */
export const VIEW_NAMES = /** @type {const} */ (['front', 'back', 'right', 'left', 'top', 'bottom']);

/**
 * Per view: which voxel face it paints, and how its (u,v) relates to voxel
 * space. `uv` maps a voxel to the pixel that sees it; `ray` walks from the
 * camera inward so the first solid hit is the one that gets painted.
 *
 * The convention is the engineering-drawing one: front and top share columns,
 * front and the side views share rows.
 */
export const VIEW_GEOM = {
  front:  { face: DIR_PZ, uv: (x, y, z, N) => [x, N - 1 - y],         ray: (u, v, d, N) => [u, N - 1 - v, N - 1 - d] },
  back:   { face: DIR_NZ, uv: (x, y, z, N) => [N - 1 - x, N - 1 - y], ray: (u, v, d, N) => [N - 1 - u, N - 1 - v, d] },
  right:  { face: DIR_PX, uv: (x, y, z, N) => [N - 1 - z, N - 1 - y], ray: (u, v, d, N) => [N - 1 - d, N - 1 - v, N - 1 - u] },
  left:   { face: DIR_NX, uv: (x, y, z, N) => [z, N - 1 - y],         ray: (u, v, d, N) => [d, N - 1 - v, u] },
  top:    { face: DIR_PY, uv: (x, y, z, N) => [x, z],                 ray: (u, v, d, N) => [u, N - 1 - d, v] },
  bottom: { face: DIR_NY, uv: (x, y, z, N) => [x, N - 1 - z],         ray: (u, v, d, N) => [u, d, N - 1 - v] },
};

/** Alpha at or above this counts as solid. */
export const ALPHA_THRESHOLD = 128;

export class SourceView {
  /**
   * @param {string} name one of VIEW_NAMES
   * @param {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}} image RGBA8
   */
  constructor(name, image) {
    this.name = name;
    this.image = image;
    this.enabled = true;
    this.flipH = false;
    this.flipV = false;
    /**
     * Quarter turns applied to the drawing, 0 / 90 / 180 / 270.
     *
     * Artists lay a top view out lengthways to save sheet space, so its
     * horizontal axis is the model’s length where the tool expects its width.
     * Without this the axes cannot be made to agree at all.
     */
    this.rotate = 0;
    /** True once the artist has turned or mirrored this view themselves; the solvers then leave it be. */
    this.orientLocked = false;
    /** Source pixels per grid cell, per axis. 1 is one art pixel per voxel. */
    this.scaleX = 1;
    this.scaleY = 1;
    /** Top-left corner of the placed content, in grid cells; may be fractional. */
    this.offsetX = 0;
    this.offsetY = 0;
    /** Set by autoPlace; kept so the UI can show "trimmed to 37x52". */
    this.trim = { x: 0, y: 0, w: image.width, h: image.height };
    this.computeTrim();
  }

  /** Tight bounding box of non-transparent pixels. */
  computeTrim() {
    const { width: w, height: h, data } = this.image;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] >= ALPHA_THRESHOLD) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    this.trim = x1 < 0
      ? { x: 0, y: 0, w: 0, h: 0 }
      : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /**
   * Content size after rotation, in source pixels. Everything downstream works
   * in this space rather than the raw trim.
   */
  get viewW() {
    return this.rotate % 180 === 0 ? this.trim.w : this.trim.h;
  }

  get viewH() {
    return this.rotate % 180 === 0 ? this.trim.h : this.trim.w;
  }

  /**
   * Map a point in the rotated view's own space to a pixel of the source image.
   * @param {number} a @param {number} b
   * @returns {[number, number]} source x, y
   */
  toSource(a, b) {
    const { w, h } = this.trim;
    let tx, ty;
    switch (this.rotate) {
      case 90: tx = b; ty = h - 1 - a; break;
      case 180: tx = w - 1 - a; ty = h - 1 - b; break;
      case 270: tx = w - 1 - b; ty = a; break;
      default: tx = a; ty = b;
    }
    if (this.flipH) tx = w - 1 - tx;
    if (this.flipV) ty = h - 1 - ty;
    return [this.trim.x + tx, this.trim.y + ty];
  }

  /**
   * Centre the content on the grid at one art pixel per cell (or a uniform
   * reduction), on whole-cell offsets.
   *
   * @param {number} N grid size
   * @param {number} [scale] source pixels per grid cell
   */
  autoPlace(N, scale = 1) {
    if (this.trim.w === 0) {
      this.scaleX = 1;
      this.scaleY = 1;
      this.offsetX = 0;
      this.offsetY = 0;
      return;
    }
    this.scaleX = scale;
    this.scaleY = scale;
    // Whole-cell offsets. At one art pixel per voxel a fractional offset would
    // make every sampling box straddle two source pixels, which quietly changes
    // the silhouette of art that was meant to land exactly.
    this.offsetX = Math.round((N - this.viewW / scale) / 2);
    this.offsetY = Math.round((N - this.viewH / scale) / 2);
  }

  /**
   * Place the content in a box of `gw` x `gh` grid cells, centred.
   *
   * The two axes scale independently on purpose. Hand-drawn reference sheets
   * routinely disagree about a shared axis - a side view drawn 18% shorter
   * than the front view says it is - and since an orthographic silhouette
   * spans the model's full extent on both its axes by definition, fitting
   * each view to the agreed extent is the correction, not a fudge.
   *
   * @param {number} N grid size
   * @param {number} gw width in grid cells
   * @param {number} gh height in grid cells
   */
  place(N, gw, gh) {
    if (this.trim.w === 0 || gw <= 0 || gh <= 0) {
      this.scaleX = 1;
      this.scaleY = 1;
      this.offsetX = 0;
      this.offsetY = 0;
      return;
    }
    this.scaleX = this.viewW / gw;
    this.scaleY = this.viewH / gh;
    this.offsetX = (N - gw) / 2;
    this.offsetY = (N - gh) / 2;
  }

  /**
   * Flatten to a grid-sized mask plus one colour per cell, reducing the art to
   * fit.
   *
   * Each grid cell covers a box of source pixels. A cell is solid when most of
   * that box is, and takes the box's most common colour. Point sampling would
   * be cheaper but is the wrong tool twice over: on a silhouette it drops thin
   * structures like a wing edge entirely, and on colour it would pick whatever
   * pixel happened to sit under the sample point, including an anti-aliasing
   * fringe that belongs to neither side.
   *
   * @param {number} N
   * @returns {{mask: Uint8Array, rgb: Int32Array}} rgb is packed 0xRRGGBB, -1 where empty
   */
  sampleCells(N) {
    const mask = new Uint8Array(N * N);
    const rgb = new Int32Array(N * N).fill(-1);
    const { width: iw, data } = this.image;
    const sx = this.scaleX;
    const sy = this.scaleY;
    const viewW = this.viewW;
    const viewH = this.viewH;
    /** @type {Map<number, number>} packed colour -> pixels in this cell */
    const tally = new Map();

    for (let v = 0; v < N; v++) {
      const b0 = Math.floor((v - this.offsetY) * sy);
      const b1 = Math.max(b0 + 1, Math.ceil((v + 1 - this.offsetY) * sy));
      if (b1 <= 0 || b0 >= viewH) continue;

      for (let u = 0; u < N; u++) {
        const a0 = Math.floor((u - this.offsetX) * sx);
        const a1 = Math.max(a0 + 1, Math.ceil((u + 1 - this.offsetX) * sx));
        if (a1 <= 0 || a0 >= viewW) continue;

        let opaque = 0;
        let total = 0;
        tally.clear();

        for (let b = b0; b < b1; b++) {
          for (let a = a0; a < a1; a++) {
            total++;
            if (a < 0 || b < 0 || a >= viewW || b >= viewH) continue;
            const [px, py] = this.toSource(a, b);
            const i = (py * iw + px) * 4;
            if (data[i + 3] < ALPHA_THRESHOLD) continue;
            opaque++;
            const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
            tally.set(key, (tally.get(key) ?? 0) + 1);
          }
        }

        // Majority coverage. Anything less and a cell on the outline would be
        // filled by a couple of stray anti-aliased pixels.
        if (opaque * 2 < total) continue;

        let best = 0;
        let bestCount = 0;
        for (const [k, n] of tally) {
          if (n > bestCount) {
            bestCount = n;
            best = k;
          }
        }
        const o = v * N + u;
        mask[o] = 1;
        rgb[o] = best;
      }
    }
    return { mask, rgb };
  }

  /**
   * Sample, then look every colour up in a palette that has already been chosen.
   * @param {number} N
   * @param {import('./palette.js').Palette} palette
   * @returns {{mask: Uint8Array, color: Uint8Array}}
   */
  rasterize(N, palette) {
    const { mask, rgb } = this.sampleCells(N);
    const color = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const c = rgb[i];
      color[i] = palette.add((c >> 16) & 255, (c >> 8) & 255, c & 255);
    }
    return { mask, color };
  }
}

/**
 * Smallest grid that holds every enabled view's trimmed content.
 * @param {SourceView[]} views
 * @returns {number}
 */
export function suggestGridSize(views) {
  let need = 8;
  for (const v of views) {
    if (!v.enabled || v.trim.w === 0) continue;
    need = Math.max(need, v.trim.w, v.trim.h);
  }
  return Math.min(256, need);
}

/** Which two model axes each view spans. */
export const VIEW_AXES = {
  front: ['x', 'y'], back: ['x', 'y'],
  right: ['z', 'y'], left: ['z', 'y'],
  top: ['x', 'z'], bottom: ['x', 'z'],
};

/**
 * Place a whole set of views on the grid.
 *
 * Two regimes, because they want opposite things.
 *
 * Art that already fits the grid is pixel art, and resampling it is pure
 * damage: a 12-pixel wing stretched to 13 grid cells gains a duplicated
 * column that the artist did not draw. So it is placed one art pixel per
 * voxel and merely centred, exactly as before.
 *
 * Art larger than the grid is an illustration, and it has to be reduced
 * anyway. There the axes are reconciled first: every view is fitted to the
 * agreed extent of the two axes it spans, so a side view drawn shorter than
 * the front view says it is gets corrected rather than carving a model that
 * matches neither drawing.
 *
 * @param {SourceView[]} views
 * @param {number} N grid size
 * @returns {{reduction: number, extent: {x: number, y: number, z: number}, reconciled: boolean,
 *   worst: {name: string | null, amount: number}}} `worst` names the view that
 *   disagreed most with the others, which is the honest diagnostic when a
 *   reference sheet turns out to be illustrations rather than projections
 */
/**
 * Pick a quarter turn for each view so the axes they share agree.
 *
 * A top view laid out lengthways has the model’s length across the image
 * where the tool expects its width, and no amount of scaling reconciles that -
 * on a box lorry it asked for a 2.07x stretch and still came out wrong.
 * Turning it is the fix.
 *
 * Only 0 and 90 are tried, since 180 and 270 leave the dimensions unchanged
 * and cannot affect the agreement. Six views is 64 combinations, so the
 * search is exhaustive rather than clever. Ties go to the arrangement that
 * turns fewest drawings, and anything the artist has turned by hand is left
 * alone.
 *
 * @param {SourceView[]} active
 */
function chooseRotations(active) {
  const free = active.filter((v) => !v.orientLocked);
  if (free.length === 0) return;

  const dimsFor = (v, turned) => (turned ? [v.trim.h, v.trim.w] : [v.trim.w, v.trim.h]);

  let bestMask = 0;
  let bestScore = Infinity;
  let bestTurns = Infinity;

  for (let mask = 0; mask < (1 << free.length); mask++) {
    /** @type {{x: number[], y: number[], z: number[]}} */
    const seen = { x: [], y: [], z: [] };
    for (const v of active) {
      const axes = VIEW_AXES[v.name] ?? ['x', 'y'];
      const slot = free.indexOf(v);
      const turned = slot < 0 ? v.rotate % 180 !== 0 : ((mask >> slot) & 1) === 1;
      const [w, h] = dimsFor(v, turned);
      seen[axes[0]].push(w);
      seen[axes[1]].push(h);
    }

    // How far apart the claims about each axis are, summed.
    let score = 0;
    for (const axis of ['x', 'y', 'z']) {
      const vals = seen[axis];
      if (vals.length < 2) continue;
      score += Math.max(...vals) / Math.min(...vals) - 1;
    }

    let turns = 0;
    for (let i = 0; i < free.length; i++) if ((mask >> i) & 1) turns++;

    if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) < 1e-9 && turns < bestTurns)) {
      bestScore = score;
      bestTurns = turns;
      bestMask = mask;
    }
  }

  free.forEach((v, i) => { v.rotate = ((bestMask >> i) & 1) ? 90 : 0; });
}
/**
 * Work out the model's proportions from drawings that are each at their own
 * scale.
 *
 * Taking the largest pixel extent claimed for each axis assumes every drawing
 * was made at one scale. Sheets are not drawn that way - each view is sized to
 * fill its own cell - so on a box lorry the front view came out scaled 26%
 * differently from the top view along the very same axis, and the side view
 * ended up 19% taller relative to its length than the others said it was.
 * Views distorted against each other carve material none of them contains:
 * that is the ridge running along the body behind the cab.
 *
 * What a view actually gives is the *ratio* between the two axes it spans,
 * which it knows exactly even when its absolute size means nothing. Six such
 * ratios over three unknowns is over-determined, and solved here by least
 * squares in log space, where a ratio is a difference and the problem is
 * linear. Ratios say nothing about overall size, so that is pinned afterwards
 * to whatever disturbs the drawings least.
 *
 * On the lorry the drawings turn out to agree to within a fifth of a percent,
 * and every view then scales uniformly - no distortion left to carve phantoms
 * out of.
 *
 * @param {SourceView[]} active
 * @returns {{x: number, y: number, z: number}} extents in one common unit
 */
function solveExtents(active) {
  const AXIS = ['x', 'y', 'z'];
  /** @type {Array<{a: number, b: number, d: number}>} each says logA - logB = d */
  const constraints = [];
  for (const v of active) {
    const axes = VIEW_AXES[v.name] ?? ['x', 'y'];
    if (v.viewW <= 0 || v.viewH <= 0) continue;
    constraints.push({
      a: AXIS.indexOf(axes[0]),
      b: AXIS.indexOf(axes[1]),
      d: Math.log(v.viewW / v.viewH),
    });
  }
  if (constraints.length === 0) return { x: 1, y: 1, z: 1 };

  // Normal equations, plus a weak pull towards sum(log) = 0: ratios leave the
  // overall scale free, and without that term the system is singular.
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const rhs = [0, 0, 0];
  for (const { a, b, d } of constraints) {
    M[a][a] += 1;
    M[b][b] += 1;
    M[a][b] -= 1;
    M[b][a] -= 1;
    rhs[a] += d;
    rhs[b] -= d;
  }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += 0.01;

  const ratio = solve3(M, rhs).map(Math.exp);

  // Pin the absolute size where it disturbs the drawings least: the geometric
  // mean of the scale each claim implies.
  let sum = 0;
  let n = 0;
  for (const v of active) {
    const axes = VIEW_AXES[v.name] ?? ['x', 'y'];
    sum += Math.log(v.viewW / ratio[AXIS.indexOf(axes[0])]);
    sum += Math.log(v.viewH / ratio[AXIS.indexOf(axes[1])]);
    n += 2;
  }
  const scale = n > 0 ? Math.exp(sum / n) : 1;
  return { x: ratio[0] * scale, y: ratio[1] * scale, z: ratio[2] * scale };
}

/** Gaussian elimination with partial pivoting, sized for the 3x3 above. */
function solve3(M, rhs) {
  const a = M.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    const swap = a[col];
    a[col] = a[pivot];
    a[pivot] = swap;
    if (Math.abs(a[col][col]) < 1e-12) continue;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let c = col; c < 4; c++) a[r][c] -= f * a[col][c];
    }
  }
  return [0, 1, 2].map((i) => (Math.abs(a[i][i]) < 1e-12 ? 0 : a[i][3] / a[i][i]));
}

export function fitViews(views, N) {
  const active = views.filter((v) => v.enabled && v.trim.w > 0);
  chooseRotations(active);
  // Dimensions cannot tell a quarter turn from its opposite, so content has
  // the last word on which way round each drawing goes.
  alignViews(active);

  const none = { name: null, amount: 1 };
  if (active.length === 0) return { reduction: 1, extent: { x: 1, y: 1, z: 1 }, reconciled: false, worst: none };

  // Each view knows the ratio between the two axes it spans exactly, even
  // when its absolute size is arbitrary. Solving those ratios together beats
  // believing whichever drawing happens to be biggest.
  const extent = solveExtents(active);
  const biggest = Math.max(extent.x, extent.y, extent.z);

  if (biggest <= N) {
    for (const v of views) v.autoPlace(N, 1);
    return { reduction: 1, extent, reconciled: false, worst: none };
  }

  const reduction = biggest / N;
  /** @type {{x: number, y: number, z: number}} */
  const cells = {
    x: Math.max(1, Math.min(N, Math.round(extent.x / reduction))),
    y: Math.max(1, Math.min(N, Math.round(extent.y / reduction))),
    z: Math.max(1, Math.min(N, Math.round(extent.z / reduction))),
  };
  const worst = { name: /** @type {string|null} */ (null), amount: 1 };
  for (const v of views) {
    const axes = VIEW_AXES[v.name] ?? ['x', 'y'];
    const wantW = cells[axes[0]];
    const wantH = cells[axes[1]];
    v.place(N, wantW, wantH);
    if (!v.enabled || v.trim.w === 0) continue;
    // What matters is not that a drawing was resized - they are all at their
    // own scale - but that it had to be squashed against itself. A view
    // stretched more one way than the other no longer matches what the artist
    // drew, and its silhouette starts carving shapes none of them contains.
    const amount = Math.max(v.scaleX / v.scaleY, v.scaleY / v.scaleX);
    if (amount > worst.amount) {
      worst.amount = amount;
      worst.name = v.name;
    }
  }
  return { reduction, extent, reconciled: true, worst };
}
