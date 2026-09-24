// @ts-check
/**
 * The build that runs in a worker produces the model the main thread would.
 *
 * Moving work off the main thread is only allowed to change *when* the answer
 * arrives. `runCarveJob` is the whole of what the worker does - snapshot the
 * views, carve, pack the volume, the faces, the box and the palette - and this
 * check runs it beside a plain `carve()` of the same drawings and compares
 * everything the page then relies on:
 *
 * - every voxel and every one of its six face bytes;
 * - the palette's colours *and* its lookup, aliases included. A quantised
 *   import resolves thousands of source colours onto 255 slots, and a palette
 *   that came back without that map would send the eyedropper and the next
 *   `add()` through a nearest-colour search that can answer differently from
 *   the carve that has just run;
 * - the voxel count and the bounding box, which the page uses to frame the
 *   camera and to print the model's extent.
 *
 * `makeLivery` is the fixture because it overflows the palette - 324 colours
 * into 255 slots - which is the only way the alias map is non-trivial. The
 * geometry is a bare cube on purpose: geometry is what the other carve checks
 * are for, and here it should not be what fails.
 *
 * Red without the fix, measured 2026-09-24: `Palette.snapshot` reduced to
 * `serialize()`'s colours-only form loses all 324 lookup entries; packing the
 * volume without copying its face bytes differs on 6144 of them.
 */

import { carve } from '../../src/core/carve.js';
import { runCarveJob } from '../../src/core/carve-job.js';
import { Palette } from '../../src/core/palette.js';
import { Volume } from '../../src/core/volume.js';
import { makeLivery, viewsFromImages } from '../fixtures.mjs';

const N = 32;

export function run() {
  const direct = viewsFromImages(makeLivery(N));
  const palette = new Palette();
  const expected = carve(direct, N, palette, { mirrorMissing: false });

  // The job takes the same views as plain data - which is what `postMessage`
  // would hand the worker.
  const viaJob = viewsFromImages(makeLivery(N));
  const result = runCarveJob({ views: viaJob.map((v) => v.snapshot()), N, mirrorMissing: false });
  const volume = Volume.unpack(result.volume);
  const back = Palette.fromSnapshot(result.palette);

  /** @type {string[]} */
  const bad = [];
  let faceMismatch = 0;
  let voxelMismatch = 0;
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const was = expected.volume.get(x, y, z);
        if (was !== volume.get(x, y, z)) voxelMismatch++;
        if (!was) continue;
        for (let d = 0; d < 6; d++) {
          if (expected.volume.getFace(x, y, z, d) !== volume.getFace(x, y, z, d)) faceMismatch++;
        }
      }
    }
  }
  if (voxelMismatch > 0) bad.push(voxelMismatch + ' voxels differ');
  if (faceMismatch > 0) bad.push(faceMismatch + ' face bytes differ');

  if (back.colors.length !== palette.colors.length) {
    bad.push('palette ' + back.colors.length + ' entries against ' + palette.colors.length);
  } else {
    let colourDiff = 0;
    for (let i = 0; i < palette.colors.length; i++) {
      if (back.colors[i] !== palette.colors[i]) colourDiff++;
    }
    if (colourDiff > 0) bad.push(colourDiff + ' palette slots differ');
  }
  let aliasLost = 0;
  for (const [key, index] of palette.lookup) {
    if (back.lookup.get(key) !== index) aliasLost++;
  }
  if (aliasLost > 0) bad.push(aliasLost + ' of ' + palette.lookup.size + ' lookup entries lost');
  if (back.overflowed !== palette.overflowed) bad.push('overflow flag differs');

  if (volume.solidCount !== expected.volume.solidCount) {
    bad.push('count ' + volume.solidCount + ' against ' + expected.volume.solidCount);
  }
  if (result.stats.solid !== expected.stats.solid) bad.push('stats disagree about the voxel count');
  const want = expected.volume.bounds();
  if (JSON.stringify(result.box) !== JSON.stringify(want)) {
    bad.push('box ' + JSON.stringify(result.box) + ' against ' + JSON.stringify(want));
  }
  const faces = expected.volume.buildFaceInstances();
  if (result.faces.count !== faces.count) {
    bad.push('faces ' + result.faces.count + ' against ' + faces.count);
  }

  return {
    ok: bad.length === 0,
    detail: volume.solidCount + ' voxels, ' + result.faces.count + ' faces, '
      + palette.lookup.size + ' lookup entries, '
      + (bad.length === 0 ? 'identical' : bad.join('; ')),
  };
}
