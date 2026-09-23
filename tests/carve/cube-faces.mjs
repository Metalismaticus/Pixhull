// @ts-check
/**
 * A bare cube, drawn in six different colours: no exposed face may end up
 * wearing the colour of a view that is not looking at it.
 *
 * A cube has no slope anywhere, so every one of its 2400 exposed faces has
 * exactly one drawing entitled to it, and the expected answer can be written
 * down rather than eyeballed. Each of the six views is given its own colour
 * precisely so that a face taking the wrong one shows up; with the five sides
 * sharing a colour the mistake would be invisible.
 *
 * Red without the fix: drop the "is there a step above or below" question in
 * `repaintSlopes` and 232 of the 2400 faces are recoloured from a drawing that
 * cannot see them - the cube's twelve edges lean in the blurred field exactly
 * as a 45-degree slope does. Measured by deleting that line, 2026-09-23.
 */

import { carve } from '../../src/core/carve.js';
import { Palette } from '../../src/core/palette.js';
import { DIRS } from '../../src/core/volume.js';
import { VIEW_GEOM, VIEW_NAMES } from '../../src/core/views.js';
import { VIEW_COLOUR, makeFlat, viewsFromImages } from '../fixtures.mjs';

const N = 20;

export function run() {
  // The six views of a cube are six flat fills, so they are drawn directly
  // rather than projected - it is the shortest statement of the fixture.
  /** @type {Record<string, any>} */
  const images = {};
  for (const name of VIEW_NAMES) images[name] = makeFlat(N, N, VIEW_COLOUR[name]);
  const views = viewsFromImages(images);
  const palette = new Palette();
  const { volume } = carve(views, N, palette, { mirrorMissing: false });

  /** face index -> the view that owns it */
  const owner = {};
  for (const name of VIEW_NAMES) owner[VIEW_GEOM[name].face] = name;

  let exposed = 0;
  let wrong = 0;
  /** @type {string|null} */
  let first = null;

  volume.forEachSolid((x, y, z) => {
    for (let d = 0; d < 6; d++) {
      const [dx, dy, dz] = DIRS[d];
      if (volume.get(x + dx, y + dy, z + dz)) continue;
      exposed++;
      const got = palette.rgb(volume.getFace(x, y, z, d)).join(',');
      const want = VIEW_COLOUR[owner[d]].join(',');
      if (got === want) continue;
      wrong++;
      if (!first) first = owner[d] + ' face at ' + x + ',' + y + ',' + z + ' is ' + got + ' not ' + want;
    }
  });

  // A cube of 20 has 6 * 400 open faces; anything else means the carve did not
  // reproduce the cube and the colour count below would be measuring nothing.
  if (exposed !== 2400) {
    return { ok: false, detail: 'expected 2400 open faces, carved ' + exposed };
  }
  return {
    ok: wrong === 0,
    detail: wrong === 0 ? '0/2400 faces repainted by a view that cannot see them'
      : wrong + '/2400 repainted; first: ' + first,
  };
}
