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

import { packedToLab, ciede2000 } from './color.js';
import { MERGE_DELTA_E } from './palette.js';

/**
 * @typedef {Object} QuantizeResult
 * @property {number[]} colors chosen colours, packed 0xRRGGBB, most covered first
 * @property {Map<number, number>} assign source colour -> index into `colors`
 * @property {number} reserved how many of `colors` came from the reservation
 *   rule below rather than from the cut. Reported for the checks: on flat art
 *   this number must not move when the fold changes.
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
 * Two reservations this close are the same colour as far as anyone can see, so
 * only one of them is worth a slot.
 *
 * The rule above asks one question - "does this colour cover enough of the art"
 * - and on flat pixel art that is the whole story, because the shades an artist
 * puts down are far apart. On a rendered, anti-aliased sheet it is not: the
 * owner's lorry (2026-09-24, grid 256, 17352 art colours) passes 48 colours
 * over the bar, and 41 of them are near-neutrals within dE 1 of one of the
 * other seven - `d9d9d9 d8d8d8 d9d8d9 d9d8d8 dad9da ...`, one slot each, none
 * of them distinguishable from the next. Those 41 slots are simply gone: they
 * cannot show the artist anything, and the accents that needed them went to the
 * cut instead.
 *
 * So before the reservation spends a slot, indistinguishable reservations
 * collapse onto the one covering the most art, and the slots that frees go back
 * to the cut. Same threshold and same keeper-first grouping as the palette's
 * own merge (`Palette.planMerge`), for one reason: a user who presses "merge
 * near-duplicates" straight after an import should be told there is nothing to
 * do, not handed the work the import already knew about.
 *
 * On flat colour this is a no-op - `tests/palette/reserve-fold.mjs` measures
 * exactly that.
 */
const RESERVE_FOLD_DELTA_E = MERGE_DELTA_E;

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
  const candidates = [...counts].filter(([, w]) => w >= bar).sort((a, b) => b[1] - a[1]);
  const { heavy, followers, alias } = foldReservations(candidates, cap);
  /** @type {Set<number>} */
  const reserved = new Set(alias.keys());
  // Everything the reservation did not claim is what the cut has to describe.
  const rest = reserved.size === 0 ? counts : new Map([...counts].filter(([k]) => !reserved.has(k)));
  let slots = max - heavy.length;
  if (rest.size <= slots) {
    // No pressure on the palette after all: every remaining colour can have a
    // slot of its own and there are still slots going spare. Then the fold has
    // nothing to buy, and exactness is worth more than a tidy palette, so the
    // followers take their own slots back - heaviest first, while the spare
    // slots last. With enough room this undoes the fold completely.
    for (const k of followers) {
      if (rest.size > slots - 1) break;
      alias.set(k, heavy.length);
      heavy.push(k);
      slots--;
    }
    const colors = [...heavy, ...[...rest].sort((a, b) => b[1] - a[1]).map(([k]) => k)];
    return { colors, assign: assignNearest(counts, colors), reserved: heavy.length };
  }
  const cut = medianCut(rest, slots);
  const colors = [...heavy, ...cut.colors];
  return { colors, assign: assignNearest(counts, colors), reserved: heavy.length };
}

/**
 * How far apart the CIEDE2000 lightness term can stretch a lightness
 * difference: `dE00 >= |dL| / SL`, and `SL = 1 + 0.015(L-50)^2/sqrt(20+(L-50)^2)`
 * is largest at the ends of the scale, where it is 1.7475. So a palette colour
 * whose L is further than `SL_MAX * best` away cannot beat `best`, whatever its
 * hue - which is what makes the search below exact rather than a shortlist.
 */
const SL_MAX = 1.7475;

/**
 * Send every source colour to the palette colour nearest it.
 *
 * Which is not what the cut does on its own: `medianCut` hands a colour to the
 * box it was sorted into and the box speaks with its heaviest member's voice,
 * so a colour sitting at the edge of its box can be far from that voice while
 * another box's colour is right beside it. On the owner's lorry (2026-09-24,
 * grid 256, 17352 art colours) that was 47.6% of painted cells going somewhere
 * other than the nearest slot: mean error ΔE 0.877 against 0.602, and 177 cells
 * visibly wrong (ΔE > 10) where the nearest slot leaves 26. It is the same
 * mistake on flat art, only smaller - `tests/palette/nearest-slot.mjs` measures
 * it on the synthetic livery, where it is 45 colours of 324.
 *
 * The reservation is unaffected: a reserved colour is in `colors` exactly as
 * drawn, so its nearest is itself at ΔE 0 and it still lands byte for byte.
 *
 * Exact, not approximate: the colours are walked outwards in lightness from the
 * source colour's own L and the walk stops where the bound above says nothing
 * closer can be left. Measured against a full 255-way CIEDE2000 scan on the
 * lorry: the same answer for all 17352 colours, 87 ms against 991 ms, 14.7
 * distance calculations per colour rather than 255.
 *
 * @param {Map<number, number>} counts every source colour
 * @param {number[]} colors the palette, packed 0xRRGGBB
 * @returns {Map<number, number>} source colour -> index into `colors`
 */
function assignNearest(counts, colors) {
  const n = colors.length;
  if (n === 0) return new Map();
  const L = new Float64Array(n);
  const A = new Float64Array(n);
  const B = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [l, a, b] = packedToLab(colors[i]);
    L[i] = l; A[i] = a; B[i] = b;
  }
  // Slot indices in order of lightness, so the walk below is a walk along one
  // array rather than a sort per colour.
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const byL = Array.from(order).sort((p, q) => L[p] - L[q]);
  order.set(byL);
  const sortedL = new Float64Array(n);
  for (let i = 0; i < n; i++) sortedL[i] = L[order[i]];

  /** @type {Map<number, number>} */
  const assign = new Map();
  for (const key of counts.keys()) {
    const [l, a, b] = packedToLab(key);
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedL[mid] < l) lo = mid + 1; else hi = mid;
    }
    let up = lo;
    let down = lo - 1;
    let best = Infinity;
    let pick = order[Math.min(lo, n - 1)];
    for (;;) {
      const gapUp = up < n ? sortedL[up] - l : Infinity;
      const gapDown = down >= 0 ? l - sortedL[down] : Infinity;
      const gap = gapUp < gapDown ? gapUp : gapDown;
      if (!(gap <= SL_MAX * best)) break;
      const i = gapUp <= gapDown ? order[up++] : order[down--];
      const d = ciede2000(l, a, b, L[i], A[i], B[i]);
      if (d < best) { best = d; pick = i; }
    }
    assign.set(key, pick);
  }
  return assign;
}

/**
 * Collapse reservations nobody can tell apart, keeper-first.
 *
 * Candidates arrive heaviest first, so the colour covering the most art is
 * always the keeper and the rest of its group follow it; ties keep the order
 * the caller's sort produced, which is the same on every run. A group past the
 * cap is not reserved at all - neither keeper nor followers - and goes back to
 * the cut whole, rather than half of it being held back from a box it belongs
 * in.
 *
 * @param {Array<[number, number]>} candidates packed colour, weight; heaviest first
 * @param {number} cap how many slots the reservation may spend at most
 * @returns {{heavy: number[], followers: number[], alias: Map<number, number>}}
 *   keepers in slot order, the colours folded onto them (heaviest first), and
 *   every reserved source colour mapped to the slot it lands in
 */
function foldReservations(candidates, cap) {
  /** @type {number[]} keepers, in the order they were found */
  const heavy = [];
  /** @type {number[]} folded colours, heaviest first, for the caller to undo */
  const followers = [];
  /** @type {number[][]} Lab of each keeper */
  const labs = [];
  /** @type {number[][]} every source colour each keeper speaks for */
  const groups = [];
  for (const [k] of candidates) {
    const [l, a, b] = packedToLab(k);
    let found = -1;
    for (let i = 0; i < heavy.length; i++) {
      if (ciede2000(l, a, b, labs[i][0], labs[i][1], labs[i][2]) <= RESERVE_FOLD_DELTA_E) {
        found = i;
        break;
      }
    }
    if (found >= 0) {
      groups[found].push(k);
      followers.push(k);
      continue;
    }
    if (heavy.length >= cap) continue; // no slot left to open a new group with
    heavy.push(k);
    labs.push([l, a, b]);
    groups.push([k]);
  }
  /** @type {Map<number, number>} */
  const alias = new Map();
  for (let i = 0; i < heavy.length; i++) for (const k of groups[i]) alias.set(k, i);
  return { heavy, followers, alias };
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
