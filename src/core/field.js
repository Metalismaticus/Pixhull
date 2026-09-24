// @ts-check
/**
 * Occupancy blurred into a density field, and the surface directions read off
 * it.
 *
 * A binary lattice knows only six directions, which is not enough to tell a
 * staircase standing in for a slope from a genuine right angle. Blurring first
 * gives the surface a gradient: across a staircase the density falls off along
 * the slope, so every face on it - the flat treads and the upright risers
 * alike - reports the same direction, while at a real corner the directions on
 * either side stay distinct.
 *
 * Two things need that. The smooth mesh uses it to round the staircase without
 * rounding the corner next to it; the carve uses it to work out which drawing
 * a sloped face should take its colour from, so the treads and the risers stop
 * being painted from two drawings that disagree.
 */

/**
 * Blur the volume's occupancy over its bounding box.
 *
 * Three separable passes with a running sum, so the cost does not grow with
 * the radius.
 *
 * @param {import('./volume.js').Volume} vol
 * @param {{min: number[], max: number[]}} box
 * @param {number} radius
 * @param {(part: number) => void} [onStep] called between the four passes, with
 *   how far through this field they are; a carve off the main thread reports it
 * @returns {{releaseGradient: () => void, solid: (x: number, y: number, z: number) => boolean,
 *   grad: (x: number, y: number, z: number) => number[] | null}}
 */
export function densityField(vol, box, radius, onStep) {
  const pad = radius + 2;
  const ox = box.min[0] - pad;
  const oy = box.min[1] - pad;
  const oz = box.min[2] - pad;
  const nx = box.max[0] - box.min[0] + 1 + 2 * pad;
  const ny = box.max[1] - box.min[1] + 1 + 2 * pad;
  const nz = box.max[2] - box.min[2] + 1 + 2 * pad;
  let data = new Float32Array(nx * ny * nz);
  const at = (i, j, k) => (k * ny + j) * nx + i;

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (vol.get(ox + i, oy + j, oz + k)) data[at(i, j, k)] = 1;
      }
    }
  }
  // Kept so the caller does not have to read the whole volume a second time to
  // find its exposed faces. At 384 that second pass cost a second on its own.
  const occupied = Uint8Array.from(data);

  const width = 2 * radius + 1;
  const line = new Float32Array(Math.max(nx, ny, nz));
  /** One separable pass: `count` samples `step` apart starting at `base`. */
  const blur = (base, step, count) => {
    for (let i = 0; i < count; i++) line[i] = data[base + i * step];
    let sum = 0;
    for (let i = 0; i <= radius && i < count; i++) sum += line[i];
    for (let i = 0; i < count; i++) {
      data[base + i * step] = sum / width;
      const drop = i - radius;
      const add = i + radius + 1;
      if (drop >= 0) sum -= line[drop];
      if (add < count) sum += line[add];
    }
  };
  onStep?.(0.25);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) blur(at(0, j, k), 1, nx);
  onStep?.(0.5);
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) blur(at(i, 0, k), nx, ny);
  onStep?.(0.75);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) blur(at(i, j, 0), nx * ny, nz);
  onStep?.(1);

  return {
    /**
     * Drop the blurred field, keeping the occupancy.
     *
     * At 512 the blurred copy is 168 MB and nothing wants it once the surface
     * directions have been read, while the occupancy is a twentieth the size
     * and is still worth keeping.
     */
    releaseGradient() {
      data = null;
    },

    /** Is this voxel solid? Reads the copy taken before blurring. */
    solid(x, y, z) {
      const i = x - ox;
      const j = y - oy;
      const k = z - oz;
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return false;
      return occupied[at(i, j, k)] === 1;
    },

    /** Gradient at a voxel centre, in voxel-index space; null outside the box. */
    grad(x, y, z) {
      const i = x - ox;
      const j = y - oy;
      const k = z - oz;
      if (!data) return null;
      if (i < 1 || j < 1 || k < 1 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1) return null;
      return [
        data[at(i + 1, j, k)] - data[at(i - 1, j, k)],
        data[at(i, j + 1, k)] - data[at(i, j - 1, k)],
        data[at(i, j, k + 1)] - data[at(i, j, k - 1)],
      ];
    },
  };
}

/**
 * The six face directions, in the order volume.js numbers them, as unit
 * vectors pointing out of the voxel.
 */
export const FACE_DIRS = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

/**
 * A floor on the blurred gradient, below which it is noise rather than a
 * direction.
 *
 * It used to carry the whole job of telling a slope from the edge between two
 * flat faces, because both lean the same way and only their strength differs -
 * a 45-degree plane reads 0.509 at radius 2, a flat face 0.400, a convex edge
 * 0.339. Setting it high enough to exclude the edge also excluded half the
 * real slopes, so the caller now asks the lattice directly whether there is a
 * step above or below, and this is back to being what its name says.
 */
const SLOPED = 0.20;

/** The two vertical face directions, and the four a view draws head-on. */
const UP = 2;
const DOWN = 3;
const UPRIGHT = [0, 1, 4, 5];

/** How close two directions have to be before the choice counts as tied. */
const TIE = 0.08;

/**
 * Which face direction the surface at a voxel most nearly points along.
 *
 * One answer per point, not per face, and that is the point: on a slope the
 * flat tread and the upright riser share a surface direction, so they make the
 * same choice and stop disagreeing. Both being slightly wrong together beats
 * one of them being right.
 *
 * A windscreen at forty-five degrees leaves the choice genuinely tied, and
 * there the upright drawings win. They are where the artist put the detail -
 * glass, grille, door - while a top view is mostly a plan outline, and it
 * keeps a model looked at head-on showing what was drawn head-on.
 *
 * @param {{grad: (x: number, y: number, z: number) => number[] | null}} field
 * @returns {number} face index, or -1 when the surface direction is unreadable
 */
export function facingOf(field, x, y, z) {
  const g = field.grad(x, y, z);
  if (!g) return -1;
  // Density rises into the solid, so the outward direction runs against it.
  const n = [-g[0], -g[1], -g[2]];
  const len = Math.hypot(n[0], n[1], n[2]);
  // Direction alone cannot tell a slope from the edge where two flat faces
  // meet: on the top-front edge of a plain cube the blurred gradient points
  // the same way a 45-degree wedge does, so the edge asks to be recoloured by
  // a drawing that is not looking at it. Strength can tell them apart, and
  // this is where the white corners and the white flecks came from. Measured
  // at radius 2: a true 45-degree plane 0.509, a 2:1 slope 0.447, a flat face
  // 0.400, a convex edge 0.339, a convex corner 0.249, a concave one 0.226.
  if (len < SLOPED) return -1;

  const dots = new Array(6);
  let maxDot = -Infinity;
  let maxDir = -1;
  for (let d = 0; d < 6; d++) {
    const dir = FACE_DIRS[d];
    dots[d] = (n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2]) / len;
    if (dots[d] > maxDot) {
      maxDot = dots[d];
      maxDir = d;
    }
  }

  // The slack has exactly one job: when a slope is as much "up" as it is
  // "forward", the upright drawing wins, because that is where the artist put
  // the glass and the grille. Letting it also arbitrate between two upright
  // directions - which the first version did, by writing the slacker value
  // back as the best - turned it into a drift towards +Z that disagreed with
  // the true maximum on 11% of directions, always the same way.
  if (maxDir === UP || maxDir === DOWN) {
    let bestUp = -1;
    let bestUpDot = -Infinity;
    for (const d of UPRIGHT) {
      if (dots[d] > bestUpDot) {
        bestUpDot = dots[d];
        bestUp = d;
      }
    }
    if (bestUpDot > maxDot - TIE) return bestUp;
  }
  return maxDir;
}
