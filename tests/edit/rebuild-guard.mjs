// @ts-check
/**
 * The rebuild guard asks before a rebuild only when there is something to lose.
 *
 * Everything that replaces the volume in `src/main.js` goes through
 * `mayDiscardEdits()`, and that function asks two questions of the model:
 * `History.hasEdits` for the voxels and `History.hasViewEdits` for the
 * drawings. So this is the whole guard minus the dialog - the dialog itself
 * needs a browser and is checked by hand.
 *
 * The second question exists because `hasEdits` deliberately ignores strokes on
 * drawings: a rebuild is what a painted drawing is waiting for (screen
 * specification `docs/specs/2026-09-24-3-view-editing-2d-3d.md`, section 4.4).
 * Five paths, though, do not rebuild from the drawing - they destroy it: Demo,
 * Clear, loading a project, dropping a new PNG into a filled slot, and the
 * slot's own drop button. Those must ask, and the last block reads `src/main.js`
 * to see
 * that each of the five still hands the guard something to ask about
 * (`src/main.js` cannot be imported in Node, `docs/TESTING.md`).
 *
 * Red without the fix: `hasEdits` does not exist, so the very first case
 * reports `undefined` instead of `false`/`true`; and with the five call sites
 * back to a bare `guardRebuild(...)`, the five `route.*` cases fail.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Volume } from '../../src/core/volume.js';
import { History } from '../../src/edit/history.js';
import { imageToken } from '../../src/edit/draw2d.js';

/** One newline, spelled out so the source-reading block below stays readable. */
const NL = String.fromCharCode(10);

/** One voxel painted, recorded as a stroke. @param {History} h @param {Volume} v */
function stroke(h, v, x, y, z, colour) {
  h.begin();
  h.touch(v, x, y, z);
  v.set(x, y, z, true);
  for (let d = 0; d < 6; d++) v.setFace(x, y, z, d, colour);
  return h.commit(v);
}

export function run() {
  const vol = new Volume(16, 16, 16);
  const h = new History();
  /** @type {string[]} */
  const bad = [];
  /** @param {string} name @param {*} got @param {*} want */
  const eq = (name, got, want) => { if (got !== want) bad.push(name + '=' + got + ' want ' + want); };

  // A volume straight out of a build has nothing to lose.
  eq('fresh', h.hasEdits, false);

  // One hand edit is enough for the question to be worth asking.
  eq('committed', stroke(h, vol, 2, 2, 2), true);
  eq('afterStroke', h.hasEdits, true);

  // Undoing back to the build leaves nothing to lose again.
  h.undo(vol);
  eq('afterUndo', h.hasEdits, false);

  // Redo puts the work back, so the question comes back with it.
  h.redo(vol);
  eq('afterRedo', h.hasEdits, true);

  // A stroke that changes nothing is dropped and must not raise the question.
  const clean = new History();
  clean.begin();
  clean.touch(vol, 2, 2, 2);
  eq('noOpCommit', clean.commit(vol), false);
  eq('afterNoOp', clean.hasEdits, false);

  // The pointer can still be down when a hotkey fires a rebuild.
  const open = new History();
  open.begin();
  open.touch(vol, 3, 3, 3);
  vol.set(3, 3, 3, true);
  eq('openStroke', open.hasEdits, true);

  // build() clears the history, which is what makes "nothing to lose" true.
  h.clear();
  eq('afterClear', h.hasEdits, false);

  // ------------------------------------------- the drawings, and who asks about them
  const paint = new History();
  const sheet = { width: 4, height: 4, data: new Uint8ClampedArray(64) };
  paint.viewSource = () => sheet;
  paint.pushView({
    kind: 'view',
    name: 'front',
    token: imageToken(sheet),
    width: 4,
    height: 4,
    rect: { x: 0, y: 0, w: 1, h: 1 },
    before: new Uint8ClampedArray(4),
    after: new Uint8ClampedArray([9, 9, 9, 255]),
  });
  // A painted drawing is invisible to the rebuild question and plain to the
  // other one. Both halves matter: the first keeps Build silent, the second
  // keeps Demo honest.
  eq('paint.hasEdits', paint.hasEdits, false);
  eq('paint.hasViewEdits', paint.hasViewEdits(), true);
  eq('paint.bySlot', paint.hasViewEdits('front'), true);
  eq('paint.otherSlot', paint.hasViewEdits('left'), false);

  // ------------------------------------------------ the five destructive paths
  const main = readFileSync(
    fileURLToPath(new URL('../../src/main.js', import.meta.url)), 'utf8'
  );
  /**
   * The body that follows a marker, far enough to hold the whole call.
   * @param {string} marker @param {number} lines
   */
  const after = (marker, lines) => {
    const at = main.indexOf(marker);
    return at < 0 ? '' : main.slice(at).split(NL).slice(0, lines).join(NL);
  };
  // `guardRebuild(proceed, revert, drawings)` and `mayDiscardEdits(drawings)`:
  // that last argument is the whole difference between "this asks" and "this
  // loses the painting in silence".
  /** @param {string} name @param {string} marker @param {number} lines @param {string} want */
  const route = (name, marker, lines, want) => {
    eq('route.' + name, after(marker, lines).includes(want), true);
  };
  route('demo', 'function loadDemo()', 14, ', undefined, true);');
  route('clear', "$('btn-clear').addEventListener", 10, ', undefined, true);');
  route('slotX', 'function slotAction(', 34, "act === 'x' ? name : undefined");
  route('loadInto', 'async function loadInto(', 20, ', undefined, name);');
  route('project', 'async function loadProject(', 12, 'mayDiscardEdits(true)');

  return {
    ok: bad.length === 0,
    detail: bad.length === 0
      ? '21/21 cases; a painted drawing: hasEdits false, hasViewEdits true,'
        + ' and all five destroying paths hand the guard the drawings they take'
      : bad.length + ' failed: ' + bad.join('; '),
  };
}
