// @ts-check
/**
 * Ctrl+Z is the only undo, so a recolour has to live on the same stack as a
 * brush stroke - and has to behave there.
 *
 * Three things are pinned:
 *
 * 1. A picker drag is one step. The colour input fires `input` for every pixel
 *    the pointer crosses; 40 of them must leave one entry, not 40, and that one
 *    entry must return the colour the slot held before the drag, not the shade
 *    the pointer passed a moment ago.
 * 2. Undo says what it undid. A recolour touches no voxel, so the caller must
 *    be able to skip rebuilding the face buffer and upload the palette texture
 *    instead - the difference between instant and a full model rebuild at 512.
 * 3. The two kinds interleave. A stroke after a recolour drops the redo tail
 *    of both, and undoing back past the recolour restores the old colour.
 *
 * Red without the fix: `pushPalette` does not exist and `undo()` returns a
 * boolean, so `dragIsOneStep` and `undoKind` both fail.
 */

import { Volume } from '../../src/core/volume.js';
import { Palette } from '../../src/core/palette.js';
import { History } from '../../src/edit/history.js';

/** @param {History} h @param {Volume} v */
function stroke(h, v, x, y, z, colour) {
  h.begin();
  h.touch(v, x, y, z);
  v.set(x, y, z, true);
  for (let d = 0; d < 6; d++) v.setFace(x, y, z, d, colour);
  return h.commit(v);
}

/** One `input` event from the colour picker. @param {Palette} p @param {History} h */
function pickerInput(p, h, slot, before, r, g, b) {
  if (!p.replace(slot, r, g, b)) return;
  h.pushPalette(slot, before, p.colors[slot] | 0);
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

  const vol = new Volume(8, 8, 8);
  const pal = new Palette();
  const slot = pal.add(255, 0, 0);
  const other = pal.add(0, 0, 255);
  const h = new History();

  stroke(h, vol, 2, 2, 2, slot);
  eq('stackAfterStroke', h.stack.length, 1);

  // One drag: 40 `input` events sweeping red -> green.
  const before = pal.colors[slot] | 0;
  for (let i = 1; i <= 40; i++) pickerInput(pal, h, slot, before, 255 - i * 6, i * 6, 0);
  h.endPalette();

  eq('dragIsOneStep', h.stack.length, 2);
  eq('dragEnd', pal.hex(slot), '#0ff000');
  eq('hasEdits', h.hasEdits, true);

  // Undo returns the colour from before the drag, not the previous `input`.
  eq('undoKind', h.undo(vol, pal), 'palette');
  eq('undoColour', pal.hex(slot), '#ff0000');
  eq('undoLeftVoxels', vol.getFace(2, 2, 2, 0), slot);
  eq('undoLeftOther', pal.hex(other), '#0000ff');
  eq('redoKind', h.redo(vol, pal), 'palette');
  eq('redoColour', pal.hex(slot), '#0ff000');

  // The stroke underneath is still a voxel step and still undoes as one.
  eq('undoPaletteAgain', h.undo(vol, pal), 'palette');
  eq('undoStroke', h.undo(vol, pal), 'voxels');
  eq('strokeUndone', vol.get(2, 2, 2), false);
  eq('nothingLeft', h.undo(vol, pal), null);
  eq('emptyHasEdits', h.hasEdits, false);

  // A second drag on the same slot after the first one closed is its own step,
  // or one Ctrl+Z would swallow two deliberate colour choices.
  h.redo(vol, pal);
  h.redo(vol, pal);
  const b2 = pal.colors[slot] | 0;
  pickerInput(pal, h, slot, b2, 0, 0, 0);
  h.endPalette();
  const b3 = pal.colors[slot] | 0;
  pickerInput(pal, h, slot, b3, 255, 255, 255);
  h.endPalette();
  eq('twoDragsTwoSteps', h.stack.length, 4);
  h.undo(vol, pal);
  eq('secondDragUndone', pal.hex(slot), '#000000');

  // A stroke after a recolour drops the redo tail, as any new step does.
  stroke(h, vol, 4, 4, 4, other);
  eq('redoTailDropped', h.canRedo, false);
  eq('stackAfterTail', h.stack.length, 4);

  // Without a palette to write to, a palette step must not be consumed - the
  // caller would otherwise lose the entry and leave the model recoloured.
  const guard = new History();
  guard.pushPalette(slot, 0x010203, 0x040506);
  guard.endPalette();
  eq('undoNeedsPalette', guard.undo(vol), null);
  eq('cursorKept', guard.cursor, 1);

  return { ok: bad.length === 0, detail: bad.length === 0 ? cases + '/' + cases + ' cases' : bad.join('; ') };
}
