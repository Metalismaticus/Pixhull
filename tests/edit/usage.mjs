// @ts-check
/**
 * The palette's face counts: exposed faces only, and honest about stopping.
 *
 * Two ways to get this wrong, both of which lie to the user about which
 * colours his model actually wears:
 *
 * 1. Counting buried faces. A voxel keeps a colour on all six of its faces;
 *    only the ones with nothing in front of them are painting anything.
 * 2. Reporting a count that never finished as zero. Zero is shown as "unused"
 *    and dims the swatch, so a model too big for the budget would show its
 *    most-used colours greyed out.
 *
 * Red without the fix: drop the `this.get(neighbour)` test in
 * `countExposedFaces` and the block reports 48 faces instead of 24; make it
 * return `complete: true` regardless and the deadline case passes silently.
 */

import { Volume } from '../../src/core/volume.js';

export function run() {
  /** @type {string[]} */
  const bad = [];

  // A 2x2x2 block inside a 4^3 grid: 8 voxels, 48 painted faces, of which
  // exactly 24 are exposed - each voxel has three neighbours in the block.
  const vol = new Volume(4, 4, 4);
  for (let z = 1; z <= 2; z++) {
    for (let y = 1; y <= 2; y++) {
      for (let x = 1; x <= 2; x++) {
        vol.set(x, y, z, true);
        vol.setAllFaces(x, y, z, 3);
      }
    }
  }

  const a = vol.countExposedFaces();
  if (!a.complete) bad.push('a 4^3 grid did not finish without a deadline');
  if (a.counts[3] !== 24) bad.push('slot 3 counts ' + a.counts[3] + ' faces, want 24');
  if (a.counts[0] !== 0) bad.push('slot 0 counted ' + a.counts[0] + ' faces; it is the empty entry');

  // Repainting one voxel splits the count without changing the total.
  vol.setAllFaces(1, 1, 1, 7);
  const b = vol.countExposedFaces();
  if (b.counts[3] + b.counts[7] !== 24) {
    bad.push('after a repaint the total is ' + (b.counts[3] + b.counts[7]) + ', want 24');
  }
  if (b.counts[7] !== 3) bad.push('the repainted corner shows ' + b.counts[7] + ' faces, want 3');

  // An unused slot is a genuine zero, not an absence.
  if (b.counts[9] !== 0) bad.push('an untouched slot counts ' + b.counts[9]);

  // A deadline already past stops the walk, and the walk says so. The check
  // happens every eighth chunk, so the volume has to span more than eight.
  const big = new Volume(256, 256, 256);
  // One isolated voxel in each of 40 different chunks: 6 exposed faces each.
  for (let i = 0; i < 40; i++) {
    const x = (i & 3) * 16, y = ((i >> 2) & 3) * 16, z = (i >> 4) * 16;
    big.set(x, y, z, true);
    big.setAllFaces(x, y, z, 5);
  }
  const stopped = big.countExposedFaces(performance.now() - 1);
  if (stopped.complete) bad.push('a walk past its deadline still called itself complete');

  // The same walk without a deadline does finish, so the flag means something.
  const finished = big.countExposedFaces();
  if (!finished.complete) bad.push('the walk did not finish without a deadline');
  if (finished.counts[5] !== 40 * 6) {
    bad.push('scattered voxels count ' + finished.counts[5] + ' faces, want ' + 40 * 6);
  }

  return {
    ok: bad.length === 0,
    detail: bad.length === 0
      ? '24 of 48 faces exposed, 3 after a repaint, 240 scattered, deadline honest'
      : bad.slice(0, 3).join('; '),
  };
}
