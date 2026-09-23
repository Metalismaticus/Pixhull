// @ts-check
/**
 * Smooth mesh generation over the same voxel volume (naive surface nets).
 *
 * The carve is a lattice and always will be - that is what shape-from-silhouette
 * on a grid produces. But nothing forces the *exported mesh* to be cubes. Surface
 * nets place one vertex per grid cell the surface passes through, positioned at
 * the average of the edge crossings, which turns a staircase into a rounded
 * low-poly shell. Same voxels, same palette, model a game engine is happy with.
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
 * @param {import('../core/volume.js').Volume} vol
 * @param {{relax?: number}} [opts] Laplacian passes; 0 is plain surface nets
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

        // Average the midpoints of every edge whose two corners disagree.
        // Occupancy is binary, so a crossing always sits at the midpoint.
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of CUBE_EDGES) {
          const inA = (mask >> a) & 1;
          const inB = (mask >> b) & 1;
          if (inA === inB) continue;
          sx += ((a & 1) + (b & 1)) / 2;
          sy += (((a >> 1) & 1) + ((b >> 1) & 1)) / 2;
          sz += (((a >> 2) & 1) + ((b >> 2) & 1)) / 2;
          n++;
        }
        if (n === 0) continue;

        // Corner c of this cell is the centre of voxel (i + bit, ...), which in
        // world units is i + bit + 0.5.
        cellVertex.set(cellId(i, j, k), verts.length / 3);
        verts.push(i + 0.5 + sx / n, j + 0.5 + sy / n, k + 0.5 + sz / n);
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

  if (relax > 0) relaxVertices(verts, byMaterial, relax);

  return { verts, byMaterial, quads };
}

/**
 * Laplacian smoothing: pull every vertex halfway towards the average of the
 * vertices it shares a quad with. Rounds off what surface nets leaves, at the
 * cost of a little shrinkage.
 *
 * Adjacency is kept as two flat arrays rather than a Set per vertex. On a
 * detailed model this is hundreds of thousands of vertices, and allocating a
 * Set for each one was enough to lock the tab up for the length of a coffee
 * break the moment the rounding slider moved off zero.
 *
 * An edge shared by two quads is listed twice, which weights shared edges a
 * little more heavily. That is a standard variant of the smoothing and not
 * worth a deduplication pass to avoid.
 *
 * @param {number[]} verts
 * @param {Map<number, number[][]>} byMaterial
 * @param {number} passes
 */
function relaxVertices(verts, byMaterial, passes) {
  const count = verts.length / 3;

  let edges = 0;
  for (const list of byMaterial.values()) edges += list.length * 8; // 4 edges, both ways

  // Counting sort into CSR: how many neighbours each vertex has, then where
  // its run starts, then the neighbours themselves.
  const starts = new Int32Array(count + 1);
  for (const list of byMaterial.values()) {
    for (const quad of list) {
      for (let i = 0; i < 4; i++) {
        starts[quad[i] - 1 + 1]++;
        starts[quad[(i + 1) % 4] - 1 + 1]++;
      }
    }
  }
  for (let i = 0; i < count; i++) starts[i + 1] += starts[i];

  const cursor = starts.slice(0, count);
  const neighbours = new Int32Array(edges);
  for (const list of byMaterial.values()) {
    for (const quad of list) {
      for (let i = 0; i < 4; i++) {
        const a = quad[i] - 1;
        const b = quad[(i + 1) % 4] - 1;
        neighbours[cursor[a]++] = b;
        neighbours[cursor[b]++] = a;
      }
    }
  }

  const next = new Float64Array(verts.length);
  const current = Float64Array.from(verts);
  for (let pass = 0; pass < passes; pass++) {
    for (let v = 0; v < count; v++) {
      const from = starts[v];
      const to = starts[v + 1];
      const k = to - from;
      if (k === 0) {
        next[v * 3] = current[v * 3];
        next[v * 3 + 1] = current[v * 3 + 1];
        next[v * 3 + 2] = current[v * 3 + 2];
        continue;
      }
      let sx = 0, sy = 0, sz = 0;
      for (let i = from; i < to; i++) {
        const n = neighbours[i] * 3;
        sx += current[n];
        sy += current[n + 1];
        sz += current[n + 2];
      }
      next[v * 3] = (current[v * 3] + sx / k) / 2;
      next[v * 3 + 1] = (current[v * 3 + 1] + sy / k) / 2;
      next[v * 3 + 2] = (current[v * 3 + 2] + sz / k) / 2;
    }
    current.set(next);
  }

  for (let i = 0; i < verts.length; i++) verts[i] = current[i];
}
