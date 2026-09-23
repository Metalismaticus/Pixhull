// @ts-check
/**
 * Swatches are shown by hue and lightness, and the slot index never moves.
 *
 * The second half is the one that matters most: the byte on every face is a
 * slot index, so a "sort" that renumbered slots would void the meaning of the
 * whole volume and of the undo history (`CLAUDE.md`, "Правила проекта"). This
 * check holds the ordering to being a view and nothing else.
 *
 * Red without the fix: return `[[1, 2, 3, ...]]` from `paletteBands` - the
 * insertion order the palette had before - and the hue, lightness and neutral
 * assertions all report the colours in the wrong places.
 */

import { Palette } from '../../src/core/palette.js';
import { paletteBands, paletteOrder, bandOf } from '../../src/edit/palette-order.js';

export function run() {
  /** @type {string[]} */
  const bad = [];

  const p = new Palette();
  // Added deliberately out of order, the way a quantiser hands them over: by
  // coverage, not by colour.
  const white = p.add(0xf2, 0xf2, 0xf2);
  const red = p.add(0xff, 0x00, 0x00);
  const darkBlue = p.add(0x00, 0x00, 0x60);
  const grey = p.add(0x40, 0x42, 0x41);
  const darkRed = p.add(0x80, 0x00, 0x00);
  const blue = p.add(0x30, 0x60, 0xff);

  const bands = paletteBands(p);
  const order = paletteOrder(p);

  // Every slot is shown exactly once, and none of them changed number.
  const sorted = order.slice().sort((a, b) => a - b);
  if (sorted.join() !== '1,2,3,4,5,6') bad.push('shown slots are ' + sorted.join() + ', want 1..6');
  // The palette itself is untouched: slot n still holds the colour it held.
  if (p.colors[red] !== 0xff0000) bad.push('slot ' + red + ' no longer holds red');
  if (p.colors[darkBlue] !== 0x000060) bad.push('slot ' + darkBlue + ' no longer holds dark blue');

  // Three bands: neutrals, reds, blues - in that order.
  if (bands.length !== 3) bad.push('bands are ' + bands.length + ', want 3');
  if (bands[0] && bands[0].join() !== [grey, white].join()) {
    bad.push('neutral band is ' + (bands[0] ?? []).join() + ', want ' + [grey, white].join());
  }
  if (bands[1] && bands[1].join() !== [darkRed, red].join()) {
    bad.push('red band is ' + (bands[1] ?? []).join() + ', want ' + [darkRed, red].join());
  }
  if (bands[2] && bands[2].join() !== [darkBlue, blue].join()) {
    bad.push('blue band is ' + (bands[2] ?? []).join() + ', want ' + [darkBlue, blue].join());
  }

  // Red sits in the first hue band and blue in a later one, so the circle
  // starts where it is supposed to.
  if (bandOf(0xff0000) !== 1) bad.push('red is in band ' + bandOf(0xff0000) + ', want 1');
  if (bandOf(0xff2010) !== 1) bad.push('a warm red left the red band');
  if (bandOf(0xff0020) !== 1) bad.push('a cool red left the red band');
  if (bandOf(0x808080) !== 0) bad.push('grey is not neutral');
  if (bandOf(0x000000) !== 0) bad.push('black is not neutral');
  if (bandOf(0xffffff) !== 0) bad.push('white is not neutral');
  if (bandOf(0x3060ff) <= 1) bad.push('blue shares a band with red');

  return {
    ok: bad.length === 0,
    detail: bad.length === 0
      ? '6 slots, 3 bands, dark before light, slot numbers unchanged'
      : bad.slice(0, 3).join('; '),
  };
}
