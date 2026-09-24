// @ts-check
/**
 * The cell grid only turns on at a zoom where its cells can be told apart.
 *
 * `GRID_MIN_ZOOM` was proposed by the screen specification and justified with
 * "at 8 a cell is about the height of a panel label", which measurement
 * contradicts: under the 2:1 dimetric the app opens in, the top face packs its
 * grid lines 0.5774 voxel apart on screen, so at 8 device pixels per voxel the
 * lines sit 4.6 px apart - a 1 px line with a 3.6 px hole beside it. The
 * number is now measured instead of argued, and this check keeps it measured.
 *
 * `src/main.js` imports the DOM and cannot be loaded in Node
 * (`docs/TESTING.md`), so the constant is read out of the source and the
 * spacing is computed through the real camera.
 *
 * Red without the fix: put `GRID_MIN_ZOOM` back to 8 and the first case fails
 * with 4.62 px against the 6 px floor.
 *
 * MINE, not the owner's: the 6 px floor. Lines are 1 device pixel (screen
 * specification, section 4), so 6 px of spacing leaves a 5 px hole to aim
 * into - five times the line. Nothing in `docs/DESIGN.md` fixes this number.
 */

import { readFile } from 'node:fs/promises';
import { OrthoCamera } from '../../src/gfx/camera.js';
import { transformPoint } from '../../src/gfx/glutil.js';

/** Device pixels between neighbouring grid lines that the check insists on. */
const MIN_SPACING_PX = 6;

/**
 * Screen distance between neighbouring grid lines, in voxel units, for the
 * tightest of the three faces under the current camera.
 * @param {OrthoCamera} cam
 * @returns {number}
 */
function tightestSpacing(cam) {
  const view = cam.viewMatrix();
  const o = transformPoint(view, 0, 0, 0);
  /** @param {number} x @param {number} y @param {number} z */
  const edge = (x, y, z) => {
    const p = transformPoint(view, x, y, z);
    return [p[0] - o[0], p[1] - o[1]];
  };
  const axes = [edge(1, 0, 0), edge(0, 1, 0), edge(0, 0, 1)];

  let tightest = Infinity;
  // A face is spanned by two of the three axes; the lines running along one of
  // them sit |a x b| / |a| apart, which is the width of the cell across them.
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (i === j) continue;
      const a = axes[i];
      const b = axes[j];
      const area = Math.abs(a[0] * b[1] - a[1] * b[0]);
      const len = Math.hypot(a[0], a[1]);
      if (len > 0) tightest = Math.min(tightest, area / len);
    }
  }
  return tightest;
}

export async function run() {
  /** @type {string[]} */
  const bad = [];

  const src = await readFile(new URL('../../src/main.js', import.meta.url), 'utf8');
  const m = /const GRID_MIN_ZOOM = (\d+);/.exec(src);
  if (!m) {
    return { ok: false, detail: 'GRID_MIN_ZOOM not found in src/main.js' };
  }
  const threshold = +m[1];

  // The camera the app opens in: 45 degrees of yaw, 2:1 dimetric pitch.
  const cam = new OrthoCamera();
  const perVoxel = tightestSpacing(cam);
  const atThreshold = perVoxel * threshold;
  if (atThreshold < MIN_SPACING_PX) {
    bad.push('at ' + threshold + 'x the tightest cell is ' + atThreshold.toFixed(2)
      + ' px across, under the ' + MIN_SPACING_PX + ' px floor');
  }

  // A threshold higher than it needs to be hides the grid from zooms where it
  // would read perfectly well, which is its own kind of lie. One step of slack
  // above the geometric floor is allowed and no more: 11 is where the spacing
  // first clears 6 px, 12 is where a second pair of eyes reported being able
  // to count the cells, and that one step is the whole difference. MINE.
  const below = perVoxel * (threshold - 2);
  if (threshold > 2 && below >= MIN_SPACING_PX) {
    bad.push('at ' + (threshold - 2) + 'x the cell is already ' + below.toFixed(2)
      + ' px across, so the threshold is more than one step above the measurement');
  }

  // The zoom control steps by one, so any integer threshold is reachable; a
  // threshold above the ceiling would turn the grid off for good.
  if (threshold > 64) bad.push('threshold ' + threshold + ' is above the 64x zoom ceiling');

  // The default zoom is 4: the grid is expected to start off, which is why the
  // checkbox explains itself in words.
  if (perVoxel * cam.pixelsPerVoxel >= MIN_SPACING_PX) {
    bad.push('the default zoom already clears the floor - the hint under the checkbox now lies');
  }

  return {
    ok: bad.length === 0,
    detail: bad.length
      ? bad[0]
      : 'threshold ' + threshold + 'x: tightest cell ' + atThreshold.toFixed(2)
        + ' px across (' + below.toFixed(2) + ' px two steps below, '
        + (perVoxel * cam.pixelsPerVoxel).toFixed(2) + ' px at the default 4x)',
  };
}
