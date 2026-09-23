// @ts-check
/**
 * Turning a click into a voxel and a face.
 *
 * Done on the CPU with a grid walk rather than with a GPU picking buffer: the
 * volume is already in memory, the walk is a handful of adds per voxel, and it
 * avoids a readback stall on every mouse move. It also gives the exact face
 * that was entered, which face painting needs and a colour buffer would not.
 */

/**
 * World-space direction of a view-space vector (rotation only, no translation).
 * The view matrix is rotX(-pitch) · rotY(-yaw) · T, so its inverse rotation is
 * rotY(yaw) · rotX(pitch).
 * @param {import('../gfx/camera.js').OrthoCamera} camera
 * @returns {[number, number, number]}
 */
function viewDirToWorld(camera, vx, vy, vz) {
  const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
  const x = vx;
  const y = cp * vy - sp * vz;
  const z = sp * vy + cp * vz;
  const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
  return [cy * x + sy * z, y, -sy * x + cy * z];
}

/**
 * A ray through one device pixel. For an orthographic camera the direction is
 * constant and only the origin moves.
 * @param {import('../gfx/camera.js').OrthoCamera} camera
 * @param {number} px device pixels from the left
 * @param {number} py device pixels from the top
 * @param {number} W @param {number} H drawing buffer size
 * @returns {{origin: [number, number, number], dir: [number, number, number]}}
 */
export function screenRay(camera, px, py, W, H) {
  const hw = W / (2 * camera.pixelsPerVoxel);
  const hh = H / (2 * camera.pixelsPerVoxel);
  const ox = camera.panX / camera.pixelsPerVoxel;
  const oy = camera.panY / camera.pixelsPerVoxel;

  const ndcX = (px / W) * 2 - 1;
  const ndcY = 1 - (py / H) * 2;
  const viewX = ndcX * hw - ox;
  const viewY = ndcY * hh - oy;

  const dir = viewDirToWorld(camera, 0, 0, -1);
  // Start well behind the camera so the whole grid is always ahead of us.
  const back = 4 * Math.max(W, H);
  const p = viewDirToWorld(camera, viewX, viewY, back);
  return {
    origin: [p[0] + camera.target[0], p[1] + camera.target[1], p[2] + camera.target[2]],
    dir,
  };
}

/**
 * Where a ray meets an axis-aligned plane.
 *
 * Box dragging uses this rather than a second voxel hit: the pointer regularly
 * leaves the model mid-drag, and the plane of the face you started on is always
 * there to land on, so the rectangle keeps growing instead of freezing at the
 * silhouette.
 *
 * @param {[number, number, number]} origin
 * @param {[number, number, number]} dir
 * @param {number} axis 0, 1 or 2
 * @param {number} coord plane position along that axis
 * @returns {[number, number, number] | null} null when the ray is parallel or points away
 */
export function rayPlanePoint(origin, dir, axis, coord) {
  if (Math.abs(dir[axis]) < 1e-9) return null;
  const t = (coord - origin[axis]) / dir[axis];
  if (!Number.isFinite(t)) return null;
  return [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
}

/**
 * Slab test against the grid's bounding box.
 * @returns {[number, number] | null} entry and exit distance along the ray
 */
function intersectGrid(o, d, nx, ny, nz) {
  const max = [nx, ny, nz];
  let t0 = -Infinity;
  let t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) {
      if (o[a] < 0 || o[a] > max[a]) return null;
      continue;
    }
    let ta = (0 - o[a]) / d[a];
    let tb = (max[a] - o[a]) / d[a];
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

/**
 * Amanatides & Woo grid traversal: step to the next voxel boundary along
 * whichever axis is nearest, so every voxel the ray passes through is visited
 * exactly once.
 *
 * @param {import('../core/volume.js').Volume} vol
 * @param {[number, number, number]} origin
 * @param {[number, number, number]} dir
 * @returns {{x: number, y: number, z: number, face: number} | null}
 */
export function raycastVoxel(vol, origin, dir) {
  const span = intersectGrid(origin, dir, vol.nx, vol.ny, vol.nz);
  if (!span) return null;

  const tEnter = Math.max(span[0], 0);
  // Nudge inside so the starting cell is unambiguous on an exact boundary hit.
  const p = [
    origin[0] + dir[0] * (tEnter + 1e-4),
    origin[1] + dir[1] * (tEnter + 1e-4),
    origin[2] + dir[2] * (tEnter + 1e-4),
  ];

  const cell = [Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2])];
  const step = [0, 0, 0];
  const tMax = [Infinity, Infinity, Infinity];
  const tDelta = [Infinity, Infinity, Infinity];

  for (let a = 0; a < 3; a++) {
    if (dir[a] > 1e-12) {
      step[a] = 1;
      tMax[a] = (cell[a] + 1 - p[a]) / dir[a];
      tDelta[a] = 1 / dir[a];
    } else if (dir[a] < -1e-12) {
      step[a] = -1;
      tMax[a] = (cell[a] - p[a]) / dir[a];
      tDelta[a] = -1 / dir[a];
    }
  }

  // The face we entered the first cell through comes from whichever slab the
  // ray was still outside of longest.
  let axis = 0;
  let bestT = -Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(dir[a]) < 1e-12) continue;
    const t = ((step[a] > 0 ? 0 : [vol.nx, vol.ny, vol.nz][a]) - origin[a]) / dir[a];
    if (t > bestT) { bestT = t; axis = a; }
  }

  const limit = 4 * (vol.nx + vol.ny + vol.nz);
  for (let i = 0; i < limit; i++) {
    if (!vol.inBounds(cell[0], cell[1], cell[2])) return null;
    if (vol.get(cell[0], cell[1], cell[2])) {
      return {
        x: cell[0],
        y: cell[1],
        z: cell[2],
        // Stepping in +X enters through the voxel's -X face, and so on.
        face: axis * 2 + (step[axis] > 0 ? 1 : 0),
      };
    }
    axis = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
    if (step[axis] === 0) return null;
    cell[axis] += step[axis];
    tMax[axis] += tDelta[axis];
  }
  return null;
}
