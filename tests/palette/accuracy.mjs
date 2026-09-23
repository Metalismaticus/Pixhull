// @ts-check
/**
 * Colour accuracy: how close the finished model is to the drawing it was
 * carved from, once the palette has had its say.
 *
 * The measurement that made this a queue item: accuracy by grid alone rises
 * 67.9% -> 92.4% from 256 to 512, while accuracy including the palette only
 * reaches 47.5% -> 55.8%. The palette, not the grid, is where the colour goes.
 *
 * The fixture is `makeLivery`: a bare cube whose six drawings carry 324
 * distinct colours - 204 near-white shades that each cover a lot of cells, and
 * accents that each cover few. The geometry is deliberately trivial, so
 * anything measured here is the palette's doing and not the carve's.
 *
 * Three numbers come out, all over the cells where the model exists:
 *
 * - exact: the face carries the drawing's colour byte for byte;
 * - dE <= 2: not the same colour, but nobody can see the difference
 *   (CIEDE2000; 1 is the threshold of noticing);
 * - dE > 10: a different colour. This is the "red cab came out grey" number,
 *   and the one the fix exists for.
 *
 * Red without the fix, measured 2026-09-24 by reverting `seedPalette` to
 * interning colours in order of coverage and `Palette.nearest` to redmean:
 * 816 of 24576 cells - 3.3% of the model - come out a visibly different
 * colour, the worst of them off by dE 23.5, and 96.2% are within dE 2. With
 * the fix: nothing above dE 10 at all, worst cell dE 1.0, 100% within dE 2.
 *
 * Exact matches go the other way, 86.8% -> 82.4%, and that is the trade being
 * made on purpose: the quantiser merges near-whites that differ by dE 0.6 in
 * order to keep the accents that were being dropped entirely. Which is why the
 * check is written on perceptual distance and not on byte equality.
 *
 * The thresholds below are mine, set under the measured result with room to
 * breathe: no cell may be visibly wrong, and 99% must be indistinguishable.
 */

import { carve } from '../../src/core/carve.js';
import { Palette } from '../../src/core/palette.js';
import { VIEW_GEOM } from '../../src/core/views.js';
import { ciede2000Packed } from '../../src/core/color.js';
import { makeLivery, viewsFromImages } from '../fixtures.mjs';

/** Grid. 64 is enough for 324 colours to meet 255 slots. */
const N = 64;
/** Share of cells that must be indistinguishable from the drawing. */
const NEAR_MIN = 0.99;
/** dE above this is a different colour, not a shade of the same one. */
const GROSS_DE = 10;

export function run() {
  const views = viewsFromImages(makeLivery(N));
  const palette = new Palette();
  const { volume } = carve(views, N, palette, { mirrorMissing: false });

  let cells = 0;
  let exact = 0;
  let near = 0;
  let gross = 0;
  let worst = 0;

  for (const view of views) {
    const geom = VIEW_GEOM[view.name];
    const { mask, rgb } = view.sampleCells(N);
    for (let v = 0; v < N; v++) {
      for (let u = 0; u < N; u++) {
        const o = v * N + u;
        if (!mask[o]) continue;
        for (let d = 0; d < N; d++) {
          const [x, y, z] = geom.ray(u, v, d, N);
          if (!volume.get(x, y, z)) continue;
          const got = palette.colors[volume.getFace(x, y, z, geom.face)];
          const want = rgb[o];
          const de = got === want ? 0 : ciede2000Packed(got, want);
          cells++;
          if (de === 0) exact++;
          if (de <= 2) near++;
          if (de > GROSS_DE) gross++;
          if (de > worst) worst = de;
          break;
        }
      }
    }
  }

  const pc = (n) => (cells === 0 ? '0.0%' : ((100 * n) / cells).toFixed(1) + '%');
  const ok = cells > 0 && gross === 0 && near >= cells * NEAR_MIN;
  return {
    ok,
    detail: pc(exact) + ' exact, ' + pc(near) + ' within dE 2, '
      + gross + '/' + cells + ' visibly wrong (dE > ' + GROSS_DE + '), worst dE '
      + worst.toFixed(1) + '; ' + (palette.size - 1) + ' of 324 colours kept',
  };
}
