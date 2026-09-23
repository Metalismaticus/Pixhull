// @ts-check
/**
 * Frame planning for a turnaround, with no renderer attached.
 *
 * The promise this project makes about sprites - one canvas size for every
 * frame, a recorded pivot, whole-pixel centring - is arithmetic, not drawing.
 * Keeping it here means the WebGL path in the browser and the CPU path in the
 * MCP server cannot drift: if they disagreed about frame size or centring, the
 * sheets they produce would silently stop matching.
 */

import { directionYaws } from '../gfx/camera.js';
import { transformPoint } from '../gfx/glutil.js';

/**
 * @typedef {Object} Shot
 * @property {number} yaw radians
 * @property {number} panX whole device pixels
 * @property {number} panY whole device pixels
 * @property {number} pivotX where the model's ground centre lands, in frame pixels
 * @property {number} pivotY
 */

/**
 * @typedef {Object} TurnaroundPlan
 * @property {number} frameW
 * @property {number} frameH
 * @property {number} scale device pixels per voxel
 * @property {number} pitch radians
 * @property {Shot[]} shots
 * @property {[number, number, number]} target camera target in voxel space
 */

/**
 * Works out the frame size and per-frame camera placement. Mutates the camera's
 * pitch, zoom and target; the caller then sets yaw and pan per shot.
 *
 * @param {import('../core/volume.js').Volume} volume
 * @param {import('../gfx/camera.js').OrthoCamera} camera scratch camera
 * @param {{directions: number, angleMode?: 'clean'|'uniform', pitch: number,
 *   scale?: number, padding?: number, frameW?: number, frameH?: number,
 *   useGridBounds?: boolean}} opts
 * @returns {TurnaroundPlan}
 */
export function planTurnaround(volume, camera, opts) {
  const scale = Math.max(1, Math.round(opts.scale ?? 1));
  const padding = Math.max(0, Math.round(opts.padding ?? 0));

  const box = opts.useGridBounds
    ? { min: /** @type {[number,number,number]} */ ([0, 0, 0]),
        max: /** @type {[number,number,number]} */ ([volume.nx - 1, volume.ny - 1, volume.nz - 1]) }
    : volume.bounds();
  if (!box) throw new Error('Nothing to render: the model is empty.');

  const yaws = directionYaws(opts.directions, opts.angleMode ?? 'clean');

  camera.pitch = opts.pitch;
  camera.pixelsPerVoxel = scale;
  /** @type {[number, number, number]} */
  const target = [
    (box.min[0] + box.max[0] + 1) / 2,
    (box.min[1] + box.max[1] + 1) / 2,
    (box.min[2] + box.max[2] + 1) / 2,
  ];
  camera.target = target;

  // Pass one: the frame has to fit the widest angle, so size it before drawing
  // anything. This is what keeps a sheet aligned.
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

  const groundCentre = /** @type {[number, number, number]} */ ([
    (box.min[0] + box.max[0] + 1) / 2,
    box.min[1],
    (box.min[2] + box.max[2] + 1) / 2,
  ]);

  /** @type {Shot[]} */
  const shots = [];
  for (let i = 0; i < yaws.length; i++) {
    camera.yaw = yaws[i];
    // Whole-pixel centring. A fractional offset would differ per frame and make
    // edges crawl during playback.
    const panX = -Math.round(extents[i].cx * scale);
    const panY = -Math.round(extents[i].cy * scale);
    camera.panX = panX;
    camera.panY = panY;

    const p = transformPoint(camera.viewMatrix(), groundCentre[0], groundCentre[1], groundCentre[2]);
    shots.push({
      yaw: yaws[i],
      panX,
      panY,
      pivotX: Math.round(frameW / 2 + (p[0] + panX / scale) * scale),
      pivotY: Math.round(frameH / 2 - (p[1] + panY / scale) * scale),
    });
  }

  return { frameW, frameH, scale, pitch: opts.pitch, shots, target };
}
