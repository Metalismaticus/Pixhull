// @ts-check
/**
 * Outline and light write the right bytes into the right faces - and nothing
 * else.
 *
 * Three things are being guarded here, in order of how much they would cost if
 * they broke:
 *
 *  1. **No renumbering.** A face byte is an index, and the index is the
 *     project's source of truth (`CLAUDE.md`, "Правила проекта"). A bake may
 *     give a face a *different* index and may take a free slot for a new
 *     colour, but the slots that were already in use must still mean exactly
 *     what they meant, or every byte in the model and in the undo history
 *     becomes a lie.
 *  2. **The count promised before the press is the count the press delivers.**
 *     The palette holds 255 colours; "this needs 5 new ones" has to be true, or
 *     the number is worse than no number.
 *  3. **The outline is the silhouette, not every face.** On a 4x4x4 cube each
 *     side shows a 4x4 sheet of faces: 12 of the 16 are on the ring, 4 are
 *     inside it. So a one-voxel outline is 72 faces of the 96, and a two-voxel
 *     one is all 96.
 *
 * How the cases go red:
 *  - silhouette test dropped (every face outlined): `outlineFaces` 96, not 72.
 *  - thickness ignored: `thickFaces` 72, not 96.
 *  - `FACE_SHADE` applied to the wrong direction: `litPY` reports a changed
 *    byte on the one side whose tint is exactly 1.0.
 *  - unpainted faces baked anyway: `blankStays` reports a colour on slot 0.
 *  - plan and apply drifting apart: `planMatchesApply` / `newMatchesAdded`.
 *  - a full palette renumbered instead of degrading: `fullKeepsMeaning`.
 */

import { Palette, PALETTE_MAX } from '../../src/core/palette.js';
import { Volume } from '../../src/core/volume.js';
import { planBake, applyBake, FACE_SHADE, OUTLINE_DARKEN } from '../../src/core/bake.js';
import { bakeOffer } from '../../src/edit/bake-offer.js';
import { readFileSync } from 'node:fs';

/** A 4x4x4 cube of solid voxels at 4..7, every exposed face painted `idx`. */
function cube(idx) {
  const vol = new Volume(16, 16, 16);
  for (let x = 4; x < 8; x++) {
    for (let y = 4; y < 8; y++) {
      for (let z = 4; z < 8; z++) vol.set(x, y, z, true);
    }
  }
  for (let x = 4; x < 8; x++) {
    for (let y = 4; y < 8; y++) {
      for (let z = 4; z < 8; z++) vol.setAllFaces(x, y, z, idx);
    }
  }
  return vol;
}

/**
 * A solid 44x44x44 cube: 85 184 voxels and 11 616 exposed faces - enough to run
 * past the deadline check, which the walk makes every 256 voxels rather than
 * every one.
 */
function bigCube(idx) {
  const n = 44;
  const vol = new Volume(n, n, n);
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      for (let z = 0; z < n; z++) {
        vol.set(x, y, z, true);
        vol.setAllFaces(x, y, z, idx);
      }
    }
  }
  return vol;
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

  // ---------------------------------------------------------------- outline
  {
    const pal = new Palette();
    const red = pal.add(200, 40, 40);
    const vol = cube(red);

    const thin = planBake(vol, pal, { op: 'outline', thickness: 1 });
    eq('outlineFaces', thin.faces, 72);
    eq('outlineColours', thin.colours, 1);
    eq('outlineNew', thin.newColours, 1);
    eq('outlineOverflow', thin.overflow, false);
    eq('outlineComplete', thin.complete, true);

    const thick = planBake(vol, pal, { op: 'outline', thickness: 2 });
    eq('thickFaces', thick.faces, 96);

    const applied = applyBake(vol, pal, { op: 'outline', thickness: 1 });
    eq('planMatchesApply', applied.record.changed, thin.faces);
    eq('newMatchesAdded', applied.added, thin.newColours);
    eq('outlineSlotIsNew', pal.live, 2);
    // The colour that was there before means exactly what it meant.
    eq('redUntouched', pal.hex(red), '#c82828');
    const dark = pal.add(
      Math.round(200 * OUTLINE_DARKEN), Math.round(40 * OUTLINE_DARKEN), Math.round(40 * OUTLINE_DARKEN),
    );
    eq('outlineColourAdded', dark, 2);
    // A corner voxel is on the ring from every side; the middle of a side is not.
    eq('cornerOutlined', vol.getFace(4, 4, 4, 1), dark);
    eq('middleKept', vol.getFace(5, 5, 4, 5), red);

    // Pressing again darkens the ring again, exactly as light does. The
    // operation is "make this face's colour darker", not "mark it outlined",
    // and the note under the button keeps saying what the next press costs.
    const again = planBake(vol, pal, { op: 'outline', thickness: 1 });
    eq('outlineCompounds', again.faces, 72);
  }

  // -------------------------------------------- outline in a chosen colour
  {
    const pal = new Palette();
    const red = pal.add(200, 40, 40);
    const ink = pal.add(20, 20, 30);
    const vol = cube(red);
    const plan = planBake(vol, pal, { op: 'outline', thickness: 1, index: ink });
    eq('chosenNew', plan.newColours, 0);
    eq('chosenFaces', plan.faces, 72);
    applyBake(vol, pal, { op: 'outline', thickness: 1, index: ink });
    eq('chosenLive', pal.live, 2);
    eq('chosenOnRing', vol.getFace(4, 4, 4, 1), ink);
    eq('chosenOffRing', vol.getFace(5, 5, 4, 5), red);
  }

  // ------------------------------------------------------------------ light
  {
    const pal = new Palette();
    const red = pal.add(200, 40, 40);
    const vol = cube(red);
    // One exposed face the carve never painted. A bake has no colour to darken
    // there and must leave the blank alone rather than invent one.
    vol.setFace(7, 5, 5, 0, 0);

    const plan = planBake(vol, pal, { op: 'light' });
    // 96 exposed faces, minus the 16 on +Y whose tint is exactly 1.0, minus the
    // one blank face on +X.
    eq('litFaces', plan.faces, 79);
    eq('litColours', plan.colours, 5);
    eq('litNew', plan.newColours, 5);

    const applied = applyBake(vol, pal, { op: 'light' });
    eq('litApplied', applied.record.changed, 79);
    eq('litAdded', applied.added, 5);
    eq('blankStays', vol.getFace(7, 5, 5, 0), 0);
    eq('litPY', vol.getFace(5, 7, 5, 2), red);
    const wantNX = pal.add(
      Math.round(200 * FACE_SHADE[1]), Math.round(40 * FACE_SHADE[1]), Math.round(40 * FACE_SHADE[1]),
    );
    eq('litNX', vol.getFace(4, 5, 5, 1), wantNX);
    eq('litRedKept', pal.hex(red), '#c82828');

    // Light is not idempotent by nature - it would darken again - so it says so
    // rather than pretending: a second bake is a second, honest operation.
    eq('litTwiceCounts', planBake(vol, pal, { op: 'light' }).faces > 0, true);
  }

  // ------------------------------------------------ a palette with no room
  {
    const pal = new Palette();
    const red = pal.add(200, 40, 40);
    for (let i = 0; pal.colors.length < PALETTE_MAX; i++) pal.add(i & 255, (i * 7) & 255, (i * 13) & 255);
    eq('fullBefore', pal.full, true);
    const vol = cube(red);
    const plan = planBake(vol, pal, { op: 'outline', thickness: 1 });
    eq('fullSpare', plan.spare, 0);
    eq('fullOverflow', plan.overflow, true);

    const wasRed = pal.hex(red);
    const liveBefore = pal.live;
    const applied = applyBake(vol, pal, { op: 'outline', thickness: 1 });
    eq('fullAddsNothing', applied.added, 0);
    eq('fullKeepsMeaning', pal.hex(red), wasRed);
    eq('fullKeepsLive', pal.live, liveBefore);
    // Degraded, not refused: the ring landed on the nearest colour the palette
    // already held, which is a colour, not a hole.
    eq('fullStillPainted', pal.has(vol.getFace(4, 4, 4, 1)), true);
    eq('fullChangedSome', applied.record.changed > 0, true);
  }

  // ------------------------------------------------------------ the offers
  {
    const pal = new Palette();
    const red = pal.add(200, 40, 40);
    const vol = cube(red);
    const opts = { op: /** @type {'outline'} */ ('outline'), thickness: 1 };
    eq('offerBuilding', bakeOffer({ palette: pal, volume: vol, building: true, opts }).noteKey, 'edit.bakeBuilding');
    eq('offerNoModel', bakeOffer({ palette: pal, volume: null, building: false, opts }).noteKey, 'edit.bakeNoModel');
    const ready = bakeOffer({ palette: pal, volume: vol, building: false, opts });
    eq('offerReady', ready.noteKey, 'edit.bakeReady');
    eq('offerEnabled', ready.enabled, true);
    eq('offerQuiet', ready.warn, false);
    eq('offerCarriesPlan', ready.plan ? ready.plan.faces : 0, 72);

    // Asked for a fixed colour, a second press has nothing left to do: every
    // ring face already wears that very slot.
    const ink = pal.add(20, 20, 30);
    const inkOpts = { op: /** @type {'outline'} */ ('outline'), thickness: 1, index: ink };
    applyBake(vol, pal, inkOpts);
    const done = bakeOffer({ palette: pal, volume: vol, building: false, opts: inkOpts });
    eq('offerNothing', done.noteKey, 'edit.bakeNothing');
    eq('offerNothingDark', done.enabled, false);

    // A deadline in the past stops the walk, and the offer says the number is a
    // floor rather than a total - the button stays live, because applying has
    // no budget.
    const big = bigCube(red);
    const partial = bakeOffer({
      palette: pal, volume: big, building: false, opts: { op: 'light' }, deadline: -1,
    });
    eq('offerPartialLive', partial.enabled, true);
    eq('offerPartialSaysSo', partial.noteKey, 'edit.bakePartial');

    // A palette with no room says so even from an unfinished count: it is
    // already short of the colours counted so far.
    const full = new Palette();
    const red2 = full.add(200, 40, 40);
    for (let i = 0; full.colors.length < PALETTE_MAX; i++) full.add(i & 255, (i * 7) & 255, (i * 13) & 255);
    const fullVol = bigCube(red2);
    eq('offerOverflow', bakeOffer({
      palette: full, volume: fullVol, building: false, opts: { op: 'light' },
    }).noteKey, 'edit.bakeOverflow');
    eq('offerOverflowPartial', bakeOffer({
      palette: full, volume: fullVol, building: false, opts: { op: 'light' }, deadline: -1,
    }).noteKey, 'edit.bakeOverflowPartial');
  }

  // ------------------------------------------------------- the budget is real
  //
  // A budget that only stops the walk when the walk changes something is not a
  // budget. An outline reads a whole neighbourhood per face and changes only a
  // silhouette, so a count that ticked on changed faces ran the model to the
  // end whatever deadline it was given: on the 256 lorry a 150 ms budget cost
  // 369 / 551 / 616 ms at thickness 1 / 2 / 3 in the browser, and 408 / 469 /
  // 636 ms in Node. It is the panel's promise of "at least N" that pays for it,
  // and a freeze the user did not ask for.
  //
  // Red without the fix, deterministically rather than by the clock: this cube
  // changes 2 952 faces under a thickness-3 outline, fewer than the 8 192 the
  // old tick counted to, so the old walk never looked at the deadline at all
  // and came back `complete: true`.
  {
    const pal = new Palette();
    const red = pal.add(200, 40, 40);
    const vol = bigCube(red);

    const outline = planBake(vol, pal, { op: 'outline', thickness: 3 }, -1);
    eq('budgetStopsOutline', outline.complete, false);
    const whole = planBake(vol, pal, { op: 'outline', thickness: 3 });
    eq('budgetOutlineWhole', whole.complete, true);
    eq('budgetOutlineUnderTick', whole.faces < 8192, true);
    // Stopped on the walk, the count is a floor taken from the first 256 voxels
    // rather than from the first 8 192 changed faces.
    eq('budgetStopsFew', outline.faces < whole.faces / 4, true);

    const light = planBake(vol, pal, { op: 'light' }, -1);
    eq('budgetStopsLight', light.complete, false);
    eq('budgetLightFew', light.faces < 2000, true);
  }

  // ----------------------------------------- nobody pays for a count untold
  //
  // Structural, because `src/main.js` needs a DOM and a WebGL2 context and does
  // not import in Node (`docs/TESTING.md`, "Чего проверки не видят"). What it
  // guards is the wiring, not the numbers: the usage recount runs 300 ms after
  // every stroke, and while it also asked for both bake plans, every stroke
  // paid up to 300 ms of budget for two notes nobody was looking at.
  {
    const src = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
    const usage = src.slice(src.indexOf('function applyUsage()'));
    const body = usage.slice(0, usage.indexOf('\n}'));
    eq('usageHasBody', body.length > 0 && body.length < 2000, true);
    eq('usageInvalidates', body.includes('invalidateBakeOffers()'), true);
    eq('usageBuysNoCount', /(schedule|refresh)BakeOffers/.test(body), false);
    // And the counts are bought where the hand reaches for them.
    eq('reachCounts', src.includes("'pointerenter', countBakeOffers"), true);
    eq('reachCountsByKey', src.includes("'focus', countBakeOffers"), true);
  }

  return {
    ok: bad.length === 0,
    detail: bad.length === 0
      ? cases + ' cases; outline 72 of 96 faces at one voxel and 96 at two, '
        + 'light 79 faces into 5 new slots, full palette adds 0 and renumbers none'
      : bad.length + ' of ' + cases + ' failed: ' + bad.slice(0, 4).join('; '),
  };
}
