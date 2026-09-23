// @ts-check
/**
 * Choosing which colours the palette keeps.
 *
 * A voxel face stores one byte, so at most 255 colours can survive an import.
 * Until now the choice was "the 255 most used", which sounds fair and is not:
 * a white lorry's body arrives as hundreds of anti-aliased near-whites, each
 * of them covering more cells than the tail lights, so the near-whites take
 * every slot and every accent on the model resolves to a grey. The measurement
 * that started this: colour accuracy by grid 67.9% -> 92.4% from 256 to 512,
 * but only 47.5% -> 55.8% once the palette had its say.
 *
 * What replaces it is a weighted median cut in CIE L*a*b*:
 *
 * - every distinct colour of every view enters once, weighted by the number of
 *   grid cells it covers, so the choice is made over all six drawings at once;
 * - the box split next is the one carrying the largest weighted squared error,
 *   not the one with the most pixels. That is the whole fix: a thousand
 *   near-whites sit in a tiny box with a tiny error and stop asking for slots,
 *   while a small patch of saturated red sits far from everything and gets one;
 * - a box is represented by its *most used colour*, not by its mean. For pixel
 *   art this matters: flat areas are drawn in one exact colour, and the mean of
 *   a flat colour with its own anti-aliasing is a colour the artist never used.
 *
 * No dithering, on purpose - pixel art is not dithered (`docs/ROADMAP.md`).
 */

import { packedToLab } from './color.js';

/**
 * @typedef {Object} QuantizeResult
 * @property {number[]} colors chosen colours, packed 0xRRGGBB, most covered first
 * @property {Map<number, number>} assign source colour -> index into `colors`
 */

/**
 * Colours covering at least this share of the art keep a slot of their own,
 * exactly as drawn. Pixel art is flat colour: the shades the artist actually
 * used are worth preserving byte for byte even when a merge would be
 * invisible, because they are the palette the art was painted with. Measured
 * on the owner's reference sheet (45709 colours, 2026-09-24): 47 colours pass
 * this bar, and reserving them lifts exactly-preserved area from 27.1% to
 * 36.1% while the perceptual numbers do not move (88.9% -> 88.7% within dE 2,
 * 0.2% visibly wrong either way).
 */
const RESERVE_SHARE = 0.002;
/** Never spend more than this fraction of the palette on the rule above. */
const RESERVE_CAP = 0.25;

/**
 * @param {Map<number, number>} counts packed colour -> cells covered
 * @param {number} max how many colours may survive
 * @returns {QuantizeResult}
 */
export function quantize(counts, max) {
  let weightSum = 0;
  for (const w of counts.values()) weightSum += w;
  const bar = weightSum * RESERVE_SHARE;
  const cap = Math.floor(max * RESERVE_CAP);
  /** @type {Array<[number, number]>} */
  const heavy = [...counts].filter(([, w]) => w >= bar).sort((a, b) => b[1] - a[1]).slice(0, cap);
  /** @type {Set<number>} */
  const reserved = new Set(heavy.map(([k]) => k));
  // Everything the reservation did not claim is what the cut has to describe.
  const rest = reserved.size === 0 ? counts : new Map([...counts].filter(([k]) => !reserved.has(k)));
  const slots = max - reserved.size;
  if (rest.size <= slots) {
    const colors = [...heavy.map(([k]) => k), ...[...rest].sort((a, b) => b[1] - a[1]).map(([k]) => k)];
    const assign = new Map();
    colors.forEach((k, i) => assign.set(k, i));
    return { colors, assign };
  }
  const cut = medianCut(rest, slots);
  const colors = [...heavy.map(([k]) => k), ...cut.colors];
  const assign = new Map();
  heavy.forEach(([k], i) => assign.set(k, i));
  for (const [k, slot] of cut.assign) assign.set(k, reserved.size + slot);
  return { colors, assign };
}

/**
 * Weighted median cut in Lab.
 * @param {Map<number, number>} counts
 * @param {number} max
 * @returns {QuantizeResult}
 */
function medianCut(counts, max) {
  const n = counts.size;
  const packed = new Int32Array(n);
  const weight = new Float64Array(n);
  const L = new Float64Array(n);
  const A = new Float64Array(n);
  const B = new Float64Array(n);

  let i = 0;
  for (const [key, w] of counts) {
    const [l, a, b] = packedToLab(key);
    packed[i] = key;
    weight[i] = w;
    L[i] = l;
    A[i] = a;
    B[i] = b;
    i++;
  }

  // Indices, grouped by box. Boxes own a contiguous slice of this array, which
  // is what makes a split a partial sort rather than an allocation.
  const order = new Int32Array(n);
  for (let k = 0; k < n; k++) order[k] = k;

  const axes = [L, A, B];
  /** @type {Array<{lo: number, hi: number, err: number, axis: number}>} */
  const boxes = [describe(0, n)];

  while (boxes.length < max) {
    let pick = -1;
    let worst = 0;
    for (let b = 0; b < boxes.length; b++) {
      if (boxes[b].hi - boxes[b].lo < 2) continue;
      if (boxes[b].err > worst) {
        worst = boxes[b].err;
        pick = b;
      }
    }
    if (pick < 0) break; // every box is a single colour: nothing left to split
    const box = boxes[pick];
    const cut = split(box);
    if (cut <= box.lo || cut >= box.hi) break;
    boxes[pick] = describe(box.lo, cut);
    boxes.push(describe(cut, box.hi));
  }

  // Most covered box first, so palette index 1 is the model's main colour and
  // the strip in the UI reads as the art does.
  const reps = boxes.map((box) => {
    let total = 0;
    let bestW = -1;
    let best = packed[order[box.lo]];
    for (let k = box.lo; k < box.hi; k++) {
      const idx = order[k];
      total += weight[idx];
      if (weight[idx] > bestW) {
        bestW = weight[idx];
        best = packed[idx];
      }
    }
    return { box, color: best, total };
  });
  reps.sort((x, y) => y.total - x.total);

  const colors = [];
  const assign = new Map();
  for (let slot = 0; slot < reps.length; slot++) {
    colors.push(reps[slot].color);
    const { box } = reps[slot];
    for (let k = box.lo; k < box.hi; k++) assign.set(packed[order[k]], slot);
  }
  return { colors, assign };

  /**
   * Weighted squared error of a slice about its own mean, and the axis that
   * carries most of it.
   * @param {number} lo @param {number} hi
   */
  function describe(lo, hi) {
    let w = 0;
    let sl = 0, sa = 0, sb = 0;
    let ql = 0, qa = 0, qb = 0;
    for (let k = lo; k < hi; k++) {
      const idx = order[k];
      const wi = weight[idx];
      w += wi;
      sl += wi * L[idx]; ql += wi * L[idx] * L[idx];
      sa += wi * A[idx]; qa += wi * A[idx] * A[idx];
      sb += wi * B[idx]; qb += wi * B[idx] * B[idx];
    }
    const el = Math.max(0, ql - (sl * sl) / w);
    const ea = Math.max(0, qa - (sa * sa) / w);
    const eb = Math.max(0, qb - (sb * sb) / w);
    let axis = 0;
    let spread = el;
    if (ea > spread) { axis = 1; spread = ea; }
    if (eb > spread) { axis = 2; spread = eb; }
    return { lo, hi, err: el + ea + eb, axis };
  }

  /**
   * Sort the box along its widest axis and cut at the weighted median.
   * @param {{lo: number, hi: number, axis: number}} box
   * @returns {number} first index of the upper half
   */
  function split(box) {
    const axis = axes[box.axis];
    const slice = Array.from(order.subarray(box.lo, box.hi));
    slice.sort((p, q) => axis[p] - axis[q] || packed[p] - packed[q]);
    order.set(slice, box.lo);

    let total = 0;
    for (const idx of slice) total += weight[idx];
    let half = 0;
    for (let k = box.lo; k < box.hi - 1; k++) {
      half += weight[order[k]];
      if (half * 2 >= total) return k + 1;
    }
    return box.hi - 1;
  }
}
