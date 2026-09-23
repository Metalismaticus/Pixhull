// @ts-check
/**
 * Sprite export.
 *
 * The rule this module exists to enforce: **every frame of a turnaround uses
 * the same canvas and the same pivot**. Auto-cropping each frame to its own
 * content is the single most common way a 3D-to-sprite pipeline ruins a
 * tileset - the art looks fine in the preview and then every tile sits a pixel
 * or two off once it is in the engine. Here the frame size is computed once,
 * as the largest projection across all angles, and the model is centred on a
 * whole-pixel offset so nothing shimmers as it turns.
 */

import { directionYaws } from '../gfx/camera.js';
import { transformPoint } from '../gfx/glutil.js';

/**
 * @typedef {Object} TurnaroundOptions
 * @property {number} directions how many frames around the turn
 * @property {'clean'|'uniform'} [angleMode] clean snaps to pixel-friendly slopes
 * @property {number} pitch elevation in radians
 * @property {number} [scale] device pixels per voxel, integer
 * @property {number} [padding] extra pixels on every side
 * @property {number} [frameW] force an exact frame width
 * @property {number} [frameH] force an exact frame height
 * @property {boolean} [shaded] apply the face tint instead of flat colours
 * @property {boolean} [useGridBounds] size to the whole grid, not the model
 */

/**
 * @typedef {Object} TurnaroundResult
 * @property {ImageData[]} frames
 * @property {{frameW: number, frameH: number, count: number,
 *   angles: number[], pivots: Array<{x: number, y: number}>,
 *   pitch: number, scale: number}} meta
 */

/**
 * @param {import('../gfx/renderer.js').Renderer} renderer
 * @param {import('../core/volume.js').Volume} volume
 * @param {import('../gfx/camera.js').OrthoCamera} camera a scratch camera; its state is overwritten
 * @param {TurnaroundOptions} opts
 * @returns {TurnaroundResult}
 */
export function renderTurnaround(renderer, volume, camera, opts) {
  const scale = Math.max(1, Math.round(opts.scale ?? 1));
  const padding = Math.max(0, Math.round(opts.padding ?? 0));
  const angleMode = opts.angleMode ?? 'clean';

  const box = opts.useGridBounds
    ? { min: /** @type {[number,number,number]} */ ([0, 0, 0]),
        max: /** @type {[number,number,number]} */ ([volume.nx - 1, volume.ny - 1, volume.nz - 1]) }
    : volume.bounds();
  if (!box) throw new Error('Nothing to export: the model is empty.');

  const yaws = directionYaws(opts.directions, angleMode);

  camera.pitch = opts.pitch;
  camera.pixelsPerVoxel = scale;
  camera.target = [
    (box.min[0] + box.max[0] + 1) / 2,
    (box.min[1] + box.max[1] + 1) / 2,
    (box.min[2] + box.max[2] + 1) / 2,
  ];

  // Pass one: find the frame size that fits every angle. Doing this before
  // rendering anything is what keeps the sheet aligned.
  let maxW = 0;
  let maxH = 0;
  const extents = [];
  for (const yaw of yaws) {
    camera.yaw = yaw;
    camera.panX = 0;
    camera.panY = 0;
    const e = camera.projectedExtent(box);
    extents.push(e);
    if (e.w > maxW) maxW = e.w;
    if (e.h > maxH) maxH = e.h;
  }

  const frameW = opts.frameW ?? Math.ceil(maxW * scale) + padding * 2;
  const frameH = opts.frameH ?? Math.ceil(maxH * scale) + padding * 2;

  const prevShade = renderer.shade;
  renderer.shade = opts.shaded ? 1 : 0;

  /** @type {ImageData[]} */
  const frames = [];
  /** @type {Array<{x: number, y: number}>} */
  const pivots = [];

  try {
    for (let i = 0; i < yaws.length; i++) {
      camera.yaw = yaws[i];
      // Whole-pixel centring: the fractional part would otherwise differ per
      // frame and make edges crawl during playback.
      camera.panX = -Math.round(extents[i].cx * scale);
      camera.panY = -Math.round(extents[i].cy * scale);
      frames.push(renderer.renderToImageData(camera, frameW, frameH));

      // Pivot = the model's ground centre, which is what an engine anchors to.
      const view = camera.viewMatrix();
      const p = transformPoint(
        view,
        (box.min[0] + box.max[0] + 1) / 2,
        box.min[1],
        (box.min[2] + box.max[2] + 1) / 2
      );
      const ox = camera.panX / scale;
      const oy = camera.panY / scale;
      pivots.push({
        x: Math.round(frameW / 2 + (p[0] + ox) * scale),
        y: Math.round(frameH / 2 - (p[1] + oy) * scale),
      });
    }
  } finally {
    renderer.shade = prevShade;
  }

  return {
    frames,
    meta: {
      frameW,
      frameH,
      count: frames.length,
      angles: yaws.map((y) => +((y * 180) / Math.PI).toFixed(4)),
      pivots,
      pitch: +((opts.pitch * 180) / Math.PI).toFixed(4),
      scale,
    },
  };
}

/**
 * Lay frames out in a grid. Defaults to a single row, which is what most
 * engines expect from a turnaround strip.
 * @param {ImageData[]} frames
 * @param {number} frameW @param {number} frameH
 * @param {number} [columns]
 * @returns {{image: ImageData, columns: number, rows: number}}
 */
export function packSheet(frames, frameW, frameH, columns) {
  const cols = Math.max(1, columns ?? frames.length);
  const rows = Math.ceil(frames.length / cols);
  const sheetW = cols * frameW;
  const sheetH = rows * frameH;
  const out = new ImageData(sheetW, sheetH);
  for (let i = 0; i < frames.length; i++) {
    const cx = (i % cols) * frameW;
    const cy = ((i / cols) | 0) * frameH;
    const src = frames[i];
    for (let y = 0; y < frameH; y++) {
      const so = y * frameW * 4;
      const to = ((cy + y) * sheetW + cx) * 4;
      out.data.set(src.data.subarray(so, so + frameW * 4), to);
    }
  }
  return { image: out, columns: cols, rows };
}

/**
 * Force every opaque pixel onto the palette. Flat renders are already exact,
 * but shaded ones multiply colours, so this pulls them back on-palette - the
 * difference between "3D render of pixel art" and "pixel art".
 * @param {ImageData} img
 * @param {import('../core/palette.js').Palette} palette
 * @returns {ImageData}
 */
export function snapToPalette(img, palette) {
  const d = img.data;
  /** @type {Map<number, number>} */
  const memo = new Map();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) {
      d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
      continue;
    }
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    let idx = memo.get(key);
    if (idx === undefined) {
      idx = palette.nearest(d[i], d[i + 1], d[i + 2]);
      memo.set(key, idx);
    }
    const [r, g, b] = palette.rgb(idx);
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = 255;
  }
  return img;
}

/**
 * @param {ImageData} img
 * @returns {Promise<Blob>}
 */
export function imageDataToPng(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
  });
}

/**
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
