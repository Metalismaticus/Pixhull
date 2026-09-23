// @ts-check
/**
 * glTF 2.0 export, as a single self-contained `.glb`.
 *
 * OBJ works everywhere but arrives as 255 separate materials, which is a mess
 * to tidy up in an engine. glTF carries colour as a vertex attribute instead,
 * so the whole model is one material and one draw call, and Godot, Unity and
 * Unreal all import it without a plugin. For a tool meant to feed games, this
 * is the format that actually lands.
 *
 * Vertices are not shared between quads. That is deliberate: a voxel corner
 * belongs to faces of different colours, and averaging them would smear the
 * palette across the edges the art depends on. Flat colour per face means
 * duplicating corners, which for models this size costs nothing.
 *
 * `KHR_materials_unlit` is declared as used but not required. A viewer that
 * knows it shows the palette exactly; one that does not falls back to an
 * unshiny PBR material and still looks right.
 */

import { buildBlockyMesh, placeVertices } from './obj.js';
import { buildSmoothMesh } from './surfacenets.js';

const MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;
const ARRAY_BUFFER = 34962;

/**
 * @param {import('../core/volume.js').Volume} volume
 * @param {import('../core/palette.js').Palette} palette
 * @param {{name?: string, smooth?: boolean, relax?: number, scale?: number, center?: boolean}} [opts]
 * @returns {{bytes: Uint8Array, stats: {triangles: number, vertices: number, smooth: boolean}}}
 */
export function exportGlb(volume, palette, opts = {}) {
  const name = opts.name ?? 'pixhull';
  const smooth = !!opts.smooth;
  const mesh = smooth
    ? buildSmoothMesh(volume, { relax: opts.relax })
    : buildBlockyMesh(volume);
  if (mesh.quads === 0) throw new Error('Nothing to export: the model is empty.');

  const verts = placeVertices(mesh.verts, volume, opts.center !== false, opts.scale ?? 1);

  const vertexCount = mesh.quads * 6;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Uint8Array(vertexCount * 4);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let v = 0;

  for (const [color, quads] of mesh.byMaterial) {
    const [r, g, b] = palette.rgb(color);
    for (const quad of quads) {
      const i0 = (quad[0] - 1) * 3, i1 = (quad[1] - 1) * 3;
      const i2 = (quad[2] - 1) * 3, i3 = (quad[3] - 1) * 3;

      // One normal for the whole quad, from its diagonals.
      const ax = verts[i2] - verts[i0], ay = verts[i2 + 1] - verts[i0 + 1], az = verts[i2 + 2] - verts[i0 + 2];
      const bx = verts[i3] - verts[i1], by = verts[i3 + 1] - verts[i1 + 1], bz = verts[i3 + 2] - verts[i1 + 2];
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;

      // glTF wants triangles and counter-clockwise front faces, which is the
      // winding the quads already have.
      for (const i of [i0, i1, i2, i0, i2, i3]) {
        const o = v * 3;
        positions[o] = verts[i];
        positions[o + 1] = verts[i + 1];
        positions[o + 2] = verts[i + 2];
        normals[o] = nx;
        normals[o + 1] = ny;
        normals[o + 2] = nz;
        colors[v * 4] = r;
        colors[v * 4 + 1] = g;
        colors[v * 4 + 2] = b;
        colors[v * 4 + 3] = 255;
        for (let a = 0; a < 3; a++) {
          if (positions[o + a] < min[a]) min[a] = positions[o + a];
          if (positions[o + a] > max[a]) max[a] = positions[o + a];
        }
        v++;
      }
    }
  }

  const bin = concatAligned([
    new Uint8Array(positions.buffer),
    new Uint8Array(normals.buffer),
    new Uint8Array(colors.buffer),
  ]);

  const json = {
    asset: { version: '2.0', generator: 'Pixhull' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{
      name,
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 },
        material: 0,
        mode: 4, // triangles
      }],
    }],
    materials: [{
      name: 'palette',
      pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 0,
        roughnessFactor: 1,
      },
      extensions: { KHR_materials_unlit: {} },
      doubleSided: false,
    }],
    extensionsUsed: ['KHR_materials_unlit'],
    accessors: [
      { bufferView: 0, componentType: FLOAT, count: vertexCount, type: 'VEC3', min, max },
      { bufferView: 1, componentType: FLOAT, count: vertexCount, type: 'VEC3' },
      { bufferView: 2, componentType: UNSIGNED_BYTE, count: vertexCount, type: 'VEC4', normalized: true },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: bin.offsets[0], byteLength: positions.byteLength, target: ARRAY_BUFFER },
      { buffer: 0, byteOffset: bin.offsets[1], byteLength: normals.byteLength, target: ARRAY_BUFFER },
      { buffer: 0, byteOffset: bin.offsets[2], byteLength: colors.byteLength, target: ARRAY_BUFFER },
    ],
    buffers: [{ byteLength: bin.bytes.length }],
  };

  return {
    bytes: packGlb(JSON.stringify(json), bin.bytes),
    stats: { triangles: vertexCount / 3, vertices: vertexCount, smooth },
  };
}

/**
 * Lay buffers end to end, each starting on a 4-byte boundary as glTF requires.
 * @param {Uint8Array[]} parts
 * @returns {{bytes: Uint8Array, offsets: number[]}}
 */
function concatAligned(parts) {
  const offsets = [];
  let total = 0;
  for (const part of parts) {
    total = align4(total);
    offsets.push(total);
    total += part.length;
  }
  const bytes = new Uint8Array(align4(total));
  parts.forEach((part, i) => bytes.set(part, offsets[i]));
  return { bytes, offsets };
}

const align4 = (n) => (n + 3) & ~3;

/**
 * @param {string} json
 * @param {Uint8Array} bin
 * @returns {Uint8Array}
 */
function packGlb(json, bin) {
  const jsonBytes = new TextEncoder().encode(json);
  // The JSON chunk pads with spaces and the binary chunk with zeroes; readers
  // are entitled to reject anything else.
  const jsonPadded = new Uint8Array(align4(jsonBytes.length)).fill(0x20);
  jsonPadded.set(jsonBytes);
  const binPadded = new Uint8Array(align4(bin.length));
  binPadded.set(bin);

  const total = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  view.setUint32(0, MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);

  view.setUint32(12, jsonPadded.length, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(jsonPadded, 20);

  const binHeader = 20 + jsonPadded.length;
  view.setUint32(binHeader, binPadded.length, true);
  view.setUint32(binHeader + 4, CHUNK_BIN, true);
  out.set(binPadded, binHeader + 8);

  return out;
}
