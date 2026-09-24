// @ts-check
/**
 * PNG slice export - the sheet a sprite-stacking engine wants.
 *
 * Sprite stacking draws a model as a pile of flat images, one per horizontal
 * layer, each offset a pixel or two up the screen. So a slice is a horizontal
 * cross-section of the model, seen from directly above, one pixel per voxel,
 * and the sheet is those slices laid out in a grid with a JSON file that says
 * which cell is which layer.
 *
 * Three decisions worth knowing:
 *
 * - **The colour is not decided here.** `voxelColor` is the single rule shared
 *   with the `.vox` export; this one passes `facing: DIR_PY`, because a stack
 *   is only ever seen along its stacking axis, so a slice pixel *is* the
 *   voxel's top face rather than a guess at its colour.
 * - **Every layer is written, empty ones included.** Dropping a blank layer
 *   would shorten the pile and squash the model; dropping the interior of a
 *   layer would let daylight through the overhangs above it.
 * - **The sheet is laid out near-square, not as one long strip.** A single row
 *   of 256 slices at 256 px is 65 536 pixels wide, which no browser canvas
 *   will hold. The JSON names the columns, so nothing has to guess.
 */

import { DIR_PY } from '../core/volume.js';
import { voxelColor } from './voxelcolor.js';

/**
 * Widest sheet we will build, per side.
 *
 * Chosen, not measured: 8192 is the size browsers agree on for a canvas, and
 * one side of 8192 is already 67 million pixels and 268 MB of RGBA. A model
 * that does not fit is reported, the way `.vox` reports its 256 ceiling,
 * rather than failing halfway through an allocation.
 */
export const SLICE_MAX_SHEET = 8192;

/**
 * @typedef {Object} SlicePlan
 * @property {{min: number[], max: number[]}} box the model's own bounding box
 * @property {number} sliceW @property {number} sliceH
 * @property {number} count layers, bottom to top
 * @property {number} columns @property {number} rows
 * @property {number} sheetW @property {number} sheetH
 * @property {boolean} fits whether the sheet is within `SLICE_MAX_SHEET`
 */

/**
 * Work out the sheet without building it - what the button's hint needs.
 * @param {import('../core/volume.js').Volume} volume
 * @param {{columns?: number}} [opts]
 * @returns {SlicePlan | null} null when the model is empty
 */
export function planSlices(volume, opts = {}) {
  const box = volume.bounds();
  if (!box) return null;
  const sliceW = box.max[0] - box.min[0] + 1;
  const sliceH = box.max[2] - box.min[2] + 1;
  const count = box.max[1] - box.min[1] + 1;
  const columns = Math.max(1, Math.min(count, Math.round(opts.columns ?? Math.ceil(Math.sqrt(count)))));
  const rows = Math.ceil(count / columns);
  const sheetW = columns * sliceW;
  const sheetH = rows * sliceH;
  return {
    box, sliceW, sliceH, count, columns, rows, sheetW, sheetH,
    fits: sheetW <= SLICE_MAX_SHEET && sheetH <= SLICE_MAX_SHEET,
  };
}

/**
 * @typedef {Object} SliceSheet
 * @property {{width: number, height: number, data: Uint8ClampedArray}} image
 * @property {Object} meta the JSON that travels beside the sheet
 * @property {SlicePlan} plan
 * @property {{voxels: number, colors: number}} stats
 */

/**
 * @param {import('../core/volume.js').Volume} volume
 * @param {import('../core/palette.js').Palette} palette
 * @param {{columns?: number}} [opts]
 * @returns {SliceSheet}
 */
export function packSliceSheet(volume, palette, opts = {}) {
  const plan = planSlices(volume, opts);
  if (!plan) throw new Error('Nothing to export: the model is empty.');
  if (!plan.fits) {
    throw new Error('The slice sheet would be ' + plan.sheetW + '×' + plan.sheetH +
      ' pixels; ' + SLICE_MAX_SHEET + ' per side is the ceiling.');
  }

  const { box, sliceW, sliceH, columns, sheetW, sheetH } = plan;
  const data = new Uint8ClampedArray(sheetW * sheetH * 4);
  const used = new Set();
  let voxels = 0;

  volume.forEachSolid((x, y, z) => {
    const layer = y - box.min[1];
    const idx = voxelColor(volume, x, y, z, { facing: DIR_PY });
    used.add(idx);
    const [r, g, b] = palette.rgb(idx);
    // Inside a slice the layout is the top view's: u across X, v down Z
    // (`VIEW_GEOM.top`), so a slice sits the same way round as the drawing the
    // artist gave the tool.
    const px = (layer % columns) * sliceW + (x - box.min[0]);
    const py = ((layer / columns) | 0) * sliceH + (z - box.min[2]);
    const o = (py * sheetW + px) * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 255;
    voxels++;
  });

  /** @type {Array<{index: number, sheetX: number, sheetY: number}>} */
  const slices = [];
  for (let i = 0; i < plan.count; i++) {
    slices.push({
      index: i,
      sheetX: (i % columns) * sliceW,
      sheetY: ((i / columns) | 0) * sliceH,
    });
  }

  const meta = {
    generator: 'pixhull',
    kind: 'sprite-stack',
    axis: 'y',
    order: 'bottom-to-top',
    sliceWidth: sliceW,
    sliceHeight: sliceH,
    sliceCount: plan.count,
    columns,
    rows: plan.rows,
    sheetWidth: sheetW,
    sheetHeight: sheetH,
    // Which way a slice is laid out, said plainly rather than implied: the
    // engine has to know before it can stack anything.
    sliceAxes: { u: 'x', v: 'z' },
    slices,
    // Live slots only: a merged palette has holes, and a hole reads as
    // #000000 - a colour that was never in the art.
    palette: palette.slots().map((i) => palette.hex(i)),
  };

  return { image: { width: sheetW, height: sheetH, data }, meta, plan, stats: { voxels, colors: used.size } };
}
