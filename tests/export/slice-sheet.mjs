// The PNG slice sheet: every voxel lands on its own pixel, the pixel carries
// the colour a stack actually shows, and the rule that picks that colour is
// the same one `.vox` uses.
//
// What it guards, and how each part goes red (all checked by hand 2026-09-24):
//
// - **Placement.** Drop `- box.min[0]` from the `px` line in
//   `src/export/slices.js` and the fin - the one shape that does not touch the
//   grid's x=0 - fails with `10 of 400 voxels misplaced`.
// - **The facing step.** Take the `facing` branch out of `voxelColor`
//   (`src/export/voxelcolor.js`) and five cases fail at once: 40, 36, 40 and
//   20 visible pixels stop being the top face on cube, wedge, step and fin,
//   and the hand-painted voxel comes out `0,0,0` where its top face is white.
//   That is the same thing the lorry measured: 121 of 28 465 visible pixels at
//   256 change colour, and not by a little.
// - **One rule, not two.** Let `.vox` name a facing of its own - `facing: 2`
//   in `exportVox` - and the third case catches the drift on the cab: `34 of
//   6380 voxels disagree with the shared rule`. It reads the XYZI chunk back
//   and compares it to `voxelColor` voxel for voxel.
// - **The ceiling.** Raise `SLICE_MAX_SHEET` to 99999 and the last case fails
//   with `a 11776x11776 sheet was called buildable`: a sheet no browser canvas
//   can allocate would be reported as buildable and then attempted.

import { carve } from '../../src/core/carve.js';
import { Palette } from '../../src/core/palette.js';
import { Volume, DIR_PY, DIR_PX, DIR_NX } from '../../src/core/volume.js';
import { packSliceSheet, planSlices, SLICE_MAX_SHEET } from '../../src/export/slices.js';
import { voxelColor } from '../../src/export/voxelcolor.js';
import { exportVox } from '../../src/export/vox.js';
import { SHAPES, viewsOfShape } from '../fixtures.mjs';

const N = 20;

/** @param {string} name */
function build(name) {
  const solid = SHAPES[name](N);
  const palette = new Palette();
  const views = viewsOfShape(N, solid);
  const { volume } = carve(views, N, palette, { mirrorMissing: false });
  return { volume, palette };
}

/**
 * Every solid voxel is one opaque pixel in its own layer's cell, and nothing
 * else is opaque.
 */
function placement(volume, sheet) {
  const { image, plan } = sheet;
  let solid = 0;
  let misplaced = 0;
  const seen = new Set();
  volume.forEachSolid((x, y, z) => {
    solid++;
    const layer = y - plan.box.min[1];
    const px = (layer % plan.columns) * plan.sliceW + (x - plan.box.min[0]);
    const py = ((layer / plan.columns) | 0) * plan.sliceH + (z - plan.box.min[2]);
    if (px < 0 || py < 0 || px >= image.width || py >= image.height) { misplaced++; return; }
    const o = (py * image.width + px) * 4;
    if (image.data[o + 3] !== 255) { misplaced++; return; }
    if (seen.has(o)) { misplaced++; return; } // two voxels on one pixel
    seen.add(o);
  });
  let opaque = 0;
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] === 255) opaque++;
  return { solid, misplaced, opaque, stray: opaque - seen.size };
}

export function run() {
  /** @type {string[]} */
  const bad = [];
  let voxels = 0;
  let pixels = 0;
  let topExact = 0;

  // 1. Placement and the top-face colour on carved shapes.
  for (const name of ['cube', 'wedge', 'step', 'fin']) {
    const { volume, palette } = build(name);
    const sheet = packSliceSheet(volume, palette);
    const p = placement(volume, sheet);
    voxels += p.solid;
    pixels += p.opaque;
    if (p.misplaced) bad.push(name + ': ' + p.misplaced + ' of ' + p.solid + ' voxels misplaced');
    if (p.stray) bad.push(name + ': ' + p.stray + ' opaque pixels belong to no voxel');

    // A voxel a stack can see shows the face the stack looks at.
    let wrong = 0;
    volume.forEachSolid((x, y, z) => {
      if (volume.get(x, y + 1, z)) return;
      const top = volume.getFace(x, y, z, DIR_PY);
      if (top === 0) return;
      const layer = y - sheet.plan.box.min[1];
      const px = (layer % sheet.plan.columns) * sheet.plan.sliceW + (x - sheet.plan.box.min[0]);
      const py = ((layer / sheet.plan.columns) | 0) * sheet.plan.sliceH + (z - sheet.plan.box.min[2]);
      const o = (py * sheet.image.width + px) * 4;
      const [r, g, b] = palette.rgb(top);
      if (sheet.image.data[o] !== r || sheet.image.data[o + 1] !== g || sheet.image.data[o + 2] !== b) wrong++;
      else topExact++;
    });
    if (wrong) bad.push(name + ': ' + wrong + ' visible pixels not the top face');
  }

  // 2. Outvoted top face: the case the whole `facing` step exists for.
  {
    const palette = new Palette();
    const white = palette.add(255, 255, 255);
    const black = palette.add(0, 0, 0);
    const vol = new Volume(4, 4, 4);
    vol.set(1, 1, 1, true);
    vol.setFace(1, 1, 1, DIR_PY, white);
    vol.setFace(1, 1, 1, DIR_PX, black);
    vol.setFace(1, 1, 1, DIR_NX, black);
    const sheet = packSliceSheet(vol, palette);
    const d = sheet.image.data;
    if (d[0] !== 255 || d[1] !== 255 || d[2] !== 255) {
      bad.push('outvoted top: slice pixel is ' + d[0] + ',' + d[1] + ',' + d[2] + ' not the white top face');
    }
    // The same voxel in `.vox`, which names no facing, keeps the vote: black.
    if (voxelColor(vol, 1, 1, 1) !== black) {
      bad.push('outvoted top: the unfacing rule no longer votes');
    }
  }

  // 3. One rule for both exports: read the .vox back and compare.
  {
    const { volume, palette } = build('cab');
    const { bytes } = exportVox(volume, palette);
    const box = volume.bounds();
    /** @type {Map<string, number>} */
    const fromVox = new Map();
    // MAIN header is 8 + 4 + 4 + 4 + 4 = the 20 bytes before its children.
    let at = 20;
    while (at + 12 <= bytes.length) {
      const id = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
      const len = bytes[at + 4] | (bytes[at + 5] << 8) | (bytes[at + 6] << 16) | (bytes[at + 7] << 24);
      const body = at + 12;
      if (id === 'XYZI') {
        const n = bytes[body] | (bytes[body + 1] << 8) | (bytes[body + 2] << 16) | (bytes[body + 3] << 24);
        for (let i = 0; i < n; i++) {
          const o = body + 4 + i * 4;
          // written as x, z, y (MagicaVoxel is Z-up)
          fromVox.set(
            (bytes[o] + box.min[0]) + ',' + (bytes[o + 2] + box.min[1]) + ',' + (bytes[o + 1] + box.min[2]),
            bytes[o + 3]
          );
        }
      }
      at = body + len;
    }
    let drift = 0;
    let compared = 0;
    volume.forEachSolid((x, y, z) => {
      compared++;
      if (fromVox.get(x + ',' + y + ',' + z) !== voxelColor(volume, x, y, z)) drift++;
    });
    if (compared === 0 || fromVox.size !== compared) {
      bad.push('.vox parity: read back ' + fromVox.size + ' voxels of ' + compared);
    }
    if (drift) bad.push('.vox parity: ' + drift + ' of ' + compared + ' voxels disagree with the shared rule');
  }

  // 4. The ceiling is reported rather than hit.
  {
    const big = new Volume(512, 512, 512);
    big.set(0, 0, 0, true);
    big.set(511, 511, 511, true);
    const plan = planSlices(big);
    if (!plan || plan.fits) {
      bad.push('ceiling: a ' + (plan ? plan.sheetW + '×' + plan.sheetH : '?') +
        ' sheet was called buildable at a ' + SLICE_MAX_SHEET + ' limit');
    }
    let threw = false;
    try { packSliceSheet(big, new Palette()); } catch { threw = true; }
    if (!threw) bad.push('ceiling: the oversized sheet was built anyway');
    const empty = new Volume(8, 8, 8);
    if (planSlices(empty) !== null) bad.push('empty model did not report as empty');
  }

  return {
    ok: bad.length === 0,
    detail: bad.length
      ? bad.join('; ')
      : voxels + ' voxels on ' + pixels + ' pixels, ' + topExact +
        ' visible pixels are the top face, .vox and the sheet share one rule',
  };
}
