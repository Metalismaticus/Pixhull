// @ts-check
/**
 * Every art colour lands on the palette colour nearest it.
 *
 * The cut chooses which 255 colours survive; it does not choose, and must not
 * choose, which of them a given colour is then shown as. `medianCut` sorted a
 * colour into a box and let the box answer with its heaviest member, so a
 * colour at the edge of its box came out wearing that member's colour even
 * when another box's colour sat right beside it. Nothing about it is visible
 * as a wrong palette - the palette is the same - and everything about it is
 * visible on the model: one cell of a flat panel resolved two boxes over is a
 * coloured dot on an even surface, which is the defect this was found under
 * (`docs/BUGS.md`, "Разноцветные крапины на ровных поверхностях").
 *
 * The question asked here needs no threshold, which is why it is asked this
 * way: for every source colour, is the slot it was given the slot with the
 * smallest ΔE2000? Either it is or it is not, and a tuned number cannot make
 * a wrong answer pass.
 *
 * Two fixtures, both synthetic:
 *
 *  - the livery (`makeLivery`, the fixture built for the palette problem):
 *    324 colours into 255 slots, going through `sampleCells` as a real import
 *    does. Red without the fix, measured 2026-09-24: 45 of 324 colours
 *    misplaced, 2884 of 24576 cells, worst ΔE gain 0.8;
 *  - a body-and-badges histogram, where the cut is under real pressure: a
 *    dense near-white cluster plus 400 saturated colours into 64 slots. Red
 *    without the fix: 220 of 440 colours misplaced, and the worst of them worn
 *    at ΔE 25.4 while the slot beside it sat at ΔE 3.6 - visibly wrong, not a
 *    rounding difference.
 *
 * Both were measured by putting `src/core/quantize.js` back to the revision
 * before the fix (2026-09-24) and running this file.
 *
 * The owner's lorry is deliberately not here (`docs/TESTING.md`: the bench
 * takes no one's art). Measured on it by hand the same day: 9684 of 17352
 * colours misplaced, 47.6% of painted cells, mean error ΔE 0.877 -> 0.602,
 * cells visibly wrong 177 -> 26, and the isolated dots on flat panels that the
 * import itself makes 108 -> 41.
 */

import { quantize } from '../../src/core/quantize.js';
import { packedToLab, ciede2000 } from '../../src/core/color.js';
import { makeLivery, viewsFromImages } from '../fixtures.mjs';

/** Grid the livery is sampled on; 64 is what the other palette checks use. */
const N = 64;
/** Slots for the histogram fixture. Small, so the cut is under pressure. */
const MAX = 64;

/**
 * The histogram of the livery as an import builds it: every view sampled onto
 * the grid, every distinct colour counted once per cell.
 * @returns {Map<number, number>}
 */
function liveryCounts() {
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const view of viewsFromImages(makeLivery(N))) {
    const { mask, rgb } = view.sampleCells(N);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      counts.set(rgb[i], (counts.get(rgb[i]) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * A white body with painted detail, stated as a histogram: 40 near-whites
 * covering most of the art and 400 saturated colours covering little. The
 * counts are chosen, not measured - what they have to produce is a cut that
 * cannot give the accents a slot each, which is when a box starts speaking for
 * colours far from its own voice.
 * @returns {Map<number, number>}
 */
function bodyAndBadges() {
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (let i = 0; i < 40; i++) {
    const packed = ((0xf0 + (i % 5)) << 16) | ((0xf0 + (((i / 5) | 0) % 5)) << 8) | (0xf0 + (((i / 25) | 0) % 5));
    counts.set(packed, 2000 - i);
  }
  for (let i = 0; i < 400; i++) {
    const h = (i * 360) / 400;
    const v = 0.35 + 0.65 * ((i % 7) / 6);
    const s = 0.55 + 0.45 * ((i % 5) / 4);
    const packed = hsvPacked(h, s, v);
    if (counts.has(packed)) continue;
    counts.set(packed, 3 + (i % 4));
  }
  return counts;
}

/** @param {number} h degrees @param {number} s @param {number} v @returns {number} packed */
function hsvPacked(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return (f(5) << 16) | (f(3) << 8) | f(1);
}

/**
 * How many colours were sent somewhere other than their nearest slot, by a
 * full scan of the palette - the slow, obviously-correct search the fast one
 * inside `quantize` has to agree with.
 *
 * @param {Map<number, number>} counts
 * @param {{colors: number[], assign: Map<number, number>}} q
 */
function misplaced(counts, q) {
  const labs = q.colors.map(packedToLab);
  let colours = 0;
  let cells = 0;
  let totalCells = 0;
  let worst = 0;
  /** @type {string} */
  let first = '';
  for (const [key, weight] of counts) {
    totalCells += weight;
    const [l, a, b] = packedToLab(key);
    const got = /** @type {number} */ (q.assign.get(key));
    const mine = ciede2000(l, a, b, labs[got][0], labs[got][1], labs[got][2]);
    let best = mine;
    let pick = got;
    for (let i = 0; i < labs.length; i++) {
      const d = ciede2000(l, a, b, labs[i][0], labs[i][1], labs[i][2]);
      if (d < best) { best = d; pick = i; }
    }
    if (pick === got) continue;
    colours++;
    cells += weight;
    if (mine - best > worst) {
      worst = mine - best;
      first = '#' + key.toString(16).padStart(6, '0') + ' sits at ΔE ' + mine.toFixed(1)
        + ' from slot ' + got + ' with slot ' + pick + ' at ΔE ' + best.toFixed(1);
    }
  }
  return { colours, cells, totalCells, worst, first };
}

export function run() {
  /** @type {string[]} */
  const bad = [];
  let cases = 0;

  const livery = liveryCounts();
  const lq = quantize(livery, 255);
  const lm = misplaced(livery, lq);
  cases++;
  if (lm.colours !== 0) {
    bad.push('livery: ' + lm.colours + ' of ' + livery.size + ' colours (' + lm.cells + ' of '
      + lm.totalCells + ' cells) not on the nearest slot; worst ' + lm.first);
  }

  const badges = bodyAndBadges();
  const bq = quantize(badges, MAX);
  const bm = misplaced(badges, bq);
  cases++;
  if (bm.colours !== 0) {
    bad.push('body and badges: ' + bm.colours + ' of ' + badges.size + ' colours not on the '
      + 'nearest slot; worst ' + bm.first);
  }

  // A palette that is not full has nothing to choose between, and a fixture
  // that stopped overflowing would make the whole check vacuous.
  cases++;
  if (bq.colors.length !== MAX) {
    bad.push('body and badges: palette ' + bq.colors.length + ' colours, want ' + MAX
      + ' - the fixture stopped pressing on the cut');
  }

  return {
    ok: bad.length === 0,
    detail: bad.length === 0
      ? cases + ' cases; livery 0 of ' + livery.size + ' colours misplaced, body and badges 0 of '
        + badges.size + ' into ' + MAX + ' slots'
      : bad.join('; '),
  };
}
