// @ts-check
/**
 * One drawing in two slots must still be caught.
 *
 * This is the case the diagnosis exists for: a sheet where the same picture
 * ended up in two cells. The carve still runs and still reports a voxel count,
 * so without the warning there is nothing to tell the artist why the model is
 * a block of debris.
 *
 * Three constructions, one per pair of axes, built from the demo's own
 * drawings so the input is generated code rather than anyone's art:
 * the side drawing in the front slot, the head-on drawing in the right slot,
 * and the top drawing in the front slot. The third one is the awkward member:
 * the fitter turns it a quarter, so it reaches the grid transposed, which is
 * why proportions are read from the drawing's own trim and not from the grid.
 *
 * Green here is only meaningful together with `views/lookalike-demo.mjs`:
 * this check passes for a diagnosis that warns about everything.
 *
 * Red without the diagnosis: raise `SHAPE_THRESHOLD` to 0.99 in
 * `src/core/diagnose.js` and the first case (shape 0.955) goes unreported.
 * Measured 2026-09-24.
 *
 * How red is *not* reproduced here: `PROPORTION_TOLERANCE`. All three cases
 * are one drawing twice, so every ratio is exactly 1.000, and tightening the
 * tolerance all the way down to 1.001 still leaves this check 30/0. Only the
 * upper side is guarded, and by the other check: above 1.92
 * `views/lookalike-demo.mjs` goes red. Do not read green here as evidence that
 * 1.15 is the right floor.
 */

import { carve } from '../../src/core/carve.js';
import { Palette } from '../../src/core/palette.js';
import { SourceView, fitViews } from '../../src/core/views.js';
import { buildDemoViews } from '../../src/demo.js';

const N = 32;

/**
 * @param {Record<string, {width: number, height: number, data: Uint8ClampedArray}>} images
 */
function lookalikesOf(images) {
  const views = Object.entries(images).map(([name, img]) => new SourceView(name, img));
  fitViews(views, N);
  return carve(views, N, new Palette(), { mirrorMissing: true }).stats.lookalikes;
}

export function run() {
  const demo = buildDemoViews();

  const cases = [
    { name: 'side drawing in the front slot', images: { front: demo.right, right: demo.right, top: demo.top }, pair: ['front', 'right'] },
    { name: 'head-on drawing in the right slot', images: { front: demo.front, right: demo.front, top: demo.top }, pair: ['front', 'right'] },
    { name: 'top drawing in the front slot', images: { front: demo.top, right: demo.right, top: demo.top }, pair: ['front', 'top'] },
  ];

  /** @type {string[]} */
  const missed = [];
  /** @type {string[]} */
  const caught = [];
  for (const c of cases) {
    const found = lookalikesOf(c.images).find(
      (l) => (l.a === c.pair[0] && l.b === c.pair[1]) || (l.a === c.pair[1] && l.b === c.pair[0]),
    );
    if (found) caught.push(`${c.pair[0]}/${c.pair[1]} ${found.similarity.toFixed(3)}`);
    else missed.push(c.name);
  }

  return {
    ok: missed.length === 0,
    detail: missed.length === 0
      ? `${caught.length} of ${cases.length} duplicates reported (shape ${caught.join(', ')})`
      : `${missed.length} of ${cases.length} duplicates went unreported: ${missed.join('; ')}`,
  };
}
