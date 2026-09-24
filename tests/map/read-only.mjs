// @ts-check
/**
 * The map is a second description of the model, never an edit of it.
 *
 * `docs/ROADMAP.md`, "Готово, когда": включение режима не меняет ни одного
 * вокселя и ни одной грани. Two things have to hold for that:
 *
 * 1. asking for the map during the carve leaves volume and face bytes
 *    byte-for-byte what they were without it;
 * 2. the instances the map draws cover exactly the same faces as the model's
 *    own, in the same order and the same places - only the colour byte differs,
 *    and it holds a band, never a palette slot.
 *
 * Red without the fix: `mapInstances` reading `getFace` instead of the band, or
 * walking a different set of faces, breaks (2); a map built after the slope
 * repaint instead of after the paint pass breaks (1) the moment the repaint
 * writes anything.
 */

import { carve } from '../../src/core/carve.js';
import { Palette } from '../../src/core/palette.js';
import { mapInstances, BANDS } from '../../src/core/disagree.js';
import { makeFlat, makeWedge, viewsFromImages, VIEW_COLOUR } from '../fixtures.mjs';

const N = 24;

function art() {
  return {
    front: makeWedge(N, N, VIEW_COLOUR.front),
    back: makeWedge(N, N, VIEW_COLOUR.back),
    right: makeFlat(N, N, VIEW_COLOUR.right),
    left: makeFlat(N, N, VIEW_COLOUR.left),
    top: makeFlat(N, N, VIEW_COLOUR.top),
    bottom: makeFlat(N, N, VIEW_COLOUR.bottom),
  };
}

function carveWith(map) {
  const palette = new Palette();
  return carve(viewsFromImages(art()), N, palette, { map });
}

export function run() {
  const notes = [];
  let ok = true;
  const fail = (why) => { ok = false; notes.push(why); };

  const plain = carveWith(false);
  const withMap = carveWith(true);

  if (plain.map !== null) fail('a carve that was not asked for a map returned one');
  if (!withMap.map) return { ok: false, detail: 'no map was built' };

  if (plain.volume.solidCount !== withMap.volume.solidCount) {
    fail(`voxels ${plain.volume.solidCount} against ${withMap.volume.solidCount}`);
  }
  let faceDiff = 0;
  let faces = 0;
  plain.volume.forEachSolid((x, y, z) => {
    for (let d = 0; d < 6; d++) {
      faces++;
      if (plain.volume.getFace(x, y, z, d) !== withMap.volume.getFace(x, y, z, d)) faceDiff++;
    }
  });
  if (faceDiff !== 0) fail(`${faceDiff} of ${faces} face bytes differ with the map on`);

  // The two instance buffers, side by side.
  const own = plain.volume.buildFaceInstances();
  const shown = mapInstances(withMap.volume, withMap.map);
  if (own.count !== shown.count) {
    fail(`${shown.count} map instances against ${own.count} model instances`);
  }
  const a = new Int16Array(own.buffer);
  const b = new Int16Array(shown.buffer);
  const ua = new Uint8Array(own.buffer);
  const ub = new Uint8Array(shown.buffer);
  let moved = 0;
  let offBand = 0;
  let recoloured = 0;
  for (let i = 0; i < Math.min(own.count, shown.count); i++) {
    for (let k = 0; k < 3; k++) if (a[i * 4 + k] !== b[i * 4 + k]) moved++;
    if (ua[i * 8 + 6] !== ub[i * 8 + 6]) moved++;
    const slot = ub[i * 8 + 7];
    if (slot < 1 || slot > BANDS.length) offBand++;
    if (slot !== ua[i * 8 + 7]) recoloured++;
  }
  if (moved !== 0) fail(`${moved} map instances sit somewhere else than the model's`);
  if (offBand !== 0) fail(`${offBand} map instances carry something that is not a band`);
  // A map that came out identical to the model would be a copy, not a map.
  if (recoloured === 0) fail('every map instance carries the colour the model had');

  notes.push(`${own.count} faces, ${faceDiff} bytes changed, ${moved} moved`);
  notes.push(`bands ${[...withMap.map.counts].join('/')} of ${withMap.map.total}`);
  return { ok, detail: notes.join('; ') };
}
