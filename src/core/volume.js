// @ts-check
/**
 * Sparse chunked voxel volume with per-face colour.
 *
 * Two decisions here carry the whole project:
 *
 * 1. Chunks (16^3) allocated on demand. A 256^3 model only materialises the
 *    chunks that actually contain surface, so memory tracks the art, not the
 *    bounding box. Edits mark one chunk dirty; the renderer rebuilds only that.
 *
 * 2. Six independent colours per voxel, one per face, stored as palette bytes.
 *    That is what lets a voxel read as "the front view's pixel" from the front
 *    and "the side view's pixel" from the side, instead of the flat single
 *    colour a .vox-style cube gives you.
 */

export const CHUNK = 16;
const CHUNK_VOX = CHUNK * CHUNK * CHUNK; // 4096
const CHUNK_WORDS = CHUNK_VOX / 32; // 128

/** +X, -X, +Y, -Y, +Z, -Z */
export const DIRS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

export const DIR_PX = 0, DIR_NX = 1, DIR_PY = 2, DIR_NY = 3, DIR_PZ = 4, DIR_NZ = 5;

class Chunk {
  constructor() {
    this.solid = new Uint32Array(CHUNK_WORDS);
    /**
     * Six palette indices per voxel, allocated only when something is painted.
     *
     * Most chunks of a solid model are entirely interior: every voxel in them
     * is buried, none of their faces will ever be seen, and none will ever be
     * painted. Allocating for them up front cost 175 MB on a 512 lorry to hold
     * 0.6 MB of real colour. Absent means every face is 0, which is what an
     * unpainted face reads as anyway.
     * @type {Uint8Array | null}
     */
    this.faces = null;
    this.count = 0;
  }

  /** @returns {Uint8Array} */
  paint() {
    if (!this.faces) this.faces = new Uint8Array(CHUNK_VOX * 6);
    return this.faces;
  }
}

export class Volume {
  /**
   * @param {number} nx @param {number} ny @param {number} nz
   */
  constructor(nx, ny, nz) {
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.cx = Math.ceil(nx / CHUNK);
    this.cy = Math.ceil(ny / CHUNK);
    this.cz = Math.ceil(nz / CHUNK);
    /** @type {Map<number, Chunk>} */
    this.chunks = new Map();
    /** @type {Set<number>} chunk ids whose geometry needs rebuilding */
    this.dirty = new Set();
    this.solidCount = 0;
  }

  /** @param {number} n @returns {Volume} */
  static cube(n) {
    return new Volume(n, n, n);
  }

  /**
   * Flatten to plain arrays that can cross a worker boundary.
   *
   * A `Volume` cannot be posted as it is: structured cloning drops the `Chunk`
   * prototype, and posting one buffer per chunk would mean thousands of
   * transfers on a large model. So the chunks are concatenated into four flat
   * arrays whose buffers travel as transferables - no copy on the way out, one
   * copy back into chunks on the way in.
   *
   * Interior chunks that were never painted stay unpainted here too: `faceOf`
   * is -1 for them and they contribute nothing to `faces`. On a 512 lorry that
   * is 52 MB moved instead of 250.
   *
   * Every face byte is carried verbatim. That is not an optimisation but the
   * contract: a face byte is the model's meaning, so a transfer that rounded,
   * renumbered or dropped one would be a silent corruption. `tests/carve/
   * volume-transfer.mjs` compares byte for byte.
   *
   * @returns {{nx: number, ny: number, nz: number, solidCount: number,
   *   ids: Int32Array, counts: Uint32Array, solid: Uint32Array,
   *   faceOf: Int32Array, faces: Uint8Array}}
   */
  pack() {
    const n = this.chunks.size;
    const ids = new Int32Array(n);
    const counts = new Uint32Array(n);
    const solid = new Uint32Array(n * CHUNK_WORDS);
    const faceOf = new Int32Array(n).fill(-1);
    let painted = 0;
    for (const c of this.chunks.values()) if (c.faces) painted++;
    const faces = new Uint8Array(painted * CHUNK_VOX * 6);

    let i = 0;
    let f = 0;
    for (const [id, c] of this.chunks) {
      ids[i] = id;
      counts[i] = c.count;
      solid.set(c.solid, i * CHUNK_WORDS);
      if (c.faces) {
        faces.set(c.faces, f * CHUNK_VOX * 6);
        faceOf[i] = f;
        f++;
      }
      i++;
    }
    return { nx: this.nx, ny: this.ny, nz: this.nz, solidCount: this.solidCount, ids, counts, solid, faceOf, faces };
  }

  /** The buffers of a packed volume, in the form `postMessage` wants. */
  static transferables(packed) {
    return [packed.ids.buffer, packed.counts.buffer, packed.solid.buffer, packed.faceOf.buffer, packed.faces.buffer];
  }

  /**
   * Rebuild a volume from `pack()`.
   *
   * The dirty set is left empty on purpose: whoever unpacks has the geometry
   * that came with it, and marking every chunk dirty would ask the renderer to
   * rebuild the buffer it was just handed.
   *
   * @param {ReturnType<Volume['pack']>} p
   * @returns {Volume}
   */
  static unpack(p) {
    const vol = new Volume(p.nx, p.ny, p.nz);
    for (let i = 0; i < p.ids.length; i++) {
      const c = new Chunk();
      c.count = p.counts[i];
      c.solid.set(p.solid.subarray(i * CHUNK_WORDS, (i + 1) * CHUNK_WORDS));
      const f = p.faceOf[i];
      if (f >= 0) c.paint().set(p.faces.subarray(f * CHUNK_VOX * 6, (f + 1) * CHUNK_VOX * 6));
      vol.chunks.set(p.ids[i], c);
    }
    vol.solidCount = p.solidCount;
    return vol;
  }

  inBounds(x, y, z) {
    return x >= 0 && y >= 0 && z >= 0 && x < this.nx && y < this.ny && z < this.nz;
  }

  /** @returns {number} chunk id for voxel coords (caller must bounds-check) */
  chunkId(x, y, z) {
    return ((x / CHUNK) | 0) + this.cx * (((y / CHUNK) | 0) + this.cy * ((z / CHUNK) | 0));
  }

  /** @returns {number} index of the voxel inside its chunk */
  static localIndex(x, y, z) {
    return (x & 15) | ((y & 15) << 4) | ((z & 15) << 8);
  }

  /** @returns {boolean} */
  get(x, y, z) {
    if (!this.inBounds(x, y, z)) return false;
    const c = this.chunks.get(this.chunkId(x, y, z));
    if (c === undefined) return false;
    const li = Volume.localIndex(x, y, z);
    return (c.solid[li >> 5] & (1 << (li & 31))) !== 0;
  }

  /**
   * Set occupancy. Clearing a voxel also clears its six face colours, so a
   * voxel can never come back holding stale paint.
   * @param {number} x @param {number} y @param {number} z @param {boolean} on
   */
  set(x, y, z, on) {
    if (!this.inBounds(x, y, z)) return;
    const id = this.chunkId(x, y, z);
    let c = this.chunks.get(id);
    if (c === undefined) {
      if (!on) return;
      c = new Chunk();
      this.chunks.set(id, c);
    }
    const li = Volume.localIndex(x, y, z);
    const w = li >> 5;
    const bit = 1 << (li & 31);
    const was = (c.solid[w] & bit) !== 0;
    if (was === on) return;
    if (on) {
      c.solid[w] |= bit;
      c.count++;
      this.solidCount++;
    } else {
      c.solid[w] &= ~bit;
      c.count--;
      this.solidCount--;
      if (c.faces) c.faces.fill(0, li * 6, li * 6 + 6);
    }
    this.touch(x, y, z);
  }

  /**
   * Mark the owning chunk dirty, plus any neighbour chunk this voxel borders -
   * a voxel on a chunk seam changes the face visibility of the chunk next door.
   */
  touch(x, y, z) {
    this.dirty.add(this.chunkId(x, y, z));
    for (let d = 0; d < 6; d++) {
      const nx = x + DIRS[d][0], ny = y + DIRS[d][1], nz = z + DIRS[d][2];
      if (this.inBounds(nx, ny, nz)) this.dirty.add(this.chunkId(nx, ny, nz));
    }
  }

  /** @returns {number} palette index, 0 when unpainted */
  getFace(x, y, z, dir) {
    if (!this.inBounds(x, y, z)) return 0;
    const c = this.chunks.get(this.chunkId(x, y, z));
    if (c === undefined || c.faces === null) return 0;
    return c.faces[Volume.localIndex(x, y, z) * 6 + dir];
  }

  /** @param {number} idx palette index */
  setFace(x, y, z, dir, idx) {
    if (!this.inBounds(x, y, z)) return;
    const c = this.chunks.get(this.chunkId(x, y, z));
    if (c === undefined) return;
    c.paint()[Volume.localIndex(x, y, z) * 6 + dir] = idx;
    this.dirty.add(this.chunkId(x, y, z));
  }

  /** Paint all six faces of a voxel at once. */
  setAllFaces(x, y, z, idx) {
    if (!this.inBounds(x, y, z)) return;
    const c = this.chunks.get(this.chunkId(x, y, z));
    if (c === undefined) return;
    c.paint().fill(idx, Volume.localIndex(x, y, z) * 6, Volume.localIndex(x, y, z) * 6 + 6);
    this.dirty.add(this.chunkId(x, y, z));
  }

  /**
   * Visit every solid voxel. Iterates only allocated chunks, so an empty
   * 512^3 volume costs nothing.
   * @param {(x: number, y: number, z: number) => void} fn
   */
  forEachSolid(fn) {
    for (const [id, c] of this.chunks) {
      if (c.count === 0) continue;
      const cxi = id % this.cx;
      const cyi = ((id / this.cx) | 0) % this.cy;
      const czi = (id / (this.cx * this.cy)) | 0;
      const ox = cxi * CHUNK, oy = cyi * CHUNK, oz = czi * CHUNK;
      for (let li = 0; li < CHUNK_VOX; li++) {
        if ((c.solid[li >> 5] & (1 << (li & 31))) === 0) continue;
        fn(ox + (li & 15), oy + ((li >> 4) & 15), oz + ((li >> 8) & 15));
      }
    }
  }

  /**
   * How many exposed faces each palette slot paints.
   *
   * Deliberately not `buildFaceInstances`: that one clears the dirty set as it
   * goes, so borrowing it to answer a question about colours would leave the
   * renderer believing it had already been given geometry it never received.
   * This walk only reads.
   *
   * A big model can outrun any budget, so the walk stops on a deadline and
   * says it stopped. A caller that shows "0" for a count it never finished is
   * lying about which colours are unused.
   *
   * @param {number} [deadline] value of `performance.now()` to stop at
   * @returns {{counts: Uint32Array, complete: boolean}} counts indexed by palette slot
   */
  countExposedFaces(deadline = Infinity) {
    const counts = new Uint32Array(256);
    let complete = true;
    let chunksDone = 0;

    for (const [id, c] of this.chunks) {
      if (c.count === 0 || c.faces === null) continue;
      const cxi = id % this.cx;
      const cyi = ((id / this.cx) | 0) % this.cy;
      const czi = (id / (this.cx * this.cy)) | 0;
      const ox = cxi * CHUNK, oy = cyi * CHUNK, oz = czi * CHUNK;

      for (let li = 0; li < CHUNK_VOX; li++) {
        if ((c.solid[li >> 5] & (1 << (li & 31))) === 0) continue;
        const x = ox + (li & 15), y = oy + ((li >> 4) & 15), z = oz + ((li >> 8) & 15);
        for (let d = 0; d < 6; d++) {
          const [dx, dy, dz] = DIRS[d];
          if (this.get(x + dx, y + dy, z + dz)) continue;
          const idx = c.faces[li * 6 + d];
          if (idx !== 0) counts[idx]++;
        }
      }

      // Checked between chunks, not between voxels: one chunk is 4096 voxels,
      // which is far below any budget worth having, and a clock read per voxel
      // would cost more than the walk.
      if ((++chunksDone & 7) === 0 && performance.now() > deadline) {
        complete = false;
        break;
      }
    }

    return { counts, complete };
  }

  /**
   * Rewrite every face byte through a 256-entry map.
   *
   * This is the model side of a palette merge: the palette says "slot 91 is now
   * slot 12", and every face wearing 91 has to be told. Nothing else about the
   * model changes - occupancy, geometry and face directions are untouched, only
   * the byte naming the colour.
   *
   * The record is what makes the operation undoable. A merge is many-to-one, so
   * the map cannot be inverted: only the old byte of each face that changed says
   * where it came from. That costs nine bytes per changed face and nothing per
   * face left alone, which is why a merge of two near-identical shades on a
   * large model is measured in kilobytes rather than in the whole volume.
   *
   * @param {Uint8Array} remap 256 entries; `remap[i] === i` means "leave alone"
   * @returns {{changed: number, ids: Int32Array, offsets: Int32Array, before: Uint8Array}}
   */
  remapFaces(remap) {
    /** @type {number[]} */
    const ids = [];
    /** @type {number[]} */
    const offsets = [];
    /** @type {number[]} */
    const before = [];

    for (const [id, c] of this.chunks) {
      const faces = c.faces;
      if (faces === null) continue;
      let touched = false;
      for (let o = 0; o < faces.length; o++) {
        const was = faces[o];
        const now = remap[was];
        if (now === was) continue;
        ids.push(id);
        offsets.push(o);
        before.push(was);
        faces[o] = now;
        touched = true;
      }
      // One dirty mark per chunk, not per face: the renderer rebuilds a chunk
      // as a whole either way.
      if (touched) this.dirty.add(id);
    }

    return {
      changed: before.length,
      ids: Int32Array.from(ids),
      offsets: Int32Array.from(offsets),
      before: Uint8Array.from(before),
    };
  }

  /**
   * Put back exactly the face bytes a `remapFaces` record took away.
   * @param {{ids: Int32Array, offsets: Int32Array, before: Uint8Array}} record
   * @returns {number} how many bytes were written back
   */
  restoreFaces(record) {
    let n = 0;
    for (let k = 0; k < record.before.length; k++) {
      const c = this.chunks.get(record.ids[k]);
      if (c === undefined) continue;
      c.paint()[record.offsets[k]] = record.before[k];
      this.dirty.add(record.ids[k]);
      n++;
    }
    return n;
  }

  /** @returns {{min: [number,number,number], max: [number,number,number]}|null} */
  bounds() {
    if (this.solidCount === 0) return null;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    this.forEachSolid((x, y, z) => {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    });
    return { min: [x0, y0, z0], max: [x1, y1, z1] };
  }

  /**
   * Every exposed face, packed for instanced drawing.
   * Layout per instance, stride 8 bytes: int16 x, int16 y, int16 z, uint8 dir,
   * uint8 paletteIndex.
   * @returns {{buffer: ArrayBuffer, count: number}}
   */
  buildFaceInstances() {
    // Guess from the model's *skin*, not its bulk. Three faces per solid voxel
    // is a fair guess for a sparse shape and a wild one for a solid lorry: at
    // 512 it asked for a 583 MB buffer to hold 5 MB of faces. A closed surface
    // inside the grid cannot have more faces than twice each of its three
    // cross-sections, and `grow` below doubles if a spikier model needs more.
    const skin = 12 * (this.nx * this.ny + this.ny * this.nz + this.nx * this.nz);
    let cap = Math.max(1024, Math.min(this.solidCount * 3, skin));
    let buf = new ArrayBuffer(cap * 8);
    let i16 = new Int16Array(buf);
    let u8 = new Uint8Array(buf);
    let n = 0;

    const grow = () => {
      cap *= 2;
      const nb = new ArrayBuffer(cap * 8);
      new Uint8Array(nb).set(u8.subarray(0, n * 8));
      buf = nb;
      i16 = new Int16Array(buf);
      u8 = new Uint8Array(buf);
    };

    this.forEachSolid((x, y, z) => {
      for (let d = 0; d < 6; d++) {
        const nx = x + DIRS[d][0], ny = y + DIRS[d][1], nz = z + DIRS[d][2];
        if (this.get(nx, ny, nz)) continue;
        if (n === cap) grow();
        const o16 = n * 4;
        i16[o16] = x;
        i16[o16 + 1] = y;
        i16[o16 + 2] = z;
        u8[n * 8 + 6] = d;
        u8[n * 8 + 7] = this.getFace(x, y, z, d);
        n++;
      }
    });

    this.dirty.clear();
    return { buffer: buf.slice(0, n * 8), count: n };
  }
}
