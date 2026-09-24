// @ts-check
/**
 * The round trip: a finished model back out as one sheet of six drawings, and
 * in again through the same slicer any other sheet goes through.
 *
 * Deliberately no format of our own. What leaves here is an ordinary PNG with
 * six drawings separated by transparent gutters - the thing an artist can open
 * in any editor, paint on, and drop back in. Reading it back is `detectCells` +
 * `guessViews` + `cropCell`, exactly the path a stranger's sheet takes, so
 * there is one loader to keep honest instead of two.
 *
 * What the trip carries is the silhouette and the colour a view can see. It is
 * not a save file: a face no view looks at, and the edit history, do not
 * survive it. `src/core/serialize.js` is what keeps a model whole.
 *
 * Free of the DOM like the rest of `core/`: an image is {width, height, data}
 * in RGBA8, so this runs the same in the page and in Node.
 */

import { VIEW_NAMES, VIEW_GEOM } from './views.js';

/**
 * @typedef {{width: number, height: number, data: Uint8ClampedArray}} RgbaImage
 */

/**
 * Transparent pixels between drawings on an exported sheet.
 *
 * Wider than the slicer's default gutter of 1 on purpose: the sheet has to
 * survive being read back at whatever gutter the dialog happens to be set to,
 * and a drawing is only ever split by a gutter *narrower* than the gap between
 * cells. A drawing with a fully transparent column through its own middle can
 * still be split by a gutter of 1 - that is a property of the drawing, and it
 * is true of any sheet the tool has ever read.
 */
export const SHEET_GUTTER = 4;

/** Drawings per row on an exported sheet: three across, two down. */
const COLUMNS = 3;

/**
 * Project a model back through one view.
 *
 * The same walk the carve does in reverse: step in from the camera along each
 * (u, v) ray and take the first solid voxel's forward-facing byte. That is the
 * pixel that carved it, so a drawing made this way carves it again.
 *
 * @param {import('./volume.js').Volume} volume
 * @param {import('./palette.js').Palette} palette
 * @param {string} name one of VIEW_NAMES
 * @returns {RgbaImage} the full grid, transparent where the ray missed
 */
export function projectView(volume, palette, name) {
  const geom = VIEW_GEOM[name];
  if (!geom) throw new Error('unknown view: ' + name);
  const N = volume.nx;
  if (volume.ny !== N || volume.nz !== N) throw new Error('projection wants a cubic grid');

  const out = new Uint8ClampedArray(N * N * 4);
  for (let v = 0; v < N; v++) {
    for (let u = 0; u < N; u++) {
      for (let d = 0; d < N; d++) {
        const [x, y, z] = geom.ray(u, v, d, N);
        if (!volume.get(x, y, z)) continue;
        const idx = volume.getFace(x, y, z, geom.face);
        const rgb = palette.colors[idx] ?? 0;
        const o = (v * N + u) * 4;
        out[o] = (rgb >> 16) & 255;
        out[o + 1] = (rgb >> 8) & 255;
        out[o + 2] = rgb & 255;
        out[o + 3] = 255;
        break;
      }
    }
  }
  return { width: N, height: N, data: out };
}

/**
 * Tight bounding box of the opaque pixels, or null when there are none.
 * @param {RgbaImage} img
 * @returns {{x: number, y: number, w: number, h: number} | null}
 */
function contentBox(img) {
  const { width: w, height: h, data } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < 128) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Project a model into one sheet of six drawings.
 *
 * Each drawing is cropped to its own content, because that is what the slicer
 * gives back anyway - it tightens every cell to the pixels inside it - and a
 * cell that already matches what comes back is one fewer thing that can drift.
 * Reading order across the sheet is `VIEW_NAMES`, which is also the order the
 * slicer falls back to when sizes cannot tell the views apart.
 *
 * @param {import('./volume.js').Volume} volume
 * @param {import('./palette.js').Palette} palette
 * @param {{gutter?: number}} [opts]
 * @returns {{image: RgbaImage, cells: Array<{name: string, x: number, y: number, w: number, h: number}>}}
 */
export function packViewSheet(volume, palette, opts = {}) {
  const gutter = Math.max(1, Math.round(opts.gutter ?? SHEET_GUTTER));

  /** @type {Array<{name: string, img: RgbaImage, box: {x: number, y: number, w: number, h: number}}>} */
  const drawings = [];
  for (const name of VIEW_NAMES) {
    const img = projectView(volume, palette, name);
    const box = contentBox(img);
    if (box) drawings.push({ name, img, box });
  }
  if (drawings.length === 0) throw new Error('nothing to project: the model is empty');

  const rows = Math.ceil(drawings.length / COLUMNS);
  /** @type {number[]} */
  const colW = new Array(COLUMNS).fill(0);
  /** @type {number[]} */
  const rowH = new Array(rows).fill(0);
  drawings.forEach((d, i) => {
    const c = i % COLUMNS, r = Math.floor(i / COLUMNS);
    colW[c] = Math.max(colW[c], d.box.w);
    rowH[r] = Math.max(rowH[r], d.box.h);
  });

  const width = colW.reduce((a, b) => a + b, 0) + gutter * (COLUMNS + 1);
  const height = rowH.reduce((a, b) => a + b, 0) + gutter * (rows + 1);
  const sheet = { width, height, data: new Uint8ClampedArray(width * height * 4) };

  /** @type {Array<{name: string, x: number, y: number, w: number, h: number}>} */
  const cells = [];
  drawings.forEach((d, i) => {
    const c = i % COLUMNS, r = Math.floor(i / COLUMNS);
    let dx = gutter;
    for (let k = 0; k < c; k++) dx += colW[k] + gutter;
    let dy = gutter;
    for (let k = 0; k < r; k++) dy += rowH[k] + gutter;

    for (let y = 0; y < d.box.h; y++) {
      const src = ((d.box.y + y) * d.img.width + d.box.x) * 4;
      sheet.data.set(d.img.data.subarray(src, src + d.box.w * 4), ((dy + y) * width + dx) * 4);
    }
    cells.push({ name: d.name, x: dx, y: dy, w: d.box.w, h: d.box.h });
  });

  return { image: sheet, cells };
}
