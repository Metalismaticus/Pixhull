// @ts-check
/**
 * CPU rendering, so the MCP server can hand an assistant a picture.
 *
 * Without this the assistant works blind: it calls a tool, gets back "1,438
 * voxels", and has no way to tell whether the roof is too tall. Returning a
 * frame turns the exchange into something it can actually iterate on.
 *
 * There is no software rasteriser here in the usual sense. The camera is
 * orthographic and the geometry is a grid, so one ray per pixel through the
 * *same* walk the editor uses for picking gives the exact same answer, with no
 * triangle setup and no risk of the preview disagreeing with what a click would
 * hit. It is also, for sprite-sized output, plenty fast: a 64x64 frame is 4,096
 * rays of a few dozen steps each.
 */

import { OrthoCamera } from '../src/gfx/camera.js';
import { planTurnaround } from '../src/export/turnaround.js';
import { screenRay, raycastVoxel } from '../src/edit/pick.js';

/** Matches the viewport's readability tint, face for face. */
const SHADE = [0.88, 0.74, 1.0, 0.58, 0.95, 0.68];

/**
 * @param {import('../src/core/volume.js').Volume} volume
 * @param {import('../src/core/palette.js').Palette} palette
 * @param {OrthoCamera} camera
 * @param {number} w @param {number} h
 * @param {{shaded?: boolean}} [opts]
 * @returns {{width: number, height: number, data: Uint8Array}} RGBA8, top-down
 */
export function renderFrame(volume, palette, camera, w, h, opts = {}) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Through the pixel's centre, which is where a rasteriser samples too.
      const ray = screenRay(camera, x + 0.5, y + 0.5, w, h);
      const hit = raycastVoxel(volume, ray.origin, ray.dir);
      if (!hit) continue;
      const c = volume.getFace(hit.x, hit.y, hit.z, hit.face);
      if (c === 0) continue;

      let [r, g, b] = palette.rgb(c);
      if (opts.shaded) {
        const s = SHADE[hit.face];
        r = Math.round(r * s);
        g = Math.round(g * s);
        b = Math.round(b * s);
      }
      const o = (y * w + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/**
 * A full turnaround, planned by the same code the browser uses, so the frame
 * size and pivots come out identical.
 *
 * @param {import('../src/core/volume.js').Volume} volume
 * @param {import('../src/core/palette.js').Palette} palette
 * @param {{directions: number, angleMode?: 'clean'|'uniform', pitch: number,
 *   scale?: number, padding?: number, shaded?: boolean}} opts
 * @returns {{frames: Array<{width: number, height: number, data: Uint8Array}>,
 *   meta: {frameW: number, frameH: number, count: number, angles: number[],
 *     pivots: Array<{x: number, y: number}>, pitch: number, scale: number}}}
 */
export function renderTurnaroundCpu(volume, palette, opts) {
  const camera = new OrthoCamera();
  const plan = planTurnaround(volume, camera, opts);

  const frames = [];
  for (const shot of plan.shots) {
    camera.yaw = shot.yaw;
    camera.panX = shot.panX;
    camera.panY = shot.panY;
    frames.push(renderFrame(volume, palette, camera, plan.frameW, plan.frameH, { shaded: opts.shaded }));
  }

  return {
    frames,
    meta: {
      frameW: plan.frameW,
      frameH: plan.frameH,
      count: frames.length,
      angles: plan.shots.map((s) => +((s.yaw * 180) / Math.PI).toFixed(4)),
      pivots: plan.shots.map((s) => ({ x: s.pivotX, y: s.pivotY })),
      pitch: +((plan.pitch * 180) / Math.PI).toFixed(4),
      scale: plan.scale,
    },
  };
}

/**
 * Lay frames out in one row, matching the browser's sheet layout.
 * @param {Array<{width: number, height: number, data: Uint8Array}>} frames
 * @returns {{width: number, height: number, data: Uint8Array}}
 */
export function packSheetCpu(frames) {
  if (frames.length === 0) throw new Error('No frames to pack.');
  const fw = frames[0].width;
  const fh = frames[0].height;
  const out = new Uint8Array(fw * frames.length * fh * 4);
  const sheetW = fw * frames.length;
  for (let i = 0; i < frames.length; i++) {
    for (let y = 0; y < fh; y++) {
      const src = y * fw * 4;
      const dst = (y * sheetW + i * fw) * 4;
      out.set(frames[i].data.subarray(src, src + fw * 4), dst);
    }
  }
  return { width: sheetW, height: fh, data: out };
}
