// @ts-check
/**
 * One build, start to finish, from plain data to plain data.
 *
 * This is the whole job the worker does, kept apart from the worker itself for
 * two reasons. It has no `postMessage` in it, so it runs in Node and can be
 * checked against a plain `carve()` of the same art - which is the only way to
 * know that going off the main thread did not change the model
 * (`tests/carve/worker-parity.mjs`). And it keeps the worker file down to the
 * four lines that wire a message to a result.
 *
 * What travels back is more than the volume: the face instances and the
 * bounding box are built here too. Both walk every solid voxel, and at 512
 * that is two more seconds of freeze - moving the carve off the main thread
 * only to hand those straight back would buy most of nothing.
 */

import { SourceView } from './views.js';
import { Palette } from './palette.js';
import { Volume } from './volume.js';
import { carve } from './carve.js';

/**
 * Where the carve stops and the geometry begins, as a share of the whole job.
 *
 * Measured at 512 on this bench (2026-09-24): carve 8.6 s, then bounds 0.2 s,
 * face instances 2.0 s and packing under 0.2 s - so the tail is a fifth of the
 * work and a bar that ignored it would sit at 100% for two seconds.
 */
const GEOMETRY_FROM = 0.8;

/**
 * @typedef {Object} CarveJob
 * @property {import('./views.js').ViewSnapshot[]} views placed and solved already
 * @property {number} N grid size
 * @property {boolean} [mirrorMissing]
 */

/**
 * @typedef {Object} CarveJobResult
 * @property {ReturnType<Volume['pack']>} volume
 * @property {{buffer: ArrayBuffer, count: number}} faces instances for the renderer
 * @property {{colors: number[], aliases: Int32Array, overflowed: boolean}} palette
 * @property {import('./carve.js').CarveStats} stats
 * @property {{min: number[], max: number[]}|null} box
 * @property {ArrayBuffer[]} transfer buffers to hand over rather than copy
 */

/**
 * @param {CarveJob} job
 * @param {(fraction: number, stage: string) => void} [onProgress]
 * @returns {CarveJobResult}
 */
export function runCarveJob(job, onProgress) {
  const views = job.views.map((s) => SourceView.fromSnapshot(s));
  const palette = new Palette();
  const { volume, stats } = carve(views, job.N, palette, {
    mirrorMissing: job.mirrorMissing,
    onProgress: onProgress && ((f, stage) => onProgress(f * GEOMETRY_FROM, stage)),
  });

  // Three steps rather than one: the face instances alone are two of the ten
  // seconds a 512 build takes, and a bar that sat at 80% through them would be
  // the freeze all over again as far as anyone watching is concerned.
  onProgress?.(GEOMETRY_FROM, 'geometry');
  const box = volume.bounds();
  onProgress?.(GEOMETRY_FROM + 0.05, 'geometry');
  const faces = volume.buildFaceInstances();
  onProgress?.(GEOMETRY_FROM + 0.15, 'geometry');
  const packed = volume.pack();
  onProgress?.(1, 'geometry');

  return {
    volume: packed,
    faces,
    palette: palette.snapshot(),
    stats,
    box,
    transfer: [...Volume.transferables(packed), faces.buffer],
  };
}
