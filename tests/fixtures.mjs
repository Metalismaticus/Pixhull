// @ts-check
/**
 * Synthetic input for the checks.
 *
 * Every drawing here is generated, never loaded: the checks must not depend on
 * anyone's art, on the palette the art happens to use, or on a file that can go
 * missing. A bare cube, a 45-degree wedge, a step and a fin one voxel thick are
 * enough to pin down what the carve is supposed to do, and each of them has an
 * answer that can be written down exactly rather than eyeballed.
 *
 * Two ways in:
 *
 * - `makeFlat` and friends build an image directly, for anything that only
 *   needs a picture.
 * - `viewsOfShape` goes the other way: state the solid as a predicate over the
 *   grid and let it draw the six views by projecting. Silhouettes made this way
 *   agree with each other by construction, so a disagreement found later is the
 *   carve's, not the fixture's.
 */

import { SourceView, VIEW_NAMES, VIEW_GEOM } from '../src/core/views.js';

/** Six colours far enough apart that a face painted by the wrong view shows. */
export const VIEW_COLOUR = {
  front: [220, 40, 40],
  back: [40, 90, 220],
  right: [40, 180, 70],
  left: [230, 180, 40],
  top: [200, 200, 210],
  bottom: [20, 20, 20],
};

/**
 * A blank RGBA8 image, fully transparent.
 * @param {number} w @param {number} h
 * @returns {{width: number, height: number, data: Uint8ClampedArray}}
 */
export function makeImage(w, h) {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}

/**
 * @param {{width: number, height: number, data: Uint8ClampedArray}} img
 * @param {number} x @param {number} y @param {number[]} rgb
 */
export function setPixel(img, x, y, rgb) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = rgb[0];
  img.data[i + 1] = rgb[1];
  img.data[i + 2] = rgb[2];
  img.data[i + 3] = 255;
}

/**
 * A solid rectangle of one colour, filling the whole image.
 * @param {number} w @param {number} h @param {number[]} rgb
 */
export function makeFlat(w, h, rgb) {
  const img = makeImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, rgb);
  return img;
}

/**
 * A right triangle with a 45-degree hypotenuse running from the bottom-left to
 * the top-right, drawn in image space (row 0 is the top).
 * @param {number} w @param {number} h @param {number[]} rgb
 */
export function makeWedge(w, h, rgb) {
  const img = makeImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Below the diagonal, so the shape grows taller as it goes right.
      if (h - 1 - y <= (x * (h - 1)) / Math.max(1, w - 1)) setPixel(img, x, y, rgb);
    }
  }
  return img;
}

/**
 * Two levels with one riser between them: the smallest shape that has a step
 * without having a slope.
 * @param {number} w @param {number} h @param {number[]} rgb
 */
export function makeStep(w, h, rgb) {
  const img = makeImage(w, h);
  const half = w >> 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const top = x < half ? (h >> 1) : 0;
      if (y >= top) setPixel(img, x, y, rgb);
    }
  }
  return img;
}

/**
 * A plate one pixel wide, centred: the view of a fin one voxel thick.
 * @param {number} w @param {number} h @param {number[]} rgb
 */
export function makeFin(w, h, rgb) {
  const img = makeImage(w, h);
  const x = w >> 1;
  for (let y = 0; y < h; y++) setPixel(img, x, y, rgb);
  return img;
}

/**
 * Place a view on the grid one art pixel per cell, exactly where it was drawn.
 *
 * `autoPlace` centres the trimmed content, which is right for hand-drawn art
 * and wrong here: a fixture draws its views on a grid-sized canvas already in
 * register with the others, and centring a trimmed fin would slide it half a
 * grid sideways relative to the views it has to agree with.
 *
 * @param {SourceView} view
 */
export function placeIdentity(view) {
  view.orientLocked = true;
  view.rotate = 0;
  view.flipH = false;
  view.flipV = false;
  view.scaleX = 1;
  view.scaleY = 1;
  view.offsetX = view.trim.x;
  view.offsetY = view.trim.y;
  return view;
}

/**
 * Build SourceViews from ready-made images, in register.
 * @param {Record<string, {width: number, height: number, data: Uint8ClampedArray}>} images
 * @returns {SourceView[]}
 */
export function viewsFromImages(images) {
  const views = [];
  for (const name of VIEW_NAMES) {
    if (!images[name]) continue;
    views.push(placeIdentity(new SourceView(name, images[name])));
  }
  return views;
}

/**
 * Draw the six views of a solid by projecting it, each view in its own colour.
 *
 * This is the reference direction: the shape is stated once, the drawings are
 * derived, and every silhouette is exactly the one the carve is supposed to
 * intersect. Anything the carve then gets wrong is the carve's.
 *
 * @param {number} N grid size
 * @param {(x: number, y: number, z: number) => boolean} solid
 * @param {{colours?: Record<string, number[]>, only?: string[]}} [opts]
 * @returns {SourceView[]}
 */
export function viewsOfShape(N, solid, opts = {}) {
  const colours = opts.colours ?? VIEW_COLOUR;
  const names = opts.only ?? VIEW_NAMES;
  /** @type {Record<string, any>} */
  const images = {};
  for (const name of names) {
    const geom = VIEW_GEOM[name];
    const img = makeImage(N, N);
    for (let v = 0; v < N; v++) {
      for (let u = 0; u < N; u++) {
        for (let d = 0; d < N; d++) {
          const [x, y, z] = geom.ray(u, v, d, N);
          if (!solid(x, y, z)) continue;
          setPixel(img, u, v, colours[name]);
          break;
        }
      }
    }
    images[name] = img;
  }
  return viewsFromImages(images);
}

/** Shapes, as predicates over an N-grid. Each fills the grid it is given. */
export const SHAPES = {
  /** Every cell: the bare cube. */
  cube: () => () => true,

  /**
   * A 45-degree ramp: the surface runs diagonally in the y/z plane, so on the
   * lattice it is a staircase whose treads and risers belong to one surface.
   */
  wedge: (N) => (x, y, z) => y + z <= N - 1,

  /**
   * A box body with a sloped nose on top of it - a cab with a windscreen. The
   * slope has a flat roof behind it and a flat front below it, which is what
   * makes it useful: the corners between them must not be treated as slope.
   */
  cab: (N) => {
    const roof = Math.floor(N * 0.6);
    const nose = Math.floor(N * 0.45);
    return (x, y, z) => {
      if (y >= N - 1) return false;
      if (y < roof) return z < N - 1; // the body, full width and depth
      // Above the body the nose falls away towards the front.
      return z < N - 1 - (y - roof) && z < nose + (N - 1 - y);
    };
  },

  /**
   * Two levels with one upright riser between them, and not a diagonal
   * anywhere: every face points squarely along its own axis, so every face has
   * exactly one drawing entitled to it. That makes it the shape to ask "did any
   * view paint a face it cannot see?" about.
   */
  step: (N) => {
    const half = N >> 1;
    return (x, y, z) => y < (z < half ? N - 1 : half);
  },

  /**
   * Something the shape of a vehicle: long in x, shallow in y and z, with a
   * sloped nose. Used by the timing check, where a solid cube would be
   * misleading twice over - it is not the shape anyone carves, and the blurred
   * field over a full-grid bounding box costs half a gigabyte at 512.
   */
  lorry: (N) => {
    const yTop = Math.floor(N * 0.40);
    const z0 = Math.floor(N * 0.20);
    const z1 = Math.floor(N * 0.75);
    const roof = Math.floor(yTop * 0.62);
    const nose = z0 + Math.floor((z1 - z0) * 0.35);
    return (x, y, z) => {
      if (y < 0 || y >= yTop || z < z0 || z >= z1) return false;
      if (y < roof) return true;
      // Above the body line the cab falls away towards the front of the model.
      return z < nose + (yTop - 1 - y);
    };
  },

  /** A plate one voxel thick, standing across x. */
  fin: (N) => {
    const at = N >> 1;
    return (x, y, z) => x === at;
  },
};

/**
 * A painted body: one flat base colour, a lot of near-identical shading, and
 * small bright accents.
 *
 * This is the shape of the palette problem rather than a shape in space. Six
 * full squares carve into a bare cube, so the geometry is trivial and every
 * face is painted straight from a drawing - what is left to measure is the
 * colour. The drawing is built so that the two ways of filling a palette
 * disagree: every shading grey covers more cells than any one accent, so
 * picking the 255 most used colours spends the slots on shades nobody can tell
 * apart and throws the lights and badges away outright.
 *
 * The counts are chosen, not measured: 204 near-white shades and 216 accent
 * colours against 255 slots, with accents on about a third of the area. They
 * stand for a white lorry with painted detail, which is the art the defect was
 * reported on.
 *
 * @param {number} N grid size; 64 is what the checks use
 * @returns {Record<string, {width: number, height: number, data: Uint8ClampedArray}>}
 */
export function makeLivery(N) {
  /** Hue families for the accents - far from the body and far from each other. */
  const FAMILIES = [
    [200, 40, 40], [40, 90, 200], [230, 180, 40],
    [40, 170, 80], [180, 60, 180], [240, 120, 30],
  ];
  const PATCH = Math.max(2, Math.floor(N / 10));
  const STEP = PATCH * 2;
  const PER_ROW = Math.ceil(N / STEP);
  /** @type {Record<string, any>} */
  const images = {};

  VIEW_NAMES.forEach((name, view) => {
    const img = makeImage(N, N);
    for (let v = 0; v < N; v++) {
      for (let u = 0; u < N; u++) {
        // Shading: 34 shades per view, a 4x4 block of cells at a time, and no
        // two views share one - the anti-aliased near-whites of real art.
        const block = ((v / 4) | 0) * 19 + ((u / 4) | 0) * 7;
        const shade = view * 34 + (block % 34);
        /** @type {number[]} */
        const rgb = [246 - (shade % 17), 248 - (((shade / 17) | 0) % 12), 250];

        // Accents: small patches, each its own colour, each covering fewer
        // cells than any single shade does.
        if (u % STEP < PATCH && v % STEP < PATCH) {
          const slot = view * PER_ROW * PER_ROW + ((v / STEP) | 0) * PER_ROW + ((u / STEP) | 0);
          const base = FAMILIES[slot % FAMILIES.length];
          const tint = ((slot / FAMILIES.length) | 0) % 20;
          rgb[0] = base[0] - tint;
          rgb[1] = base[1] + tint;
          rgb[2] = base[2] - ((slot % 3) * 4);
        }
        setPixel(img, u, v, rgb);
      }
    }
    images[name] = img;
  });
  return images;
}
