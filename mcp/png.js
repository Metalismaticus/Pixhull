// @ts-check
/**
 * PNG decoding and encoding for Node.
 *
 * The browser hands us decoded pixels for free; Node does not. Rather than take
 * a dependency, this leans on the one hard part already being in the standard
 * library: PNG's payload is a zlib stream, and `node:zlib` inflates it. What is
 * left is chunk parsing, scanline unfiltering and expanding whatever colour
 * type the file uses into the plain RGBA8 the core expects - the same shape the
 * browser path produces, so the carve cannot drift between the two.
 */

import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** @param {Uint8Array} bytes */
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Channels per pixel for each PNG colour type. */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * @param {Buffer|Uint8Array} input
 * @returns {{width: number, height: number, data: Uint8Array}} RGBA8
 */
export function decodePng(input) {
  const buf = Buffer.from(input.buffer ?? input, input.byteOffset ?? 0, input.byteLength ?? input.length);
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIGNATURE[i]) throw new Error('Not a PNG file.');
  }

  let width = 0, height = 0, bitDepth = 8, colorType = 6, interlace = 0;
  /** @type {Uint8Array|null} */
  let palette = null;
  /** @type {Uint8Array|null} */
  let transparency = null;
  /** @type {Buffer[]} */
  const idat = [];

  let o = 8;
  while (o + 8 <= buf.length) {
    const length = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    const body = buf.subarray(o + 8, o + 8 + length);

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'PLTE') {
      palette = new Uint8Array(body);
    } else if (type === 'tRNS') {
      transparency = new Uint8Array(body);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body));
    } else if (type === 'IEND') {
      break;
    }
    o += 12 + length; // length + type + body + CRC
  }

  if (!width || !height) throw new Error('PNG has no IHDR.');
  if (interlace !== 0) throw new Error('Interlaced PNGs are not supported; save without Adam7 interlacing.');
  if (!(colorType in CHANNELS)) throw new Error('Unsupported PNG colour type ' + colorType + '.');
  if (colorType === 3 && !palette) throw new Error('Indexed PNG has no palette.');

  const raw = inflateSync(Buffer.concat(idat));
  const channels = CHANNELS[colorType];
  const bitsPerPixel = channels * bitDepth;
  // Filtering works on whole bytes; sub-byte depths use a distance of one.
  const filterStride = Math.max(1, bitsPerPixel >> 3);
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);

  const pixels = unfilter(raw, height, rowBytes, filterStride);
  return { width, height, data: toRgba(pixels, width, height, rowBytes, bitDepth, colorType, palette, transparency) };
}

/**
 * Reverse the per-scanline filters. Each row is prefixed by its filter type.
 * @param {Buffer} raw
 * @returns {Uint8Array} unfiltered rows, without the filter bytes
 */
function unfilter(raw, height, rowBytes, stride) {
  const out = new Uint8Array(height * rowBytes);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = y * rowBytes;
    const prev = row - rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[src + i];
      const a = i >= stride ? out[row + i - stride] : 0;
      const b = y > 0 ? out[prev + i] : 0;
      const c = y > 0 && i >= stride ? out[prev + i - stride] : 0;
      let value;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + a; break;
        case 2: value = x + b; break;
        case 3: value = x + ((a + b) >> 1); break;
        case 4: value = x + paeth(a, b, c); break;
        default: throw new Error('Unknown PNG filter type ' + filter + '.');
      }
      out[row + i] = value & 255;
    }
    src += rowBytes;
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Expand any supported colour type to RGBA8.
 * @returns {Uint8Array}
 */
function toRgba(pixels, width, height, rowBytes, bitDepth, colorType, palette, transparency) {
  const out = new Uint8Array(width * height * 4);

  /** Read sample `i` of a row, normalised to 0..255. */
  const sample = (row, i) => {
    if (bitDepth === 8) return pixels[row + i];
    if (bitDepth === 16) return pixels[row + i * 2]; // high byte is plenty for art
    // 1, 2 or 4 bits, packed most-significant first.
    const perByte = 8 / bitDepth;
    const byte = pixels[row + Math.floor(i / perByte)];
    const shift = 8 - bitDepth * ((i % perByte) + 1);
    return (byte >> shift) & ((1 << bitDepth) - 1);
  };

  const channels = CHANNELS[colorType];
  const maxValue = (1 << Math.min(bitDepth, 8)) - 1;

  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const base = x * channels;

      if (colorType === 3) {
        const idx = sample(row, base);
        out[o] = palette[idx * 3];
        out[o + 1] = palette[idx * 3 + 1];
        out[o + 2] = palette[idx * 3 + 2];
        out[o + 3] = transparency && idx < transparency.length ? transparency[idx] : 255;
        continue;
      }

      if (colorType === 0 || colorType === 4) {
        const g = bitDepth < 8 ? Math.round((sample(row, base) / maxValue) * 255) : sample(row, base);
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = colorType === 4 ? sample(row, base + 1) : 255;
        continue;
      }

      out[o] = sample(row, base);
      out[o + 1] = sample(row, base + 1);
      out[o + 2] = sample(row, base + 2);
      out[o + 3] = colorType === 6 ? sample(row, base + 3) : 255;
    }
  }

  // Greyscale and truecolour can declare one fully transparent colour.
  if (transparency && (colorType === 0 || colorType === 2)) {
    const key = colorType === 0
      ? [transparency.readUInt16BE?.(0) ?? (transparency[0] << 8) | transparency[1]]
      : null;
    if (colorType === 2) {
      const r = transparency[1], g = transparency[3], b = transparency[5];
      for (let i = 0; i < out.length; i += 4) {
        if (out[i] === r && out[i + 1] === g && out[i + 2] === b) out[i + 3] = 0;
      }
    } else if (key) {
      const g = key[0] & 255;
      for (let i = 0; i < out.length; i += 4) {
        if (out[i] === g) out[i + 3] = 0;
      }
    }
  }

  return out;
}

/**
 * @param {{width: number, height: number, data: Uint8Array|Uint8ClampedArray}} image RGBA8
 * @returns {Buffer}
 */
export function encodePng(image) {
  const { width, height, data } = image;

  // Filter type 0 on every row. Pixel art is flat colour, so deflate does the
  // work and a cleverer filter would buy little.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const dst = y * (1 + width * 4);
    raw[dst] = 0;
    for (let i = 0; i < width * 4; i++) raw[dst + 1 + i] = data[y * width * 4 + i];
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * @param {string} type
 * @param {Buffer} body
 * @returns {Buffer}
 */
function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}
