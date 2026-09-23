// @ts-check
/**
 * The fill's preview and the fill's edit are the same region, and the fill
 * admits it when it stops at a limit.
 *
 * Before this the fill was silently cut off at 400 000 faces: the user got a
 * half-filled surface and no word about why. The number now shown in the status
 * bar comes from the same walk that does the filling, so the outline drawn
 * before the click and the faces changed after it cannot disagree.
 *
 * Red without the fix:
 *   - have `collectFillRegion` return `capped: false` always, and the capped
 *     case reports a limit reached as a complete answer;
 *   - let `applyTool` go back to returning only `{changed}`, and the count the
 *     status bar prints is `undefined` rather than the faces touched.
 */

import { Volume } from '../../src/core/volume.js';
import { collectFillRegion, applyTool, FILL_LIMIT } from '../../src/edit/tools.js';

/**
 * A solid slab, every face painted with `colour`. Its +Z surface is N x N
 * faces, which is the region a fill started anywhere on it must reach.
 * @param {number} n @param {number} colour
 */
function slab(n, colour) {
  const vol = new Volume(n, n, 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      for (let z = 0; z < 2; z++) {
        vol.set(x, y, z, true);
        vol.setAllFaces(x, y, z, colour);
      }
    }
  }
  return vol;
}

export function run() {
  /** @type {string[]} */
  const bad = [];
  const TOP = 4; // +Z

  // The whole top surface, and nothing buried under it.
  const vol = slab(16, 20);
  const whole = collectFillRegion(vol, { x: 8, y: 8, z: 1, face: TOP }, FILL_LIMIT);
  if (whole.cells.length !== 256) bad.push('the 16x16 top reached ' + whole.cells.length + ' faces, want 256');
  if (whole.capped) bad.push('a 256-face surface reported itself capped');
  if (whole.target !== 20) bad.push('the region target colour is ' + whole.target + ', want 20');

  // A limit below the surface stops the walk and the walk says so.
  const short = collectFillRegion(vol, { x: 8, y: 8, z: 1, face: TOP }, 40);
  if (!short.capped) bad.push('a walk stopped at 40 of 256 faces did not report it');
  if (short.cells.length < 40 || short.cells.length > 44) {
    bad.push('a limit of 40 collected ' + short.cells.length + ' faces');
  }

  // Exactly at the surface's size there is nothing left to visit, so the walk
  // is complete and must not claim otherwise.
  const exact = collectFillRegion(slab(8, 20), { x: 4, y: 4, z: 1, face: TOP }, 1000);
  if (exact.cells.length !== 64) bad.push('the 8x8 top reached ' + exact.cells.length + ' faces, want 64');
  if (exact.capped) bad.push('a fill that ran out of surface called itself capped');

  // What the edit reports is what the walk found.
  const painted = slab(8, 20);
  const done = applyTool(painted, { x: 4, y: 4, z: 1, face: TOP }, { tool: 'fill', color: 33 });
  if (done.count !== 64) bad.push('the fill reports ' + done.count + ' faces changed, want 64');
  if (!done.changed) bad.push('a fill of 64 faces reported no change');
  if (done.capped) bad.push('a completed fill reported itself capped');
  if (painted.getFace(0, 0, 1, TOP) !== 33) bad.push('the far corner of the surface was not filled');
  // The faces under the surface keep their colour: the fill is a skin, not a
  // solid flood.
  if (painted.getFace(0, 0, 0, TOP) !== 20) bad.push('a buried face was filled');

  // Filling what is already that colour changes nothing and says nothing.
  const again = applyTool(painted, { x: 4, y: 4, z: 1, face: TOP }, { tool: 'fill', color: 33 });
  if (again.count !== 0 || again.changed) bad.push('a fill onto its own colour reported ' + again.count);

  // Brush tools count too, or the report after a stroke has nothing to print.
  const brush = slab(8, 20);
  const painted3 = applyTool(brush, { x: 4, y: 4, z: 1, face: TOP }, { tool: 'paint', color: 44, brush: 1 });
  // A 3-cube centred on (4,4,1) in a grid 2 voxels deep holds 3*3*2 = 18 solid
  // voxels; the layer above the slab is empty and cannot be painted.
  if (painted3.count !== 18) bad.push('a 3-cube brush reports ' + painted3.count + ' voxels, want 18');

  return {
    ok: bad.length === 0,
    detail: bad.length === 0
      ? '256 and 64 faces walked, 40 capped, edit and walk agree, brush 18'
      : bad.slice(0, 3).join('; '),
  };
}
