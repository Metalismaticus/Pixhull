// @ts-check
/**
 * The built-in demo must build without accusing itself.
 *
 * The first thing a new user does is press "Demo", and the first thing the
 * status line said was that one of the demo's own drawings was in the wrong
 * slot. The model was correct; the warning was not.
 *
 * Why it fired: `silhouetteSignature` normalises each silhouette into a
 * 32x32 stamp of its own bounding box, which throws proportions away. The
 * demo car is 12x10 of drawing head-on and 23x10 from the side, and once both
 * are squashed into the same square they overlap 0.81. The colour test that
 * was meant to catch exactly this did not: front and side share the vertical
 * axis, a car is striped top to bottom (tyres, body, glass, roof), and the
 * whole car is five colours, so the colours agreed 0.86 of the time.
 *
 * This is the demo itself, not a stand-in: `src/demo.js` paints into a plain
 * RGBA8 buffer rather than a canvas so that this check can carve the very
 * drawings the button loads.
 *
 * Red without the fix: drop the `proportions` argument in `carve`
 * (`src/core/carve.js`) or set `PROPORTION_TOLERANCE` above 1.92, and
 * front/right comes back as a lookalike at shape 0.806, colour 0.858.
 * Measured 2026-09-24.
 */

import { carve } from '../../src/core/carve.js';
import { Palette } from '../../src/core/palette.js';
import { SourceView, fitViews } from '../../src/core/views.js';
import { buildDemoViews } from '../../src/demo.js';

/** What the Demo button ends up on: `suggestGridSize` of these three drawings. */
const N = 32;

export function run() {
  const images = buildDemoViews();
  const views = Object.entries(images).map(([name, img]) => new SourceView(name, img));
  fitViews(views, N);

  const palette = new Palette();
  const { stats } = carve(views, N, palette, { mirrorMissing: true });

  const named = stats.lookalikes
    .map((l) => `${l.a}/${l.b} shape ${l.similarity.toFixed(3)}`)
    .join(', ');

  return {
    ok: stats.lookalikes.length === 0 && stats.solid > 0,
    detail: stats.lookalikes.length === 0
      ? `demo carves ${stats.solid} voxels with 0 lookalike warnings`
      : `demo raised ${stats.lookalikes.length} lookalike warning(s): ${named}`,
  };
}
