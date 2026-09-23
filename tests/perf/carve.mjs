// @ts-check
/**
 * How long a carve takes and how much memory it holds, at 256 / 384 / 512.
 *
 * This is a measurement first and a check second. The numbers go into the
 * report so a change that doubles the cost is noticed, but the pass mark is
 * deliberately slack - three times the recorded figure - because it runs on
 * whatever machine happens to be free, and a check that goes red on a busy
 * laptop teaches people to ignore red.
 *
 * Long by nature: drawing the views and carving three grids takes around half a
 * minute, so the bench leaves this group out unless it is asked for by name.
 *
 *   node tests/run.mjs perf/
 *
 * The shape is vehicle-proportioned rather than a cube. A cube would fill the
 * whole grid, and the blurred field the carve builds over a full 512 bounding
 * box costs half a gigabyte - a number about the fixture, not about the carve.
 */

import { carve } from '../../src/core/carve.js';
import { Palette } from '../../src/core/palette.js';
import { SHAPES, viewsOfShape } from '../fixtures.mjs';

/**
 * Measured on this bench, 2026-09-23, Node 22 on a Windows laptop: carve took
 * 1.13 / 3.38 / 8.64 s and left the process at 87 / 149 / 243 MB resident.
 * `docs/TESTING.md` records 1.1 / 3.7 / 11.0 s and 105 / 175 / 240 MB for the
 * lorry art, which is the same order - the synthetic model is a little lighter.
 */
const BASELINE = [
  { N: 256, ms: 1130, mb: 87 },
  { N: 384, ms: 3380, mb: 149 },
  { N: 512, ms: 8640, mb: 243 },
];

/** How far past the baseline counts as a regression rather than a slow day. */
const SLACK = 3;

export function run() {
  /** @type {string[]} */
  const line = [];
  /** @type {string[]} */
  const bad = [];

  for (const base of BASELINE) {
    const views = viewsOfShape(base.N, SHAPES.lorry(base.N));
    const t0 = performance.now();
    const { volume } = carve(views, base.N, new Palette(), { mirrorMissing: false });
    const ms = performance.now() - t0;
    const mb = process.memoryUsage().rss / 1048576;
    line.push(base.N + ': ' + (ms / 1000).toFixed(1) + 's ' + Math.round(mb) + 'MB');

    if (volume.solidCount === 0) bad.push(base.N + ' carved nothing');
    if (ms > base.ms * SLACK) bad.push(base.N + ' took ' + (ms / 1000).toFixed(1) + 's, over ' + SLACK + 'x of ' + (base.ms / 1000).toFixed(1) + 's');
    if (mb > base.mb * SLACK) bad.push(base.N + ' held ' + Math.round(mb) + 'MB, over ' + SLACK + 'x of ' + base.mb + 'MB');
  }

  return {
    ok: bad.length === 0,
    detail: line.join(' · ') + (bad.length === 0 ? '' : ' | ' + bad.join('; ')),
  };
}
