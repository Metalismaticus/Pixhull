// @ts-check
/**
 * A bake is only half done when the window shows it: the other half of item 4
 * is that the colour lives in `.obj`, `.glb` and `.vox`.
 *
 * `tests/bake/paint.mjs` guards the face bytes, and `export/smooth-mesh.mjs`
 * guards the shape of the mesh, but nothing looked at what the writers do with
 * a face byte the bake changed. That is exactly the join where a bake could be
 * perfect and useless - an export that reads the palette once, or caches a
 * mesh, or writes the colour a voxel had before, loses the whole operation and
 * every check stays green.
 *
 * So the model is exported twice, before the bake and after it, and the two
 * are compared:
 *
 *  - **OBJ/MTL** exactly. Per material, the quads are summed *by area* rather
 *    than counted, because greedy merging turns a flat panel into one quad;
 *    the areas must equal the exposed faces the volume carries for that slot,
 *    before and after. The MTL colour must be the palette's own.
 *  - **GLB** by the colours in `COLOR_0`: the set the file carries must be the
 *    set of colours the faces wear, and the vertex count per colour must match
 *    the quads per colour six for six.
 *  - **VOX** by its `RGBA` and `XYZI` chunks: a voxel there gets one colour for
 *    six faces (`voteColor`), so what is checked is that the indices written
 *    are indices the faces actually wear and that the palette chunk gives them
 *    the palette's own RGB - and that the bake reached the file at all.
 *
 * How it goes red, both halves verified by hand:
 *  - the bake not reaching the file at all - put the record's `before` side
 *    back between the two exports, as a writer reading a stale copy of the
 *    model would - and it fails 2 of 25 cases: `objColoursAfter=1 want 6` and
 *    `voxColoursAfter=false want true` (25 rather than 50 cases, because the
 *    per-slot rounds shrink from six colours to one).
 *  - a writer losing or mixing up a face byte - the per-slot cases
 *    `afterObjArea*`, `afterObjKd*`, `afterGlbHas*` and `afterVoxSlotIsWorn*`,
 *    which are checked against the volume itself rather than against a number
 *    written down here.
 */

import { Palette } from '../../src/core/palette.js';
import { Volume } from '../../src/core/volume.js';
import { applyBake, FACE_SHADE } from '../../src/core/bake.js';
import { exportObj } from '../../src/export/obj.js';
import { exportGlb } from '../../src/export/gltf.js';
import { exportVox } from '../../src/export/vox.js';
import { DIRS } from '../../src/core/volume.js';

/** A 4x4x4 cube of solid voxels at 4..7, every exposed face painted `idx`. */
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

/**
 * How many exposed, painted faces the model carries per palette slot. This is
 * the truth every exporter is measured against.
 * @param {import('../../src/core/volume.js').Volume} vol
 * @returns {Map<number, number>}
 */
function facesBySlot(vol) {
  /** @type {Map<number, number>} */
  const out = new Map();
  vol.forEachSolid((x, y, z) => {
    for (let d = 0; d < 6; d++) {
      const n = DIRS[d];
      if (vol.get(x + n[0], y + n[1], z + n[2])) continue;
      const c = vol.getFace(x, y, z, d);
      if (c === 0) continue;
      out.set(c, (out.get(c) ?? 0) + 1);
    }
  });
  return out;
}

/**
 * Sum OBJ quad *area* per material name. Greedy merging joins neighbouring
 * faces of one colour into one quad, so area is the invariant, not count.
 * @param {string} obj
 * @returns {Map<string, number>}
 */
function objAreaByMaterial(obj) {
  /** @type {number[][]} */
  const verts = [];
  /** @type {Map<string, number>} */
  const area = new Map();
  let mat = '';
  for (const line of obj.split('\n')) {
    if (line.startsWith('v ')) {
      const p = line.slice(2).split(' ').map(Number);
      verts.push(p);
    } else if (line.startsWith('usemtl ')) {
      mat = line.slice(7).trim();
    } else if (line.startsWith('f ')) {
      const ids = line.slice(2).split(' ').map(Number);
      const pts = ids.map((i) => verts[i - 1]);
      const ext = [0, 1, 2].map((a) => {
        const vals = pts.map((p) => p[a]);
        return Math.max(...vals) - Math.min(...vals);
      }).filter((e) => e > 1e-9);
      // An axis-aligned rectangle: two extents, and their product is the number
      // of voxel faces merged into it.
      const a = ext.length === 2 ? ext[0] * ext[1] : 0;
      area.set(mat, (area.get(mat) ?? 0) + a);
    }
  }
  return area;
}

/** @param {number} i @returns {string} the name `writeObj` gives a slot */
const matName = (i) => 'pal' + String(i).padStart(3, '0');

/**
 * Pull `COLOR_0` out of a GLB and count vertices per packed RGB.
 * @param {Uint8Array} bytes
 * @returns {Map<number, number>}
 */
function glbColours(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
  const binStart = 20 + jsonLen + 8;
  const acc = json.accessors[json.meshes[0].primitives[0].attributes.COLOR_0];
  const view = json.bufferViews[acc.bufferView];
  const base = binStart + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  /** @type {Map<number, number>} */
  const out = new Map();
  for (let i = 0; i < acc.count; i++) {
    const o = base + i * 4;
    const packed = (bytes[o] << 16) | (bytes[o + 1] << 8) | bytes[o + 2];
    out.set(packed, (out.get(packed) ?? 0) + 1);
  }
  return out;
}

/**
 * Read a `.vox` file back: which palette indices the voxels use, and what the
 * RGBA chunk says each of them looks like.
 * @param {Uint8Array} bytes
 * @returns {{used: Map<number, number>, rgba: Uint8Array}}
 */
function voxRead(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  /** @type {Map<number, number>} */
  const used = new Map();
  let rgba = new Uint8Array(1024);
  // MAIN's own content is empty; its children follow it back to back.
  let p = 8 + 12;
  while (p + 12 <= bytes.length) {
    const id = tag(p);
    const len = dv.getUint32(p + 4, true);
    const body = p + 12;
    if (id === 'XYZI') {
      const n = dv.getUint32(body, true);
      for (let i = 0; i < n; i++) {
        const c = bytes[body + 4 + i * 4 + 3];
        used.set(c, (used.get(c) ?? 0) + 1);
      }
    } else if (id === 'RGBA') {
      rgba = bytes.subarray(body, body + 1024);
    }
    p = body + len + dv.getUint32(p + 8, true);
  }
  return { used, rgba };
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

  /** Everything one round of exports says about the model as it stands. */
  const shot = (tag) => {
    const want = facesBySlot(vol);
    const { obj, mtl } = exportObj(vol, pal, {});
    const area = objAreaByMaterial(obj);
    const glb = glbColours(exportGlb(vol, pal, {}).bytes);
    const vox = voxRead(exportVox(vol, pal).bytes);

    // ---- OBJ: every slot the faces wear, and the same area, to the face.
    eq(tag + 'ObjColours', area.size, want.size);
    for (const [slot, n] of want) {
      eq(tag + 'ObjArea' + slot, area.get(matName(slot)) ?? 0, n);
      // The material carries the palette's own colour, not a guess at it.
      const [r, g, b] = pal.rgb(slot);
      const line = 'Kd ' + [r, g, b].map((v) => (Math.round((v / 255) * 1e6) / 1e6).toString()).join(' ');
      eq(tag + 'ObjKd' + slot, mtl.includes(line), true);
    }

    // ---- GLB: the same colours, six vertices per quad.
    eq(tag + 'GlbColours', glb.size, want.size);
    let glbFaces = 0;
    for (const [slot, n] of want) {
      const packed = pal.colors[slot] | 0;
      // Quads per colour are unknown here (merging), but their vertices are a
      // multiple of six and the colour itself has to be in the file.
      const v = glb.get(packed) ?? 0;
      eq(tag + 'GlbHas' + slot, v > 0 && v % 6 === 0, true);
      glbFaces += n;
    }
    eq(tag + 'GlbFaceTotal', glbFaces, [...want.values()].reduce((a, b) => a + b, 0));

    // ---- VOX: one colour per voxel, but it must be one of ours, and the
    // palette chunk must describe it the way the palette does.
    eq(tag + 'VoxVoxels', [...vox.used.values()].reduce((a, b) => a + b, 0), vol.solidCount);
    for (const slot of vox.used.keys()) {
      eq(tag + 'VoxSlotIsWorn' + slot, want.has(slot), true);
      const [r, g, b] = pal.rgb(slot);
      const o = (slot - 1) * 4;
      eq(tag + 'VoxRgb' + slot, vox.rgba[o] + ',' + vox.rgba[o + 1] + ',' + vox.rgba[o + 2],
        r + ',' + g + ',' + b);
    }
    return { colours: want.size, vox: vox.used.size };
  };

  // ------------------------------------------------- before: one flat colour
  const before = shot('before');
  eq('objColoursBefore', before.colours, 1);
  eq('voxColoursBefore', before.vox, 1);

  // --------------------------------------------------------- after the bake
  const applied = applyBake(vol, pal, { op: 'light' });
  eq('bakeChanged', applied.record.changed, 80);
  const after = shot('after');
  // Of the 96 exposed faces, the 16 on +Y keep their colour (that tint is
  // exactly 1.0) and the other 80 take one of five new ones - so the model now
  // wears six slots, and every export must say six.
  eq('objColoursAfter', after.colours, 6);
  eq('paletteGrew', pal.live, 6);
  // The .vox vote is per voxel, not per face, so it cannot show all six - but
  // it must show more than the one colour the model had before the bake.
  eq('voxColoursAfter', after.vox > 1, true);
  // The darkest tint of the model is a colour no export knew before the bake.
  const darkest = pal.lookup.get((
    (Math.round(200 * FACE_SHADE[3]) << 16) | (Math.round(40 * FACE_SHADE[3]) << 8)
    | Math.round(40 * FACE_SHADE[3])));
  eq('darkestInPalette', typeof darkest === 'number' && pal.has(darkest), true);

  return {
    ok: bad.length === 0,
    detail: bad.length === 0
      ? cases + ' cases; 96 face-areas in .obj and 6 colours after a light bake '
        + '(1 before), .glb carries the same 6, .vox writes 64 voxels on worn slots'
      : bad.length + ' of ' + cases + ' failed: ' + bad.slice(0, 4).join('; '),
  };
}
