// @ts-check
/**
 * Merging near-duplicates frees slots without renumbering anything.
 *
 * The operation exists because a full palette used to be a dead end: the art
 * brought in more than 255 colours, the extras snapped to the nearest, and
 * nothing the user could do gave a slot back. Merging two entries nobody can
 * tell apart does - but only if it keeps the one promise this project cannot
 * break: a face byte means the same colour after the operation as before.
 * Freeing a slot is allowed, renumbering the survivors is not
 * (`docs/DECISIONS.md`, "Палитра индексная").
 *
 * What is pinned here, and how each case goes red:
 *  - `planMerge`/`applyMerge`/`Volume.remapFaces` missing: every case throws.
 *  - keeper choice by weight: drop the ordering by weight and
 *    `keeperFollowsWeight` answers with slot 1 where the surface says slot 2.
 *  - chaining: let a merged slot pull in its own neighbours (single linkage) and
 *    the grey ramp loses 3 slots instead of 2, leaving 2 colours where 3 are
 *    still distinguishable.
 *  - `nearest` skipping holes: drop the `free.has(i)` guard and the nearest
 *    entry to black becomes the hole the merge just made (measured: slot 2
 *    instead of slot 4).
 *  - `serialize` carrying the holes: drop `free` from it and a reopened project
 *    reports 5 live colours where it has 4, two of them black.
 *
 * Numbers below come from this run: the default threshold is `MERGE_DELTA_E`
 * (1.0) and the fixture pairs are 0.46 (red twins) and 0.50 (dark twins) apart.
 * The grey ramp names its own threshold, 2.0, because it is about the grouping
 * rule rather than about the default: its steps are 1.88 apart and every second
 * step 3.81.
 */

import { Palette, MERGE_DELTA_E } from '../../src/core/palette.js';
import { Volume } from '../../src/core/volume.js';
import { packedToLab, ciede2000 } from '../../src/core/color.js';

/** @param {number} a @param {number} b */
function dist(a, b) {
  const A = packedToLab(a);
  const B = packedToLab(b);
  return ciede2000(A[0], A[1], A[2], B[0], B[1], B[2]);
}

export function run() {
  /** @type {string[]} */
  const bad = [];
  let cases = 0;
  /** @param {string} name @param {*} got @param {*} want */
  const eq = (name, got, want) => {
    cases++;
    if (got !== want) bad.push(name + '=' + got + ' want ' + want);
  };

  // ---------------------------------------------------- the fixture palette
  const p = new Palette();
  const red = p.add(200, 40, 40);
  const redTwin = p.add(201, 41, 42); // 0.46 away from red
  const green = p.add(40, 180, 70);
  const dark = p.add(10, 10, 10);
  const darkTwin = p.add(11, 11, 12); // 0.50 away from dark
  eq('liveBefore', p.live, 5);
  eq('twinsClose', dist(0xc82828, 0xc9292a) < MERGE_DELTA_E, true);
  eq('greenFar', dist(0xc82828, 0x28b446) > MERGE_DELTA_E, true);

  // A model painted with all five, so the face bytes can be compared byte for
  // byte afterwards.
  const vol = new Volume(16, 16, 16);
  const slots = [red, redTwin, green, dark, darkTwin];
  for (let i = 0; i < slots.length; i++) {
    vol.set(i, 0, 0, true);
    for (let d = 0; d < 6; d++) vol.setFace(i, 0, 0, d, slots[i]);
  }

  // ------------------------------------------------ the plan, and the keeper
  // Weights: the twins paint less than the slots they merge into, so the bigger
  // surface is the one whose index survives and whose bytes never move.
  const weights = new Uint32Array(256);
  weights[red] = 500;
  weights[redTwin] = 20;
  weights[dark] = 300;
  weights[darkTwin] = 10;
  weights[green] = 100;

  const plan = p.planMerge(MERGE_DELTA_E, weights);
  eq('freedCount', plan.freed.length, 2);
  eq('freedAreTwins', plan.freed.join(','), [redTwin, darkTwin].sort((a, b) => a - b).join(','));
  eq('groups', plan.groups, 2);
  eq('keeperHeavy', plan.remap[redTwin], red);
  eq('keeperHeavyDark', plan.remap[darkTwin], dark);
  eq('keeperUntouched', plan.remap[red], red);
  eq('greenUntouched', plan.remap[green], green);
  eq('worstWithinThreshold', plan.worst <= MERGE_DELTA_E, true);
  eq('planChangedNothing', p.live, 5); // a plan is data, not an edit

  // The light slot keeps its index when it is the one painting more.
  const flipped = new Uint32Array(256);
  flipped[redTwin] = 900;
  flipped[red] = 5;
  eq('keeperFollowsWeight', p.planMerge(MERGE_DELTA_E, flipped).remap[red], redTwin);

  // ------------------------------------------------------- applying the plan
  const record = vol.remapFaces(plan.remap);
  eq('facesRepainted', record.changed, 12); // two voxels, six faces each
  eq('freedApplied', p.applyMerge(plan), 2);
  eq('live', p.live, 3);
  eq('sizeUnchanged', p.size, 6); // nothing was removed, so nothing renumbered
  eq('holesKnown', [...p.free].sort((a, b) => a - b).join(','), plan.freed.join(','));

  let moved = 0;
  for (let i = 0; i < slots.length; i++) {
    const want = plan.remap[slots[i]];
    for (let d = 0; d < 6; d++) if (vol.getFace(i, 0, 0, d) !== want) moved++;
  }
  eq('faceBytesFollowPlan', moved, 0);
  eq('keeperColourIntact', p.hex(red), '#c82828');
  eq('greenColourIntact', p.hex(green), '#28b446');
  eq('holeHasNoColour', p.has(redTwin), false);

  // The colour the merged slot held now answers with the keeper, so the
  // eyedropper and the next `add()` agree with the model.
  eq('twinKeyRedirected', p.lookup.get(0xc9292a), red);
  eq('addTwinColour', p.add(201, 41, 42), red);

  // A hole is not a colour: nothing may match against it, and it draws as
  // transparent rather than as black.
  eq('nearestSkipsHole', p.nearest(0, 0, 0), dark);
  const tex = p.toTextureData();
  eq('holeTransparent', tex[redTwin * 4 + 3], 0);
  eq('keeperOpaque', tex[red * 4 + 3], 255);

  // --------------------------------------------------- the freed slot is real
  const reused = p.add(0, 120, 255);
  eq('reusedLowestHole', reused, Math.min(...plan.freed));
  eq('liveAfterReuse', p.live, 4);
  eq('sizeAfterReuse', p.size, 6); // filled a hole instead of growing
  eq('reusedColour', p.hex(reused), '#0078ff');

  // A palette at the cap has somewhere to put a colour again. The fixture is
  // art-shaped on purpose: every second colour is a shade of the one before it,
  // which is what a quantised import of a photographed model actually looks
  // like (measured on the owner's lorry: 136 of 255 slots are near-duplicates).
  const fullPal = new Palette();
  for (let k = 0; k < 200; k++) {
    const r = (k * 37) & 255, g = (k * 53) & 255, b = (k * 97) & 255;
    fullPal.add(r, g, b);
    fullPal.add(r ^ 1, g, b); // one bit apart: the same colour to any eye
  }
  eq('capReached', fullPal.size, 256);
  eq('fullBefore', fullPal.full, true);
  const capPlan = fullPal.planMerge(MERGE_DELTA_E);
  eq('capPlanFreesSomething', capPlan.freed.length > 0, true);
  fullPal.applyMerge(capPlan);
  eq('fullAfter', fullPal.full, false);
  const fresh = fullPal.add(1, 2, 3);
  eq('capAddsFresh', fullPal.has(fresh) && fullPal.hex(fresh) === '#010203', true);

  // ------------------------------------------------- no chaining down a ramp
  // Consecutive steps are 1.88 apart and every second step 3.81, so at a
  // threshold of 2.0 single linkage would swallow the whole ramp; keeper-first
  // must not. Stated as a number here rather than taken from the default, so
  // the case keeps its meaning if the default ever moves.
  const RAMP_THRESHOLD = 2.0;
  const ramp = new Palette();
  for (let k = 0; k < 5; k++) ramp.add(100 + 5 * k, 100 + 5 * k, 100 + 5 * k);
  const rampPlan = ramp.planMerge(RAMP_THRESHOLD);
  eq('rampFreed', rampPlan.freed.length, 2);
  eq('rampWorst', rampPlan.worst <= RAMP_THRESHOLD, true);
  ramp.applyMerge(rampPlan);
  eq('rampLive', ramp.live, 3);

  // ------------------------------------------- holes survive save and reload
  const reopened = Palette.deserialize(JSON.parse(JSON.stringify(p.serialize())));
  eq('reopenedLive', reopened.live, p.live);
  eq('reopenedHoles', [...reopened.free].join(','), [...p.free].sort((a, b) => a - b).join(','));
  eq('reopenedKeeper', reopened.hex(red), '#c82828');
  eq('reopenedNearest', reopened.nearest(0, 0, 0), dark);
  const viaSnapshot = Palette.fromSnapshot(p.snapshot());
  eq('snapshotHoles', [...viaSnapshot.free].join(','), [...p.free].join(','));
  eq('snapshotAliases', viaSnapshot.add(201, 41, 42), red);

  return {
    ok: bad.length === 0,
    detail: bad.length === 0
      ? cases + ' cases; 2 of 5 slots freed, 12 face bytes moved, worst ΔE '
        + plan.worst.toFixed(2) + ' at threshold ' + MERGE_DELTA_E.toFixed(1)
      : bad.length + ' of ' + cases + ' failed: ' + bad.slice(0, 4).join('; '),
  };
}
