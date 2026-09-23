// @ts-check
/**
 * Source views: the up-to-six orthographic images the model is carved from.
 *
 * Deliberately permissive about size. Art arrives at 50x48 or 37x91, from
 * whatever canvas the artist was already working in, and the tool's job is to
 * place it on the voxel grid - not to send the artist back to resize things.
 * Each view keeps its own pixel offset inside the grid so mismatched views can
 * be lined up by eye instead of by arithmetic.
 */

import { DIR_PX, DIR_NX, DIR_PY, DIR_NY, DIR_PZ, DIR_NZ } from './volume.js';

/** Order matters: it is the UI order and the serialisation order. */
export const VIEW_NAMES = /** @type {const} */ (['front', 'back', 'right', 'left', 'top', 'bottom']);

/**
 * Per view: which voxel face it paints, and how its (u,v) relates to voxel
 * space. `uv` maps a voxel to the pixel that sees it; `ray` walks from the
 * camera inward so the first solid hit is the one that gets painted.
 *
 * The convention is the engineering-drawing one: front and top share columns,
 * front and the side views share rows.
 */
export const VIEW_GEOM = {
  front:  { face: DIR_PZ, uv: (x, y, z, N) => [x, N - 1 - y],         ray: (u, v, d, N) => [u, N - 1 - v, N - 1 - d] },
  back:   { face: DIR_NZ, uv: (x, y, z, N) => [N - 1 - x, N - 1 - y], ray: (u, v, d, N) => [N - 1 - u, N - 1 - v, d] },
  right:  { face: DIR_PX, uv: (x, y, z, N) => [N - 1 - z, N - 1 - y], ray: (u, v, d, N) => [N - 1 - d, N - 1 - v, N - 1 - u] },
  left:   { face: DIR_NX, uv: (x, y, z, N) => [z, N - 1 - y],         ray: (u, v, d, N) => [d, N - 1 - v, u] },
  top:    { face: DIR_PY, uv: (x, y, z, N) => [x, z],                 ray: (u, v, d, N) => [u, N - 1 - d, v] },
  bottom: { face: DIR_NY, uv: (x, y, z, N) => [x, N - 1 - z],         ray: (u, v, d, N) => [u, d, N - 1 - v] },
};

/** Alpha at or above this counts as solid. */
export const ALPHA_THRESHOLD = 128;

export class SourceView {
  /**
   * @param {string} name one of VIEW_NAMES
   * @param {ImageData} image
   */
  constructor(name, image) {
    this.name = name;
    this.image = image;
    this.enabled = true;
    this.flipH = false;
    this.flipV = false;
    /** Top-left corner of the image within the N x N grid, in grid pixels. */
    this.offsetX = 0;
    this.offsetY = 0;
    /** Set by autoPlace; kept so the UI can show "trimmed to 37x52". */
    this.trim = { x: 0, y: 0, w: image.width, h: image.height };
    this.computeTrim();
  }

  /** Tight bounding box of non-transparent pixels. */
  computeTrim() {
    const { width: w, height: h, data } = this.image;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] >= ALPHA_THRESHOLD) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    this.trim = x1 < 0
      ? { x: 0, y: 0, w: 0, h: 0 }
      : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /**
   * Centre the view's artwork on the grid. Centres the *trimmed* content, not
   * the raw canvas, so padding the artist happened to leave in the PNG does not
   * shift the model off-axis.
   * @param {number} N grid size
   */
  autoPlace(N) {
    const t = this.trim;
    if (t.w === 0) {
      this.offsetX = 0;
      this.offsetY = 0;
      return;
    }
    this.offsetX = Math.round((N - t.w) / 2) - t.x;
    this.offsetY = Math.round((N - t.h) / 2) - t.y;
  }

  /**
   * Sample the view at grid pixel (u, v).
   * @returns {number} index into ImageData, or -1 when outside / transparent
   */
  sampleIndex(u, v) {
    const { width: w, height: h } = this.image;
    let sx = u - this.offsetX;
    let sy = v - this.offsetY;
    if (this.flipH) sx = w - 1 - sx;
    if (this.flipV) sy = h - 1 - sy;
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return -1;
    const i = (sy * w + sx) * 4;
    return this.image.data[i + 3] >= ALPHA_THRESHOLD ? i : -1;
  }

  /**
   * Flatten to grid-sized mask + colour lookup. Done once per carve rather than
   * per voxel, which keeps the inner loop to an array read.
   * @param {number} N
   * @param {import('./palette.js').Palette} palette
   * @returns {{mask: Uint8Array, color: Uint8Array}}
   */
  rasterize(N, palette) {
    const mask = new Uint8Array(N * N);
    const color = new Uint8Array(N * N);
    const d = this.image.data;
    for (let v = 0; v < N; v++) {
      for (let u = 0; u < N; u++) {
        const i = this.sampleIndex(u, v);
        if (i < 0) continue;
        const o = v * N + u;
        mask[o] = 1;
        color[o] = palette.add(d[i], d[i + 1], d[i + 2]);
      }
    }
    return { mask, color };
  }
}

/**
 * Decode a File/Blob into ImageData with no smoothing anywhere along the path.
 * @param {Blob} blob
 * @returns {Promise<ImageData>}
 */
export async function decodeImage(blob) {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Smallest grid that holds every enabled view's trimmed content.
 * @param {SourceView[]} views
 * @returns {number}
 */
export function suggestGridSize(views) {
  let need = 8;
  for (const v of views) {
    if (!v.enabled || v.trim.w === 0) continue;
    need = Math.max(need, v.trim.w, v.trim.h);
  }
  return Math.min(256, need);
}
