// @ts-check
/**
 * OBJ + MTL export with greedy face merging.
 *
 * Naively, every exposed voxel face is a quad, and a modest model lands in the
 * hundreds of thousands of polys. Greedy merging walks each slice plane and
 * grows the largest rectangle of identically-coloured, identically-facing
 * quads, which typically cuts that by 5-20x on pixel art (large flat panels
 * merge into one quad).
 *
 * Colours become one material per palette entry rather than a texture atlas.
 * For indexed art that is lossless, it survives every importer, and there is no
 * texel bleeding to worry about.
 */

import { DIRS } from '../core/volume.js';

/**
 * axis: normal axis index; t1/t2: the two in-plane axis indices, ordered so
 * that t1 x t2 points along the outward normal; lift: whether the face plane
 * sits at slice+1 (positive dirs) or slice (negative dirs).
 */
const PLANES = [
  { axis: 0, t1: 1, t2: 2, lift: 1 }, // +X
  { axis: 0, t1: 2, t2: 1, lift: 0 }, // -X
  { axis: 1, t1: 2, t2: 0, lift: 1 }, // +Y
  { axis: 1, t1: 0, t2: 2, lift: 0 }, // -Y
  { axis: 2, t1: 0, t2: 1, lift: 1 }, // +Z
  { axis: 2, t1: 1, t2: 0, lift: 0 }, // -Z
];

/**
 * @param {import('../core/volume.js').Volume} volume
 * @param {import('../core/palette.js').Palette} palette
 * @param {{name?: string, center?: boolean, scale?: number}} [opts]
 * @returns {{obj: string, mtl: string, stats: {quads: number, rawQuads: number, vertices: number}}}
 */
export function exportObj(volume, palette, opts = {}) {
  const name = opts.name ?? 'pixhull';
  const scale = opts.scale ?? 1;
  const dims = [volume.nx, volume.ny, volume.nz];

  const origin = [0, 0, 0];
  if (opts.center !== false) {
    const b = volume.bounds();
    if (b) {
      origin[0] = (b.min[0] + b.max[0] + 1) / 2;
      origin[1] = b.min[1];
      origin[2] = (b.min[2] + b.max[2] + 1) / 2;
    }
  }

  /** @type {number[]} flat xyz */
  const verts = [];
  /** @type {Map<string, number>} */
  const vertIndex = new Map();
  /** @type {Map<number, number[][]>} palette index -> list of vertex-index quads */
  const byMaterial = new Map();
  let rawQuads = 0;
  let quads = 0;

  /** @param {number[]} p @returns {number} 1-based OBJ vertex index */
  const vertexId = (p) => {
    const key = p[0] + ',' + p[1] + ',' + p[2];
    let id = vertIndex.get(key);
    if (id === undefined) {
      verts.push((p[0] - origin[0]) * scale, (p[1] - origin[1]) * scale, (p[2] - origin[2]) * scale);
      id = verts.length / 3;
      vertIndex.set(key, id);
    }
    return id;
  };

  for (let d = 0; d < 6; d++) {
    const { axis, t1, t2, lift } = PLANES[d];
    const dimS = dims[axis];
    const dimU = dims[t1];
    const dimV = dims[t2];
    const mask = new Uint8Array(dimU * dimV);
    const coord = [0, 0, 0];

    for (let s = 0; s < dimS; s++) {
      mask.fill(0);
      let any = false;
      for (let v = 0; v < dimV; v++) {
        for (let u = 0; u < dimU; u++) {
          coord[axis] = s;
          coord[t1] = u;
          coord[t2] = v;
          if (!volume.get(coord[0], coord[1], coord[2])) continue;
          const n = DIRS[d];
          if (volume.get(coord[0] + n[0], coord[1] + n[1], coord[2] + n[2])) continue;
          const c = volume.getFace(coord[0], coord[1], coord[2], d);
          if (c === 0) continue;
          mask[v * dimU + u] = c;
          rawQuads++;
          any = true;
        }
      }
      if (!any) continue;

      for (let v = 0; v < dimV; v++) {
        for (let u = 0; u < dimU; u++) {
          const c = mask[v * dimU + u];
          if (c === 0) continue;

          let w = 1;
          while (u + w < dimU && mask[v * dimU + u + w] === c) w++;

          let h = 1;
          grow: while (v + h < dimV) {
            for (let k = 0; k < w; k++) {
              if (mask[(v + h) * dimU + u + k] !== c) break grow;
            }
            h++;
          }

          for (let dv = 0; dv < h; dv++) mask.fill(0, (v + dv) * dimU + u, (v + dv) * dimU + u + w);

          const corner = (du, dv) => {
            const p = [0, 0, 0];
            p[axis] = s + lift;
            p[t1] = u + du;
            p[t2] = v + dv;
            return p;
          };
          const quad = [
            vertexId(corner(0, 0)),
            vertexId(corner(w, 0)),
            vertexId(corner(w, h)),
            vertexId(corner(0, h)),
          ];
          let list = byMaterial.get(c);
          if (!list) byMaterial.set(c, (list = []));
          list.push(quad);
          quads++;
        }
      }
    }
  }

  const obj = [];
  obj.push('# ' + name + ' - exported by Pixhull');
  obj.push('# 1 unit = 1 voxel');
  obj.push('mtllib ' + name + '.mtl');
  obj.push('o ' + name);
  for (let i = 0; i < verts.length; i += 3) {
    obj.push('v ' + verts[i] + ' ' + verts[i + 1] + ' ' + verts[i + 2]);
  }
  for (const [c, list] of [...byMaterial].sort((a, b) => a[0] - b[0])) {
    obj.push('usemtl ' + materialName(c));
    for (const q of list) obj.push('f ' + q[0] + ' ' + q[1] + ' ' + q[2] + ' ' + q[3]);
  }

  const mtl = ['# ' + name + ' materials - one per palette entry'];
  for (const c of [...byMaterial.keys()].sort((a, b) => a - b)) {
    const [r, g, b] = palette.rgb(c);
    mtl.push('');
    mtl.push('newmtl ' + materialName(c));
    mtl.push('Kd ' + f(r / 255) + ' ' + f(g / 255) + ' ' + f(b / 255));
    mtl.push('Ka 0 0 0');
    mtl.push('Ks 0 0 0');
    mtl.push('Ns 0');
    mtl.push('d 1');
    mtl.push('illum 1');
  }

  return {
    obj: obj.join('\n') + '\n',
    mtl: mtl.join('\n') + '\n',
    stats: { quads, rawQuads, vertices: verts.length / 3 },
  };
}

/** @param {number} i */
function materialName(i) {
  return 'pal' + String(i).padStart(3, '0');
}

/** @param {number} n */
function f(n) {
  return (Math.round(n * 1e6) / 1e6).toString();
}
