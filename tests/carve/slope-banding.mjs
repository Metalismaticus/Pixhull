// @ts-check
/**
 * Count the corners of a slope where the tread and the riser disagree.
 *
 * A surface at 45 degrees is a staircase once it is on a grid. Its flat treads
 * face up and its upright risers face forward, so without help the top drawing
 * paints one and the head-on drawing the other - and since the two drawings
 * never quite agree about where the slope starts, the staircase alternates
 * between them. That alternation is the banding reported on the cab.
 *
 * The measure is the corner: a voxel with both its +Y and its +Z face open,
 * sitting on a staircase rather than at a lone edge. Either the two faces carry
 * the same colour or they do not.
 *
 * Two shapes: a clean 45-degree wedge, and a body with a sloped nose that also
 * has flat panels and square corners, so a fix that recolours everything in
 * sight fails here rather than passing.
 *
 * Red without the fix: pass `slopeColour: false` to `carve` - which is the
 * carve with `repaintSlopes` taken out - and all 1408 corners disagree instead
 * of 84. Measured 2026-09-23.
 *
 * The 84 that remain are the real residue at the ends of a slope, where the
 * blurred field has too little to read. They are a ceiling, not a target: the
 * number may fall, and `ROADMAP` item 7 (photo hull) is expected to lower it.
 */

import { carve } from '../../src/core/carve.js';
import { Palette } from '../../src/core/palette.js';
import { DIR_PY, DIR_PZ } from '../../src/core/volume.js';
import { SHAPES, viewsOfShape } from '../fixtures.mjs';

const N = 32;

/** Measured on this bench, 2026-09-23: wedge 60/1024, cab 24/384. */
const CEILING = 84;

/** @param {string} name */
function measure(name) {
  const solid = SHAPES[name](N);
  const views = viewsOfShape(N, solid);
  const palette = new Palette();
  const { volume } = carve(views, N, palette, { mirrorMissing: false });

  let corners = 0;
  let disagree = 0;
  volume.forEachSolid((x, y, z) => {
    // Both faces of the corner have to be open, or there is nothing to compare.
    if (volume.get(x, y + 1, z) || volume.get(x, y, z + 1)) return;
    // And the corner has to belong to a staircase. A lone convex edge - the top
    // front edge of a box - is meant to show two colours, and counting it would
    // make a correct model look banded.
    if (!volume.get(x, y + 1, z - 1) && !volume.get(x, y - 1, z + 1)) return;
    corners++;
    if (volume.getFace(x, y, z, DIR_PY) !== volume.getFace(x, y, z, DIR_PZ)) disagree++;
  });
  return { corners, disagree };
}

export function run() {
  const wedge = measure('wedge');
  const cab = measure('cab');
  const corners = wedge.corners + cab.corners;
  const disagree = wedge.disagree + cab.disagree;
  return {
    ok: disagree <= CEILING,
    detail: disagree + '/' + corners + ' slope corners disagree (ceiling ' + CEILING
      + '; wedge ' + wedge.disagree + '/' + wedge.corners + ', cab ' + cab.disagree + '/' + cab.corners + ')',
  };
}
