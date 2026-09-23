// @ts-check
/**
 * A fast drag leaves a line, not a row of dots.
 *
 * The product applies a tool where a ray from the pointer meets the model. The
 * pointer only reports a handful of positions along a quick gesture, so the
 * question this check asks is the one the user sees: of the voxel faces the
 * gesture passed over, how many did the tool never reach?
 *
 * "Passed over" has to be defined, because a straight screen path clips the
 * corner of a voxel for a fraction of a pixel on its way past, and no sampling
 * short of infinite catches those. A voxel face counts as on the path when the
 * pointer stayed inside it for at least a tenth of a voxel width - measured
 * against a reference that samples the same path every 0.02 px.
 *
 * Red without the fix: `src/edit/stroke.js` does not exist, and the naive
 * numbers this check also prints say why - one application per pointer event
 * misses essentially the whole path.
 */

import { Volume } from '../../src/core/volume.js';
import { OrthoCamera, PITCH_ISO_2_1 } from '../../src/gfx/camera.js';
import { screenRay, raycastVoxel } from '../../src/edit/pick.js';
import { strokeSamples, strokeStepPx } from '../../src/edit/stroke.js';

const N = 32;
const W = 640;
const H = 480;

/** Reference sampling interval, in device pixels. */
const FINE = 0.02;

/**
 * How long the pointer must stay inside a voxel face for it to count as part of
 * the stroke, as a share of one voxel on screen. Below this the path is only
 * clipping a corner: my number, chosen from the sweep in the summary of this
 * check, where 1/16 of a voxel per sample reaches everything above it.
 */
const ON_PATH = 0.1;

/** A solid cube - every screen point over it has a face to paint. */
function solidCube() {
  const vol = new Volume(N, N, N);
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        vol.set(x, y, z, true);
        vol.setAllFaces(x, y, z, 1);
      }
    }
  }
  return vol;
}

/** Yaws, pitches and zooms a model is actually painted at. */
const YAWS = [0.3, Math.PI / 4, 1.2, 2.0, 3.6, 5.0];
const PITCHES = [0.05, 0.25, PITCH_ISO_2_1, 0.8, 1.2];
const ZOOMS = [1, 2, 4, 8, 16, 40];

/** Straight gestures across the window: diagonal, flat, vertical, short. */
const PATHS = [
  [[260, 200], [400, 300]],
  [[200, 300], [430, 220]],
  [[320, 150], [321, 340]],
  [[150, 240], [500, 241]],
  [[290, 230], [350, 250]],
];

export function run() {
  const vol = solidCube();
  const camera = new OrthoCamera();

  /** @param {number} px @param {number} py */
  const faceAt = (px, py) => {
    const ray = screenRay(camera, px, py, W, H);
    const hit = raycastVoxel(vol, ray.origin, ray.dir);
    return hit === null ? -1 : ((hit.x * N + hit.y) * N + hit.z) * 6 + hit.face;
  };

  /**
   * Faces met along a path, with how many samples each was met by.
   * @param {number[][]} path @param {number} stepPx
   * @returns {Map<number, number>}
   */
  const walk = (path, stepPx) => {
    const [a, b] = path;
    /** @type {Map<number, number>} */
    const seen = new Map();
    const add = (/** @type {number} */ px, /** @type {number} */ py) => {
      const f = faceAt(px, py);
      if (f >= 0) seen.set(f, (seen.get(f) ?? 0) + 1);
    };
    add(a[0], a[1]);
    for (const [px, py] of strokeSamples(a[0], a[1], b[0], b[1], stepPx)) add(px, py);
    return seen;
  };

  let cases = 0;
  let onPath = 0;
  let missed = 0;
  let naiveMissed = 0;
  let worstCase = '';
  let worstMiss = 0;

  for (const yaw of YAWS) {
    for (const pitch of PITCHES) {
      for (const zoom of ZOOMS) {
        camera.fit({ min: [0, 0, 0], max: [N - 1, N - 1, N - 1] }, W, H);
        camera.yaw = yaw;
        camera.pitch = pitch;
        camera.pixelsPerVoxel = zoom;

        for (const path of PATHS) {
          const reference = walk(path, FINE);
          const need = [...reference.entries()]
            .filter(([, hits]) => hits * FINE >= ON_PATH * zoom)
            .map(([face]) => face);
          if (need.length === 0) continue;

          const painted = walk(path, strokeStepPx(zoom));
          // What the code did before the fix: the two ends of the move and
          // nothing between them.
          const naive = new Set([faceAt(path[0][0], path[0][1]), faceAt(path[1][0], path[1][1])]);

          let gaps = 0;
          for (const face of need) {
            if (!painted.has(face)) gaps++;
            if (!naive.has(face)) naiveMissed++;
          }

          cases++;
          onPath += need.length;
          missed += gaps;
          if (gaps > worstMiss) {
            worstMiss = gaps;
            worstCase = 'yaw ' + yaw.toFixed(2) + ' pitch ' + pitch.toFixed(2) + ' zoom ' + zoom;
          }
        }
      }
    }
  }

  // A stroke must also stay one undo step, but that is a property of the
  // pointer handler, not of the sampling: `begin()` and `commit()` are not
  // touched by resampling, and the samples all run between them.
  const detail = missed + '/' + onPath + ' faces missed over ' + cases + ' gestures'
    + ' (one ray per event: ' + naiveMissed + '/' + onPath + ')'
    + (missed > 0 ? ' worst ' + worstMiss + ' at ' + worstCase : '');

  return { ok: missed === 0, detail };
}
