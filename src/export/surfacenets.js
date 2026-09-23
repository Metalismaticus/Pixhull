// @ts-check
/**
 * Smooth mesh generation over the same voxel volume (dual contouring).
 *
 * The carve is a lattice and always will be - that is what shape-from-silhouette
 * on a grid produces. But nothing forces the *exported mesh* to be cubes. One
 * vertex is placed per grid cell the surface passes through, and where it goes
 * in that cell is the whole question. Same voxels, same palette, a model a game
 * engine is happy with.
 *
 * At the average of the edge crossings - plain surface nets - the result is
 * still visibly a staircase, and the obvious cure, dragging every vertex
 * towards its neighbours, cannot tell a staircase from a corner: it rounded
 * the sloped windscreen of a lorry and the square corner of its box body by
 * the same amount, so the cab stayed stepped and the body started to sag.
 *
 * Dual contouring asks a better question. Give each crossing the direction the
 * surface faces there and put the vertex where all those planes meet. A
 * staircase standing in for a slope has one normal direction, so its vertices
 * slide onto the slope and the steps vanish; a corner has two or three, which
 * pin the vertex to the corner and keep it sharp. Nobody has to label which is
 * which. The directions come from a blurred copy of the occupancy, because a
 * binary lattice on its own only knows six of them.
 *
 * The dual grid: a cell sits between eight voxel centres. If those eight are not
 * all solid or all empty, the surface crosses the cell and it gets a vertex.
 * Quads come from voxel edges where solidity changes - the four cells around
 * such an edge form one face.
 *
 * Colour is free here: the quad for an edge between a solid and an empty voxel
 * is exactly the face Pixhull already painted, so smoothing loses geometry
 * detail but never loses a colour.
 */

/**
 * @typedef {Object} SmoothMesh
 * @property {number[]} verts flat x, y, z triples in voxel units
 * @property {Map<number, number[][]>} byMaterial palette index -> quads of vertex ids (1-based)
 * @property {number} quads
 */

/** The 12 edges of a cube, as pairs of corner indices (bit 0 = x, 1 = y, 2 = z). */
const CUBE_EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/**
 * Occupancy blurred into a density field over the model's bounding box.
 *
 * A binary lattice has only six normals, and a surface built from them is
 * blocky by construction - which is why the first attempt at rounding had to
 * drag every vertex towards its neighbours and rounded the corners of the box
 * body as eagerly as the slope of a windscreen. Blurring first gives the
 * surface a *gradient*: across a staircase the density falls off along the
 * slope, so the normals there all point the same way, while at a real corner
 * they stay in two distinct groups. That difference is what lets the vertex
 * solver below tell a corner from a staircase.
 *
 * Three separable passes with a running sum, so cost does not grow with the
 * radius.
 *
 * @param {import('../core/volume.js').Volume} vol
 * @param {{min: number[], max: number[]}} box
 * @param {number} radius
 */
function densityField(vol, box, radius) {
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
    /** Gradient at a voxel centre, in voxel-index space. */
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
 * Where to put a cell's vertex, given the crossings and the surface normals
 * there: at the point that lies on all of their planes at once, or as close
 * to it as a point can get.
 *
 * On a flat face every normal is the same and the planes coincide, so the
 * problem is rank one - the solution is free to slide along the face, and the
 * pull towards the average crossing decides where. On a staircase the blurred
 * normals all follow the slope, so the same thing happens and the vertex lands
 * on the slope rather than on the step: the staircase melts. At a genuine
 * corner two or three normals disagree, the problem gains rank, and the only
 * point on all the planes is the corner itself - which is why the box body
 * keeps its edges while the cab rounds off, without anyone labelling either.
 *
 * @param {number[][]} normals @param {number[][]} points @param {number[]} mass
 */
function solveVertex(normals, points, mass) {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  for (let i = 0; i < normals.length; i++) {
    const n = normals[i];
    const d = n[0] * points[i][0] + n[1] * points[i][1] + n[2] * points[i][2];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) A[r][c] += n[r] * n[c];
      b[r] += n[r] * d;
    }
  }
  // The pull towards the average crossing. It fixes the directions the normals
  // say nothing about, and nothing else: on a corner, where they say
  // everything, it is swamped.
  const W = 0.08;
  for (let r = 0; r < 3; r++) {
    A[r][r] += W;
    b[r] += W * mass[r];
  }

  const m = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    const swap = m[col];
    m[col] = m[pivot];
    m[pivot] = swap;
    if (Math.abs(m[col][col]) < 1e-9) continue;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c < 4; c++) m[r][c] -= f * m[col][c];
    }
  }
  const out = [0, 1, 2].map((i) => (Math.abs(m[i][i]) < 1e-9 ? mass[i] : m[i][3] / m[i][i]));
  return out.map((v, i) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : mass[i]));
}

/**
 * @param {import('../core/volume.js').Volume} vol
 * @param {{relax?: number}} [opts] 0 is plain surface nets; above that, how far
 *   the density is blurred before the normals are read off it
 * @returns {SmoothMesh}
 */
export function buildSmoothMesh(vol, opts = {}) {
  const relax = Math.max(0, Math.min(8, Math.round(opts.relax ?? 0)));

  // Dual cell (i, j, k) has the centres of voxels (i..i+1, j..j+1, k..k+1) as
  // its corners, so i runs from -1 to nx-1. Shift by one to index from zero.
  const dx = vol.nx + 1;
  const dy = vol.ny + 1;
  const cellId = (i, j, k) => (i + 1) + dx * ((j + 1) + dy * (k + 1));

  /** @type {Map<number, number>} dual cell -> vertex id (0-based) */
  const cellVertex = new Map();
  /** @type {number[]} */
  const verts = [];

  const box = vol.bounds();
  if (!box) return { verts: [], byMaterial: new Map(), quads: 0 };
  const field = relax > 0 ? densityField(vol, box, Math.min(4, relax)) : null;

  // Only cells touching the model can straddle the surface.
  for (let k = box.min[2] - 1; k <= box.max[2]; k++) {
    for (let j = box.min[1] - 1; j <= box.max[1]; j++) {
      for (let i = box.min[0] - 1; i <= box.max[0]; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const solid = vol.get(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1));
          if (solid) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;

        // Every edge whose two corners disagree is crossed by the surface, and
        // occupancy being binary, a crossing always sits at the midpoint.
        let sx = 0, sy = 0, sz = 0, n = 0;
        const points = [];
        const normals = [];
        for (const [a, b] of CUBE_EDGES) {
          const inA = (mask >> a) & 1;
          const inB = (mask >> b) & 1;
          if (inA === inB) continue;
          const px = ((a & 1) + (b & 1)) / 2;
          const py = (((a >> 1) & 1) + ((b >> 1) & 1)) / 2;
          const pz = (((a >> 2) & 1) + ((b >> 2) & 1)) / 2;
          sx += px;
          sy += py;
          sz += pz;
          n++;
          if (!field) continue;
          const ga = field.grad(i + (a & 1), j + ((a >> 1) & 1), k + ((a >> 2) & 1));
          const gb = field.grad(i + (b & 1), j + ((b >> 1) & 1), k + ((b >> 2) & 1));
          if (!ga || !gb) continue;
          // Density rises into the solid, so the outward normal runs against
          // the gradient. The sign cancels in the solver; consistency does not.
          const gx = -(ga[0] + gb[0]);
          const gy = -(ga[1] + gb[1]);
          const gz = -(ga[2] + gb[2]);
          const len = Math.hypot(gx, gy, gz);
          if (len < 1e-6) continue;
          normals.push([gx / len, gy / len, gz / len]);
          points.push([px, py, pz]);
        }
        if (n === 0) continue;

        const mass = [sx / n, sy / n, sz / n];
        const local = normals.length >= 2 ? solveVertex(normals, points, mass) : mass;

        // Corner c of this cell is the centre of voxel (i + bit, ...), which in
        // world units is i + bit + 0.5.
        cellVertex.set(cellId(i, j, k), verts.length / 3);
        verts.push(i + 0.5 + local[0], j + 0.5 + local[1], k + 0.5 + local[2]);
      }
    }
  }

  /** @type {Map<number, number[][]>} */
  const byMaterial = new Map();
  let quads = 0;

  /** @param {number} color @param {number[]} quad */
  const emit = (color, quad) => {
    if (quad.some((v) => v === undefined)) return;
    let list = byMaterial.get(color);
    if (!list) byMaterial.set(color, (list = []));
    // OBJ vertex ids are 1-based.
    list.push(quad.map((v) => v + 1));
    quads++;
  };

  // One quad per voxel edge whose ends differ in solidity. The four dual cells
  // around that edge are the ones offset by 0 or -1 in the two other axes.
  for (let z = box.min[2] - 1; z <= box.max[2] + 1; z++) {
    for (let y = box.min[1] - 1; y <= box.max[1] + 1; y++) {
      for (let x = box.min[0] - 1; x <= box.max[0] + 1; x++) {
        const here = vol.get(x, y, z);
        for (let axis = 0; axis < 3; axis++) {
          const nx = x + (axis === 0 ? 1 : 0);
          const ny = y + (axis === 1 ? 1 : 0);
          const nz = z + (axis === 2 ? 1 : 0);
          const there = vol.get(nx, ny, nz);
          if (here === there) continue;

          // The painted face is on whichever voxel is solid, pointing at the
          // other one.
          const color = here
            ? vol.getFace(x, y, z, axis * 2)
            : vol.getFace(nx, ny, nz, axis * 2 + 1);
          if (color === 0) continue;

          // The four dual cells sharing this edge sit at the voxel's own
          // coordinate along `axis`, and one step back or not in the other two.
          // Ordering pa, pb so that pa × pb points along +axis keeps the
          // winding below correct without a special case per axis.
          const [pa, pb] = axis === 0 ? [1, 2] : axis === 1 ? [2, 0] : [0, 1];
          const corner = (da, db) => {
            const c = [x, y, z];
            c[pa] += da;
            c[pb] += db;
            return cellVertex.get(cellId(c[0], c[1], c[2]));
          };
          const v00 = corner(-1, -1);
          const v10 = corner(0, -1);
          const v11 = corner(0, 0);
          const v01 = corner(-1, 0);

          // Wind so the normal points away from the solid side.
          emit(color, here ? [v00, v10, v11, v01] : [v00, v01, v11, v10]);
        }
      }
    }
  }

  return { verts, byMaterial, quads };
}

