// @ts-check
/**
 * Baking: colour written into the model, not into the window.
 *
 * Two operations live here, and they differ from everything else in `src/gfx`
 * by one thing only - they change the *face bytes*. Shading in the viewport is
 * a multiply in the shader: turn the checkbox off and the model is flat again,
 * and an `.obj` written from it never knew about it. Baked light is the same
 * tint resolved to palette slots and stored, so `.obj`, `.glb` and `.vox` carry
 * it, because they carry face bytes.
 *
 * The rule the whole project stands on applies here in full: a face byte is an
 * index, and indices are never renumbered (`docs/DECISIONS.md`). Both
 * operations only ever *write a different index* into a face, and only ever
 * reach new colours through `Palette.add`, which fills a hole a merge freed
 * before growing and answers with the nearest existing colour once the palette
 * is full. Nothing here touches the meaning of a slot that other faces use.
 *
 * Planning is separate from applying on purpose. A palette holds 255 colours,
 * and an operation that overflows it is useless; the roadmap asks for the count
 * *before* the press, so `planBake` answers "this would need N colours you do
 * not have yet, and M slots are free" without changing a byte.
 */

import { DIRS } from './volume.js';
import { PALETTE_MAX } from './palette.js';

/**
 * Per-direction tint, in the order of `DIRS` (+X, -X, +Y, -Y, +Z, -Z).
 *
 * These are the very numbers the viewport shades with - `SHADE[6]` in the
 * vertex shader of `src/gfx/renderer.js`. They are copied rather than imported
 * because the shader is a GLSL string inside a module that needs a WebGL2
 * context, and `src/core` may not depend on the DOM (`CLAUDE.md`, "Правила
 * проекта"). `tests/bake/shade-parity.mjs` reads the shader source and fails
 * when the two drift apart, so the copy cannot rot quietly.
 */
export const FACE_SHADE = [0.88, 0.74, 1.0, 0.58, 0.95, 0.68];

/**
 * How dark an outline goes, as a multiplier on the face's own colour.
 *
 * Chosen here, not by the owner: it sits just below the darkest side the
 * viewport shades with (0.58), so an outline stays visible against a face that
 * is already in shadow. One number rather than a slider, because the roadmap
 * asks for thickness to be adjustable and says nothing about depth.
 */
export const OUTLINE_DARKEN = 0.55;

/** Thickest outline the product offers, in voxels. Chosen here, not by the owner. */
export const OUTLINE_MAX_THICKNESS = 3;

/**
 * @typedef {Object} BakeOptions
 * @property {'outline'|'light'} op which operation
 * @property {number} [thickness] outline thickness in voxels, 1..OUTLINE_MAX_THICKNESS
 * @property {number} [darken] outline multiplier, `OUTLINE_DARKEN` by default
 * @property {number} [index] paint the outline with this existing slot instead
 *   of darkening each face's own colour (the roadmap allows either)
 */

/**
 * What one bake changed, as the smallest thing that can put it back.
 *
 * Positions rather than chunk offsets: a record has to survive being replayed
 * through the volume's own `setFace`, which marks the right chunk dirty. Seven
 * bytes per changed face and nothing per face left alone.
 * @typedef {{pos: Int32Array, dir: Uint8Array, before: Uint8Array,
 *   after: Uint8Array, changed: number}} BakeRecord
 */

/** The four directions that lie in the plane of face `d`. */
const IN_PLANE = DIRS.map((_, d) => [0, 1, 2, 3, 4, 5].filter((e) => (e >> 1) !== (d >> 1)));

/** Thrown to leave `forEachSolid` early; `forEachSolid` has no other exit. */
const STOP = Symbol('bake-stop');

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** @param {number} packed @param {number} f @returns {number} packed, scaled */
function scaleColour(packed, f) {
  const r = clamp(Math.round(((packed >> 16) & 255) * f), 0, 255);
  const g = clamp(Math.round(((packed >> 8) & 255) * f), 0, 255);
  const b = clamp(Math.round((packed & 255) * f), 0, 255);
  return (r << 16) | (g << 8) | b;
}

/**
 * Does the voxel at (x,y,z) show a face in direction `d` at all?
 * @param {import('./volume.js').Volume} vol
 */
function exposed(vol, x, y, z, d) {
  if (!vol.get(x, y, z)) return false;
  return !vol.get(x + DIRS[d][0], y + DIRS[d][1], z + DIRS[d][2]);
}

/**
 * Is this face on the silhouette seen along `d`, within `thickness` voxels?
 *
 * Looking straight at direction `d`, the faces pointing that way form a sheet,
 * and the outline is where that sheet ends: the in-plane neighbour either is
 * not there at all, or is there but shows no face this way because something
 * stands in front of it. Both are edges the eye reads as an edge, which is why
 * pixel art outlines occlusion boundaries as well as the outer rim.
 *
 * Distance is measured in the plane (Manhattan), not along the sheet, so a
 * thick outline stays a local test - no set of a million faces to walk.
 *
 * @param {import('./volume.js').Volume} vol
 * @param {number} thickness 1 means "the boundary face itself"
 */
function onOutline(vol, x, y, z, d, thickness) {
  const perp = IN_PLANE[d];
  const [au, av] = [perp[0], perp[2]];
  const U = DIRS[au];
  const V = DIRS[av];
  const reach = thickness - 1;
  for (let du = -reach; du <= reach; du++) {
    const rest = reach - Math.abs(du);
    for (let dv = -rest; dv <= rest; dv++) {
      const sx = x + U[0] * du + V[0] * dv;
      const sy = y + U[1] * du + V[1] * dv;
      const sz = z + U[2] * du + V[2] * dv;
      if (!exposed(vol, sx, sy, sz, d)) continue;
      for (const e of perp) {
        if (!exposed(vol, sx + DIRS[e][0], sy + DIRS[e][1], sz + DIRS[e][2], d)) return true;
      }
    }
  }
  return false;
}

/**
 * Walk every exposed, painted face the operation would touch and hand the
 * caller the colour it wants there.
 *
 * One walk shared by the plan and the application, so the number the panel
 * promises and the bytes the click writes can never come from two different
 * rules.
 *
 * @param {import('./volume.js').Volume} vol
 * @param {import('./palette.js').Palette} palette
 * @param {BakeOptions} opts
 * @param {(x: number, y: number, z: number, d: number, idx: number, want: number) => void} visit
 * @param {number} [deadline] `performance.now()` value to stop the walk at
 */
function walkBake(vol, palette, opts, visit, deadline = Infinity) {
  const thickness = clamp(Math.round(opts.thickness ?? 1), 1, OUTLINE_MAX_THICKNESS);
  const darken = opts.darken ?? OUTLINE_DARKEN;
  const fixed = opts.op === 'outline' && palette.has(opts.index ?? 0)
    ? (palette.colors[/** @type {number} */ (opts.index)] | 0) : -1;

  // The clock is read on the walk itself, not on the faces the walk decides to
  // change. Counting the changes instead let an outline run far past its
  // budget: the search reads a whole neighbourhood per face and changes only a
  // silhouette, so on the 256 lorry a 150 ms budget cost 369 / 551 / 616 ms at
  // thickness 1 / 2 / 3 (reviewer's measurement, item 4). Every 256 voxels
  // rather than every one: at 256 the check costs under 1% of the walk and
  // still overshoots by well under a frame.
  let ticks = 0;
  vol.forEachSolid((x, y, z) => {
    if (deadline < Infinity && (++ticks & 255) === 0 && performance.now() > deadline) throw STOP;
    for (let d = 0; d < 6; d++) {
      if (vol.get(x + DIRS[d][0], y + DIRS[d][1], z + DIRS[d][2])) continue;
      const idx = vol.getFace(x, y, z, d);
      // Slot 0 means "no colour was ever assigned here". Baking a tint onto it
      // would invent a colour for a face the carve deliberately left blank.
      if (idx === 0) continue;
      const packed = palette.colors[idx] | 0;
      let want;
      if (opts.op === 'light') {
        want = scaleColour(packed, FACE_SHADE[d]);
      } else {
        if (!onOutline(vol, x, y, z, d, thickness)) continue;
        want = fixed >= 0 ? fixed : scaleColour(packed, darken);
      }
      if (want === packed) continue;
      visit(x, y, z, d, idx, want);
    }
  });
}

/**
 * @typedef {Object} BakePlan
 * @property {'outline'|'light'} op
 * @property {number} faces how many faces would get a different colour
 * @property {number} colours how many distinct colours the result asks for
 * @property {number} newColours how many of those the palette does not hold
 * @property {number} spare slots available right now (holes plus room to grow)
 * @property {boolean} overflow the palette cannot hold them all, so some faces
 *   will land on the nearest existing colour instead
 * @property {boolean} complete the walk finished inside its budget
 */

/**
 * Count what a bake would cost, changing nothing.
 *
 * The count is the point of the operation being usable at all: the palette caps
 * at 255, so "this needs 180 colours and you have 12" has to be readable before
 * the press, not discovered afterwards (`docs/ROADMAP.md`, item 4).
 *
 * A big model can outrun any budget. Like `Volume.countExposedFaces`, the walk
 * stops on a deadline and says so rather than reporting a number it did not
 * finish - the apply path has no budget and always walks the whole model.
 *
 * @param {import('./volume.js').Volume} vol
 * @param {import('./palette.js').Palette} palette
 * @param {BakeOptions} opts
 * @param {number} [deadline] value of `performance.now()` to stop at
 * @returns {BakePlan}
 */
export function planBake(vol, palette, opts, deadline = Infinity) {
  /** @type {Set<number>} */
  const wanted = new Set();
  let faces = 0;
  let complete = true;

  try {
    walkBake(vol, palette, opts, (x, y, z, d, idx, want) => {
      faces++;
      wanted.add(want);
    }, deadline);
  } catch (e) {
    if (e !== STOP) throw e;
    complete = false;
  }

  let newColours = 0;
  for (const packed of wanted) {
    const hit = palette.lookup.get(packed);
    if (hit === undefined || !palette.has(hit)) newColours++;
  }
  const spare = palette.free.size + Math.max(0, PALETTE_MAX - palette.colors.length);
  return {
    op: opts.op,
    faces,
    colours: wanted.size,
    newColours,
    spare,
    overflow: newColours > spare,
    complete,
  };
}

/**
 * Carry out a bake: resolve every wanted colour to a slot and write the bytes.
 *
 * Colours go through `Palette.add`, which is the only way new colour may enter
 * the model: it reuses a slot a merge freed, grows the palette while there is
 * room, and answers with the nearest existing colour once there is none. That
 * last case is the honest degradation `planBake` warns about beforehand - the
 * operation still lands on the palette instead of inventing an index.
 *
 * @param {import('./volume.js').Volume} vol
 * @param {import('./palette.js').Palette} palette
 * @param {BakeOptions} opts
 * @returns {{record: BakeRecord, colours: number, added: number}}
 */
export function applyBake(vol, palette, opts) {
  /** @type {number[]} */
  const pos = [];
  /** @type {number[]} */
  const dir = [];
  /** @type {number[]} */
  const before = [];
  /** @type {number[]} */
  const after = [];
  /** @type {Map<number, number>} packed colour -> slot, so one search per colour */
  const memo = new Map();
  const liveBefore = palette.live;

  walkBake(vol, palette, opts, (x, y, z, d, idx, want) => {
    let slot = memo.get(want);
    if (slot === undefined) {
      slot = palette.add((want >> 16) & 255, (want >> 8) & 255, want & 255);
      memo.set(want, slot);
    }
    // A full palette can answer with the slot the face already wears; that is
    // not a change and must not cost an undo entry.
    if (slot === idx || slot === 0) return;
    pos.push(x + vol.nx * (y + vol.ny * z));
    dir.push(d);
    before.push(idx);
    after.push(slot);
    vol.setFace(x, y, z, d, slot);
  });

  return {
    record: {
      pos: Int32Array.from(pos),
      dir: Uint8Array.from(dir),
      before: Uint8Array.from(before),
      after: Uint8Array.from(after),
      changed: pos.length,
    },
    colours: memo.size,
    added: palette.live - liveBefore,
  };
}

/**
 * Write one side of a bake record back into the model.
 * @param {import('./volume.js').Volume} vol
 * @param {BakeRecord} record
 * @param {'before'|'after'} side
 * @returns {number} how many face bytes were written
 */
export function writeBake(vol, record, side) {
  const bytes = record[side];
  const plane = vol.nx * vol.ny;
  for (let k = 0; k < record.pos.length; k++) {
    const p = record.pos[k];
    const z = (p / plane) | 0;
    const rest = p - z * plane;
    const y = (rest / vol.nx) | 0;
    vol.setFace(rest - y * vol.nx, y, z, record.dir[k], bytes[k]);
  }
  return record.pos.length;
}
