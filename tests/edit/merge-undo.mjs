// @ts-check
/**
 * A palette merge is one undoable step, and undoing it puts everything back.
 *
 * A merge is the widest edit in the product: it rewrites face bytes anywhere in
 * the model and frees palette slots at the same time. Item 1 of this batch was
 * exactly this class of defect - an operation that quietly threw hand work away
 * - so the merge has to be as reversible as a brush stroke, and reversible in
 * one press rather than one press per face.
 *
 * It also cannot be undone by running the map backwards: merging is many-to-one,
 * and once two slots are one, the map no longer says which faces came from which
 * slot. The step carries the old face bytes and both palette states instead.
 *
 * How the cases go red:
 *  - `pushMerge` / the `merge` branch of `undo` missing: every case throws.
 *  - undo without `Volume.restoreFaces`: `facesBack` reports 12 bytes still
 *    wearing the keeper's index.
 *  - undo without `palette.restore`: `liveBack` reports 3 colours instead of 5,
 *    `holesBack` 2 holes instead of none, and the merged slot answers #000000.
 *  - `remapFaces` not recording what it changed: `recordSize` reports 0 and the
 *    faces never come back.
 *  - a merge pushed as one entry per face: `steps` would report 12, not 1.
 */

import { Palette, MERGE_DELTA_E } from '../../src/core/palette.js';
import { Volume } from '../../src/core/volume.js';
import { History } from '../../src/edit/history.js';

export function run() {
  /** @type {string[]} */
  const bad = [];
  let cases = 0;
  /** @param {string} name @param {*} got @param {*} want */
  const eq = (name, got, want) => {
    cases++;
    if (got !== want) bad.push(name + '=' + got + ' want ' + want);
  };

  const pal = new Palette();
  const red = pal.add(200, 40, 40);
  const redTwin = pal.add(201, 41, 42);
  const green = pal.add(40, 180, 70);
  const dark = pal.add(10, 10, 10);
  const darkTwin = pal.add(11, 11, 12);
  const slots = [red, redTwin, green, dark, darkTwin];

  const vol = new Volume(16, 16, 16);
  for (let i = 0; i < slots.length; i++) {
    vol.set(i, 0, 0, true);
    for (let d = 0; d < 6; d++) vol.setFace(i, 0, 0, d, slots[i]);
  }

  /** Every painted face byte, in one string, for comparing states. */
  const faceBytes = () => {
    const out = [];
    for (let i = 0; i < slots.length; i++) {
      for (let d = 0; d < 6; d++) out.push(vol.getFace(i, 0, 0, d));
    }
    return out.join(',');
  };
  const before = faceBytes();

  const h = new History();
  const weights = new Uint32Array(256);
  weights[red] = 500;
  weights[dark] = 300;
  const plan = pal.planMerge(MERGE_DELTA_E, weights);
  const snapBefore = pal.snapshot();
  const record = vol.remapFaces(plan.remap);
  pal.applyMerge(plan);
  h.pushMerge(plan.remap, record, snapBefore, pal.snapshot());

  const merged = faceBytes();
  eq('steps', h.stack.length, 1);
  eq('canUndo', h.canUndo, true);
  eq('hasEdits', h.hasEdits, true);
  eq('recordSize', record.changed, 12);
  eq('mergedLive', pal.live, 3);

  // A merge undone without a palette to write to is not half-undone: the step
  // stays where it is.
  eq('undoNeedsPalette', h.undo(vol), null);
  eq('cursorHeld', h.cursor, 1);

  // ------------------------------------------------------------------- undo
  eq('undoKind', h.undo(vol, pal), 'merge');
  eq('facesBack', faceBytes(), before);
  eq('liveBack', pal.live, 5);
  eq('holesBack', pal.free.size, 0);
  eq('twinColourBack', pal.hex(redTwin), '#c9292a');
  eq('twinKeyBack', pal.add(201, 41, 42), redTwin);
  eq('canRedo', h.canRedo, true);

  // ------------------------------------------------------------------- redo
  eq('redoKind', h.redo(vol, pal), 'merge');
  eq('facesMergedAgain', faceBytes(), merged);
  eq('liveMergedAgain', pal.live, 3);
  eq('holesAgain', [...pal.free].sort((a, b) => a - b).join(','), plan.freed.join(','));

  // --------------------------------------- a stroke on top, then both undone
  h.begin();
  h.touch(vol, 2, 0, 0);
  vol.setFace(2, 0, 0, 0, red);
  eq('strokeRecorded', h.commit(vol), true);
  eq('twoSteps', h.stack.length, 2);
  const painted = faceBytes();

  eq('undoStroke', h.undo(vol, pal), 'voxels');
  eq('afterStrokeUndo', faceBytes(), merged);
  eq('paletteUntouchedByStroke', pal.live, 3);
  eq('undoMergeUnderIt', h.undo(vol, pal), 'merge');
  eq('backToStart', faceBytes(), before);
  eq('liveBackAgain', pal.live, 5);

  // Redoing both walks forward through the same two states.
  eq('redoMerge', h.redo(vol, pal), 'merge');
  eq('redoStroke', h.redo(vol, pal), 'voxels');
  eq('forwardAgain', faceBytes(), painted);

  // A new step after an undo drops the redo tail, merge included.
  h.undo(vol, pal);
  h.begin();
  h.touch(vol, 3, 0, 0);
  vol.setFace(3, 0, 0, 1, green);
  h.commit(vol);
  eq('tailDropped', h.canRedo, false);
  eq('stackAfterTail', h.stack.length, 2);

  return {
    ok: bad.length === 0,
    detail: bad.length === 0
      ? cases + ' cases; one step for ' + record.changed
        + ' face bytes and ' + plan.freed.length + ' freed slots, restored exactly'
      : bad.length + ' of ' + cases + ' failed: ' + bad.slice(0, 4).join('; '),
  };
}
