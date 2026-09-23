// @ts-check
/**
 * The CIEDE2000 transcription against published reference pairs.
 *
 * The formula in `src/core/color.js` is fifty lines of trigonometry with three
 * special cases (the hue of a neutral colour, the 360-degree wrap of a hue
 * mean, and the rotation term around blue). Every one of them is silent when
 * wrong: the palette would keep choosing colours, just slightly worse ones, and
 * nothing would fail. That is what this check is for.
 *
 * The pairs are from the test data of Sharma, Wu and Dalal, "The CIEDE2000
 * Color-Difference Formula" (2005) - the set deliberately built to hit those
 * special cases. Every expected value below was reproduced independently from
 * the paper's equations before being written down here, 2026-09-24; the
 * tolerance is 1e-4 because the published table is rounded to four decimals,
 * and the worst of the eighteen lands 4.9e-5 from it.
 *
 * Red without the fix: dropping the 360-degree wrap correction from the hue
 * mean puts pair 8 off by 0.0871, measured 2026-09-24 by deleting those two
 * lines. The neutral-colour rule turns out not to be load-bearing in
 * JavaScript - `Math.atan2(0, 0)` is 0 there anyway - so no pair moves when it
 * goes. It stays in the source because the formula says so, not because this
 * check would catch its removal.
 */

import { ciede2000 } from '../../src/core/color.js';

/** L1, a1, b1, L2, a2, b2, expected dE00. */
const PAIRS = [
  [50, 2.6772, -79.7751, 50, 0, -82.7485, 2.0425],
  [50, 3.1571, -77.2803, 50, 0, -82.7485, 2.8615],
  [50, -1.3802, -84.2814, 50, 0, -82.7485, 1.0000],
  [50, 0, 0, 50, -1, 2, 2.3669],
  [50, 2.4900, -0.0010, 50, -2.4900, 0.0009, 7.1792],
  [50, 2.4900, -0.0010, 50, -2.4900, 0.0011, 7.2195],
  [50, -0.0010, 2.4900, 50, 0.0009, -2.4900, 4.8045],
  [50, 2.5, 0, 50, 0, -2.5, 4.3065],
  [50, 2.5, 0, 73, 25, -18, 27.1492],
  [50, 2.5, 0, 50, 3.1736, 0.5854, 1.0000],
  [50, 2.5, 0, 50, 1.8634, 0.5757, 1.0000],
  [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
  [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.2630],
  [22.7233, 20.0904, -46.6940, 23.0331, 14.9730, -42.5619, 2.0373],
  [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
  [2.0776, 0.0795, -1.1350, 0.9033, -0.0636, -0.5514, 0.9082],
  [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
  [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
];

/** The paper quotes four decimals, so anything past 1e-4 is a real difference. */
const TOLERANCE = 1e-4;

export function run() {
  let worst = 0;
  let worstAt = -1;
  for (let i = 0; i < PAIRS.length; i++) {
    const [L1, a1, b1, L2, a2, b2, want] = PAIRS[i];
    const off = Math.abs(ciede2000(L1, a1, b1, L2, a2, b2) - want);
    if (off > worst) {
      worst = off;
      worstAt = i + 1;
    }
  }
  const ok = worst <= TOLERANCE;
  return {
    ok,
    detail: ok
      ? PAIRS.length + '/' + PAIRS.length + ' reference pairs, worst off by ' + worst.toExponential(1)
      : 'pair ' + worstAt + ' off by ' + worst.toFixed(4) + ' (tolerance ' + TOLERANCE + ')',
  };
}
