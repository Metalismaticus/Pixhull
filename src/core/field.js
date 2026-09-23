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
 */
export function densityField(vol, box, radius) {
  const pad = radius + 2;
  const ox = box.min[0] - pad;
  const oy = box.min[1] - pad;
  const oz = box.min[2] - pad;
  const nx = box.max[0] - box.min[0] + 1 + 2 * pad;
  const ny = box.max[1] - box.min[1] + 1 + 2 * pad;
  const nz = box.max[2] - box.min[2] + 1 + 2 * pad;
  const data = new Float32Array(nx * ny * nz);
  const at = (i, j, k) => (k * ny + j) * nx + i;

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (vol.get(ox + i, oy + j, oz + k)) data[at(i, j, k)] = 1;
      }
    }
  }

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
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) blur(at(0, j, k), 1, nx);
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) blur(at(i, 0, k), nx, ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) blur(at(i, j, 0), nx * ny, nz);

  return {
    /** Gradient at a voxel centre, in voxel-index space; null outside the box. */
    grad(x, y, z) {
      const i = x - ox;
      const j = y - oy;
      const k = z - oz;
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
  if (len < 1e-6) return -1;

  let best = -1;
  let bestDot = -Infinity;
  for (let d = 0; d < 6; d++) {
    const dir = FACE_DIRS[d];
    const dot = (n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2]) / len;
    // Upright directions are tried first and keep a tie, so a 45-degree slope
    // resolves to the drawing that carries the detail.
    const upright = d !== 2 && d !== 3;
    if (dot > bestDot + (upright ? -TIE : TIE)) {
      bestDot = dot;
      best = d;
    }
  }
  return bestDot > 0 ? best : -1;
}
