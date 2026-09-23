// @ts-check
/**
 * Volume serialisation for project files.
 *
 * Once a model can be hand-edited, saving only the source views would silently
 * throw that work away - a rebuild from the same PNGs cannot reproduce a
 * concavity that was carved by hand. So the voxels travel with the project.
 *
 * Two run-length streams rather than raw bytes: occupancy is mostly long runs
 * of empty space, and face colours are mostly long runs of one palette index.
 * Nothing is materialised at full volume size along the way, so a 256³ model
 * does not need a 16 MB scratch buffer to be written out.
 */

import { Volume } from './volume.js';

class ByteSink {
  constructor() {
    this.buf = new Uint8Array(1024);
    this.n = 0;
  }
  push(b) {
    if (this.n === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.n++] = b & 255;
  }
  /** LEB128, so short runs cost one byte and long ones stay exact. */
  varint(v) {
    let x = v >>> 0;
    while (x >= 0x80) {
      this.push((x & 0x7f) | 0x80);
      x >>>= 7;
    }
    this.push(x);
  }
  bytes() {
    return this.buf.subarray(0, this.n);
  }
}

class ByteSource {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.b = bytes;
    this.i = 0;
  }
  get done() {
    return this.i >= this.b.length;
  }
  read() {
    return this.b[this.i++];
  }
  varint() {
    let shift = 0;
    let out = 0;
    for (;;) {
      const byte = this.b[this.i++];
      out |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return out >>> 0;
      shift += 7;
    }
  }
}

/** @param {Uint8Array} bytes @returns {string} */
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(i, i + 0x8000)));
  }
  return btoa(s);
}

/** @param {string} b64 @returns {Uint8Array} */
function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * @param {Volume} vol
 * @returns {{nx: number, ny: number, nz: number, solid: string, faces: string}}
 */
export function serializeVolume(vol) {
  const solid = new ByteSink();
  const faces = new ByteSink();

  // Occupancy: alternating run lengths, starting with a run of empty.
  let runValue = 0;
  let runLength = 0;
  // Face colours: (value, count) pairs, in the same voxel order, solid only.
  let faceValue = -1;
  let faceCount = 0;

  const flushFace = () => {
    if (faceCount > 0) {
      faces.push(faceValue);
      faces.varint(faceCount);
    }
  };

  for (let z = 0; z < vol.nz; z++) {
    for (let y = 0; y < vol.ny; y++) {
      for (let x = 0; x < vol.nx; x++) {
        const s = vol.get(x, y, z) ? 1 : 0;
        if (s === runValue) {
          runLength++;
        } else {
          solid.varint(runLength);
          runValue = s;
          runLength = 1;
        }
        if (!s) continue;
        for (let d = 0; d < 6; d++) {
          const c = vol.getFace(x, y, z, d);
          if (c === faceValue) {
            faceCount++;
          } else {
            flushFace();
            faceValue = c;
            faceCount = 1;
          }
        }
      }
    }
  }
  solid.varint(runLength);
  flushFace();

  return {
    nx: vol.nx,
    ny: vol.ny,
    nz: vol.nz,
    solid: toBase64(solid.bytes()),
    faces: toBase64(faces.bytes()),
  };
}

/**
 * @param {{nx: number, ny: number, nz: number, solid: string, faces: string}} data
 * @returns {Volume}
 */
export function deserializeVolume(data) {
  const vol = new Volume(data.nx, data.ny, data.nz);
  const solid = new ByteSource(fromBase64(data.solid));
  const faces = new ByteSource(fromBase64(data.faces));

  let faceValue = 0;
  let faceCount = 0;
  const nextFace = () => {
    if (faceCount === 0) {
      if (faces.done) return 0;
      faceValue = faces.read();
      faceCount = faces.varint();
    }
    faceCount--;
    return faceValue;
  };

  const total = data.nx * data.ny * data.nz;
  let i = 0;
  let value = 0;
  while (i < total && !solid.done) {
    const run = solid.varint();
    if (value === 1) {
      for (let k = 0; k < run; k++) {
        const j = i + k;
        const x = j % data.nx;
        const y = ((j / data.nx) | 0) % data.ny;
        const z = (j / (data.nx * data.ny)) | 0;
        vol.set(x, y, z, true);
        for (let d = 0; d < 6; d++) vol.setFace(x, y, z, d, nextFace());
      }
    }
    i += run;
    value ^= 1;
  }

  return vol;
}
