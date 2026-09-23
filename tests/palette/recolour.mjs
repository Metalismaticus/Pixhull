// @ts-check
/**
 * Recolouring a slot keeps the slot.
 *
 * The whole operation rests on one promise: `Palette.replace` changes what an
 * index *means* and never which index a face points at. If it renumbered, every
 * face byte in the volume - and every byte sitting in the undo history - would
 * start naming a different colour, which is the one failure in this product
 * that cannot be seen on screen until the model is already wrong.
 *
 * Also pinned here: the lookup table, which has cases that are easy to get
 * wrong (the old key, a duplicate colour elsewhere), and the Lab cache, which
 * is keyed by palette *length* and therefore cannot notice a change in place
 * on its own.
 *
 * Red without the fix: `replace()` does not exist - every case below throws.
 * Red without the cache reset: drop `this._labs = null` from `replace()` and
 * `labsFresh` answers with the colour that is gone (measured: nearest to pure
 * green came back as slot 2, the blue, instead of slot 1).
 */

import { Palette } from '../../src/core/palette.js';
import { Volume } from '../../src/core/volume.js';

export function run() {
  /** @type {string[]} */
  const bad = [];
  let cases = 0;
  /** @param {string} name @param {*} got @param {*} want */
  const eq = (name, got, want) => {
    cases++;
    if (got !== want) bad.push(name + '=' + got + ' want ' + want);
  };

  const p = new Palette();
  const red = p.add(220, 40, 40);
  const green = p.add(40, 180, 70);
  eq('intern', p.add(220, 40, 40), red); // one slot per colour

  // A volume painted with those indices must read back identically afterwards.
  const vol = new Volume(8, 8, 8);
  vol.set(1, 1, 1, true);
  for (let d = 0; d < 6; d++) vol.setFace(1, 1, 1, d, d < 3 ? red : green);

  eq('replaced', p.replace(red, 10, 20, 250), true);
  eq('size', p.size, 3);
  eq('slotKept', p.hex(red), '#0a14fa');
  eq('otherSlotKept', p.hex(green), '#28b446');
  let sameBytes = true;
  for (let d = 0; d < 6; d++) if (vol.getFace(1, 1, 1, d) !== (d < 3 ? red : green)) sameBytes = false;
  eq('faceBytes', sameBytes, true);

  // The old colour is no longer interned, the new one is, and it answers with
  // the index the model already holds.
  eq('oldKeyGone', p.lookup.has(0xdc2828), false);
  eq('newKeyHere', p.lookup.get(0x0a14fa), red);
  eq('addNew', p.add(10, 20, 250), red);
  eq('addOld', p.add(220, 40, 40), 3); // the old colour is a fresh slot now
  eq('grew', p.size, 4);

  // A no-op replace reports nothing changed; an index outside 1..size-1 is
  // refused rather than growing the palette or writing the reserved slot 0.
  eq('noop', p.replace(red, 10, 20, 250), false);
  eq('outOfRange', p.replace(99, 1, 2, 3), false);
  eq('reservedSlot', p.replace(0, 1, 2, 3), false);
  eq('sizeAfterRefusals', p.size, 4);
  eq('slot0Intact', p.colors[0], 0x000000);

  // Duplicates. A quantised or loaded palette can hold one colour twice; the
  // slot that still holds it must go on answering for it.
  const dup = Palette.deserialize({ colors: [0x000000, 0x090909, 0x090909] });
  const owner = dup.lookup.get(0x090909);
  dup.replace(1, 200, 0, 0);
  eq('dupStillFound', dup.lookup.get(0x090909), owner === 1 ? undefined : owner);
  eq('dupSlot1', dup.hex(1), '#c80000');
  eq('dupSlot2', dup.hex(2), '#090909');

  // The Lab cache is keyed by length, which did not change: without an explicit
  // reset `nearest()` keeps answering from the colour that is gone.
  const cache = new Palette();
  const s1 = cache.add(255, 0, 0);
  const s2 = cache.add(0, 0, 255);
  cache.nearest(250, 5, 5); // builds the cache
  cache.replace(s1, 0, 255, 0);
  eq('labsFresh', cache.nearest(5, 250, 5), s1);
  eq('labsOther', cache.nearest(5, 5, 250), s2);

  // A project saved after a recolour reloads with the new colour in the same
  // slot - the only reason a stored face byte still means anything.
  const round = Palette.deserialize(cache.serialize());
  eq('roundTrip', round.hex(s1), '#00ff00');
  eq('roundTripLookup', round.lookup.get(0x00ff00), s1);
  eq('roundTripTexture', round.toTextureData()[s1 * 4 + 1], 255);

  return { ok: bad.length === 0, detail: bad.length === 0 ? cases + '/' + cases + ' cases' : bad.join('; ') };
}
