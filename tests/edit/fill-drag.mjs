// @ts-check
/**
 * A bucket fill dragged across a big model stays cheap.
 *
 * Resampling a drag turns a handful of pointer events into hundreds of points,
 * and the pointer handler runs the tool at every point whose voxel face differs
 * from the previous one's (`runToolAtPoint` in `src/main.js`). For paint that is
 * obviously fine. For fill it is the question worth asking, because one fill can
 * flood a whole surface, and a drag that floods once per face it crosses would
 * be an order of magnitude more work than the one-per-event the product did
 * before the stroke was resampled.
 *
 * So it is measured rather than argued. The worst shape for it is a model that
 * is all one colour: the first application floods the entire visible surface,
 * and the drag keeps landing on faces of that same surface afterwards. A solid
 * 128-cube, a drag of 720 screen pixels at 8 px per voxel:
 *
 *   1501 samples -> 168 applications -> 2 actual floods, 60 ms
 *   the same drag with no de-duplication at all: 1501 applications, 30 ms
 *
 * The second being the faster of the two is the order they run in, not a
 * result: whichever goes first pays for the cold compile. That is the point.
 * De-duplication is not what keeps a dragged fill cheap - `fillSurface` is:
 * after the first flood the faces already carry the new colour, so every later
 * application returns at its first line. Collapsing samples to faces saves the
 * raycasts, and nothing dramatic beyond them.
 *
 * The check repeats that measurement and fails if a fill drag ever costs more
 * than a second, which is ~16x the measured figure - the margin is for a slow
 * machine, not for a regression.
 *
 * Red without the fix: raise the flood's early return (drop the
 * `target === color` test in `fillSurface`) and the same drag floods on every
 * application instead of twice.
 */

import { Volume } from '../../src/core/volume.js';
import { OrthoCamera, PITCH_ISO_2_1 } from '../../src/gfx/camera.js';
import { screenRay, raycastVoxel } from '../../src/edit/pick.js';
import { strokeSamples, strokeStepPx } from '../../src/edit/stroke.js';
import { applyTool } from '../../src/edit/tools.js';

const N = 128;
const W = 1280;
const H = 960;

/** Ceiling for one dragged fill, in milliseconds. My number; see the header. */
const BUDGET_MS = 1000;

/** A solid cube, every face one colour: the worst case for a dragged fill. */
function solidCube() {
  const vol = new Volume(N, N, N);
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        vol.set(x, y, z, true);
        vol.setAllFaces(x, y, z, 7);
      }
    }
  }
  return vol;
}

/**
 * One dragged stroke, run the way the pointer handler runs it: resampled, and
 * applied once per voxel face rather than once per sample.
 *
 * @param {Volume} vol
 * @param {boolean} dedup
 * @returns {{samples: number, applications: number, changed: number, ms: number}}
 */
function drag(vol, dedup) {
  const camera = new OrthoCamera();
  camera.fit({ min: [0, 0, 0], max: [N - 1, N - 1, N - 1] }, W, H);
  camera.yaw = 0.6;
  camera.pitch = PITCH_ISO_2_1;
  camera.pixelsPerVoxel = 8;

  const points = [[300, 250], ...strokeSamples(300, 250, 900, 700, strokeStepPx(8))];
  /** @type {number | null} */
  let last = null;
  let applications = 0;
  let changed = 0;

  const t0 = performance.now();
  for (const [px, py] of points) {
    const ray = screenRay(camera, px, py, W, H);
    const hit = raycastVoxel(vol, ray.origin, ray.dir);
    if (!hit) continue;
    const key = ((hit.x * N + hit.y) * N + hit.z) * 6 + hit.face;
    if (dedup && key === last) continue;
    last = key;
    applications++;
    if (applyTool(vol, hit, { tool: 'fill', color: 200, faceOnly: true }).changed) changed++;
  }
  return { samples: points.length, applications, changed, ms: performance.now() - t0 };
}

export function run() {
  const kept = drag(solidCube(), true);
  const every = drag(solidCube(), false);

  const problems = [];
  if (kept.ms > BUDGET_MS) problems.push('dragged fill took ' + kept.ms.toFixed(0) + ' ms');
  if (every.ms > BUDGET_MS) problems.push('undeduplicated fill took ' + every.ms.toFixed(0) + ' ms');
  // The flood must stop repeating itself: a surface already wearing the new
  // colour is not flooded again. Two is the two facings the drag crosses.
  if (kept.changed > 8) problems.push(kept.changed + ' floods where 2 are expected');
  if (kept.applications >= kept.samples) problems.push('de-duplication collapsed nothing');

  const detail = kept.samples + ' samples -> ' + kept.applications + ' applications -> '
    + kept.changed + ' floods, ' + kept.ms.toFixed(0) + ' ms'
    + ' (one per sample: ' + every.applications + ', ' + every.ms.toFixed(0) + ' ms;'
    + ' budget ' + BUDGET_MS + ' ms)'
    + (problems.length ? '; ' + problems[0] : '');

  return { ok: problems.length === 0, detail };
}
