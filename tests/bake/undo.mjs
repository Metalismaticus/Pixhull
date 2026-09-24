// @ts-check
/**
 * A bake is one undoable step, and undoing it puts everything back.
 *
 * The roadmap asks for exactly this ("Ctrl+Z отменяет каждую одной записью"),
 * and the batch before this one had the same class of defect twice: an
 * operation that quietly threw hand work away. A bake is the widest colour
 * change in the product after a merge - it repaints most of the model's skin
 * and can grow the palette while doing it - so it has to be as reversible as a
 * brush stroke, in one press rather than one press per face.
 *
 * It cannot reuse the merge's entry either. A merge is a 256-entry map that
 * replays forwards; a bake sends two faces wearing one slot to two different
 * slots, because the tint depends on the face's direction. Only a byte-by-byte
 * record of both sides can undo that, and this check is what says so.
 *
 * How the cases go red:
 *  - `pushBake` or the `bake` branch of `undo` missing: every case throws or
 *    reports null.
 *  - undo without `writeBake`: `facesBack` reports 80 bytes still lit.
 *  - undo without `palette.restore`: `liveBack` reports 6 colours, not 1.
 *  - one entry per face instead of one per bake: `steps` reports 80, not 1.
 *  - a bake counted as a drawing edit rather than a model edit: `hasEdits`
 *    false, and a rebuild would throw it away without asking.
 */

import { Palette } from '../../src/core/palette.js';
import { Volume } from '../../src/core/volume.js';
import { applyBake } from '../../src/core/bake.js';
import { History } from '../../src/edit/history.js';

/** A 4x4x4 cube at 4..7 with every face painted `idx`. */
function cube(idx) {
  const vol = new Volume(16, 16, 16);
  for (let x = 4; x < 8; x++) {
    for (let y = 4; y < 8; y++) {
      for (let z = 4; z < 8; z++) {
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

  const pal = new Palette();
  const red = pal.add(200, 40, 40);
  const vol = cube(red);

  /** Every face byte of the cube in one string, for comparing whole states. */
  const faceBytes = () => {
    const out = [];
    vol.forEachSolid((x, y, z) => {
      for (let d = 0; d < 6; d++) out.push(vol.getFace(x, y, z, d));
    });
    return out.join(',');
  };
  const start = faceBytes();

  /**
   * How many face bytes differ between two states. A count rather than the two
   * strings: `detail` is one line with a number in it, and dumping 576 bytes
   * would bury the number that tells a near miss from a collapse.
   */
  const diff = (a, b) => {
    const x = a.split(',');
    const y = b.split(',');
    let n = 0;
    for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) n++;
    return n;
  };

  const h = new History();
  const snapBefore = pal.snapshot();
  const { record } = applyBake(vol, pal, { op: 'light' });
  h.pushBake('light', record, snapBefore, pal.snapshot());
  const lit = faceBytes();

  eq('steps', h.stack.length, 1);
  // 96 exposed faces less the 16 on +Y, whose tint is exactly 1.0.
  eq('changed', record.changed, 80);
  eq('canUndo', h.canUndo, true);
  // A rebuild must ask before throwing this away: it is work on the model, not
  // on a drawing waiting to be carved.
  eq('hasEdits', h.hasEdits, true);
  eq('hasViewEdits', h.hasViewEdits(), false);
  eq('litLive', pal.live, 6);

  // Half an undo is not an undo: without a palette to write to, the step stays.
  eq('undoNeedsPalette', h.undo(vol), null);
  eq('cursorHeld', h.cursor, 1);

  // ---------------------------------------------------------------- undo
  eq('undoKind', h.undo(vol, pal), 'bake');
  eq('facesBack', diff(faceBytes(), start), 0);
  eq('liveBack', pal.live, 1);
  eq('redBack', pal.hex(red), '#c82828');
  eq('lengthBack', pal.colors.length, 2);
  eq('canRedo', h.canRedo, true);

  // ---------------------------------------------------------------- redo
  eq('redoKind', h.redo(vol, pal), 'bake');
  eq('facesLitAgain', diff(faceBytes(), lit), 0);
  eq('liveLitAgain', pal.live, 6);

  // ------------------------------- an outline on top, then both undone
  const snapMid = pal.snapshot();
  const second = applyBake(vol, pal, { op: 'outline', thickness: 1 });
  h.pushBake('outline', second.record, snapMid, pal.snapshot());
  const outlined = faceBytes();
  eq('twoSteps', h.stack.length, 2);
  eq('outlineOnTop', outlined === lit, false);

  eq('undoOutline', h.undo(vol, pal), 'bake');
  eq('backToLit', diff(faceBytes(), lit), 0);
  eq('liveAtLit', pal.live, 6);
  eq('undoLightUnder', h.undo(vol, pal), 'bake');
  eq('backToStart', diff(faceBytes(), start), 0);
  eq('liveAtStart', pal.live, 1);

  eq('redoLight', h.redo(vol, pal), 'bake');
  eq('redoOutline', h.redo(vol, pal), 'bake');
  eq('forwardAgain', diff(faceBytes(), outlined), 0);

  // ------------------------- a brush stroke interleaves with the bakes
  h.begin();
  h.touch(vol, 5, 5, 4);
  vol.setFace(5, 5, 4, 5, red);
  eq('strokeRecorded', h.commit(vol), true);
  eq('threeSteps', h.stack.length, 3);

  eq('undoStroke', h.undo(vol, pal), 'voxels');
  eq('afterStrokeUndo', diff(faceBytes(), outlined), 0);

  // A new step after an undo drops the redo tail, bakes included.
  h.begin();
  h.touch(vol, 6, 6, 4);
  vol.setFace(6, 6, 4, 5, red);
  h.commit(vol);
  eq('tailDropped', h.canRedo, false);
  eq('stackAfterTail', h.stack.length, 3);

  return {
    ok: bad.length === 0,
    detail: bad.length === 0
      ? cases + ' cases; one step for ' + record.changed
        + ' face bytes and 5 new slots, restored exactly, and two bakes stack'
      : bad.length + ' of ' + cases + ' failed: ' + bad.slice(0, 4).join('; '),
  };
}
