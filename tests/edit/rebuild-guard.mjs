// @ts-check
/**
 * The rebuild guard asks before a rebuild only when there is something to lose.
 *
 * Everything that replaces the volume in `src/main.js` goes through
 * `mayDiscardEdits()`, and that function asks exactly one question of the model:
 * `History.hasEdits`. So this is the whole guard minus the dialog - the dialog
 * itself needs a browser and is checked by hand.
 *
 * Red without the fix: `hasEdits` does not exist, so the very first case
 * reports `undefined` instead of `false`/`true`.
 */

import { Volume } from '../../src/core/volume.js';
import { History } from '../../src/edit/history.js';

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

  return { ok: bad.length === 0, detail: bad.length === 0 ? '8/8 cases' : bad.join('; ') };
}
