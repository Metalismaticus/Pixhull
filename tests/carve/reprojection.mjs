// @ts-check
/**
 * Project the finished model back through each view and compare it with the
 * drawing that view was carved from.
 *
 * Two things have to hold where the model exists: every pixel of a silhouette
 * must hit a voxel (no holes), and the face that view stares down must carry
 * that pixel's colour (no colour drift).
 *
 * Only shapes without a slope are used - the cube, a two-level step and a fin
 * one voxel thick. On a slope the carve recolours treads and risers from one
 * drawing on purpose, so a tread deliberately does not match the top view, and
 * demanding 0 there would be demanding the banding back. Slopes are measured by
 * `carve/slope-banding` instead.
 *
 * Red without the fix: drop the depth test in `repaintSlopes` - the line that
 * refuses a pixel belonging to whatever the view saw first - and the step loses
 * 8 of its 5536 cells to a colour from behind. Drop the step question as well
 * and it loses 402. Measured by deleting each line, 2026-09-23.
 */

import { carve } from '../../src/core/carve.js';
import { Palette } from '../../src/core/palette.js';
import { VIEW_GEOM } from '../../src/core/views.js';
import { SHAPES, viewsOfShape } from '../fixtures.mjs';

/** Grid per shape. The cube is small because its answer does not need room. */
const CASES = [
  { name: 'cube', N: 20 },
  { name: 'step', N: 32 },
  { name: 'fin', N: 32 },
];

export function run() {
  /** @type {string[]} */
  const bad = [];
  let cells = 0;
  let holes = 0;
  let wrong = 0;

  for (const { name, N } of CASES) {
    const solid = SHAPES[name](N);
    const views = viewsOfShape(N, solid);
    const palette = new Palette();
    const { volume } = carve(views, N, palette, { mirrorMissing: false });

    for (const view of views) {
      const geom = VIEW_GEOM[view.name];
      const { mask, color } = view.rasterize(N, palette);
      for (let v = 0; v < N; v++) {
        for (let u = 0; u < N; u++) {
          const o = v * N + u;
          if (!mask[o]) continue;
          let hit = false;
          for (let d = 0; d < N; d++) {
            const [x, y, z] = geom.ray(u, v, d, N);
            if (!volume.get(x, y, z)) continue;
            hit = true;
            cells++;
            if (volume.getFace(x, y, z, geom.face) !== color[o]) {
              wrong++;
              if (bad.length < 3) bad.push(name + '/' + view.name + ' at ' + u + ',' + v);
            }
            break;
          }
          if (!hit) {
            holes++;
            if (bad.length < 3) bad.push(name + '/' + view.name + ' hole at ' + u + ',' + v);
          }
        }
      }
    }
  }

  const ok = wrong === 0 && holes === 0;
  return {
    ok,
    detail: ok
      ? '0/' + cells + ' cells disagree, 0 holes (cube, step, fin)'
      : wrong + '/' + cells + ' disagree, ' + holes + ' holes; ' + bad.join(', '),
  };
}
