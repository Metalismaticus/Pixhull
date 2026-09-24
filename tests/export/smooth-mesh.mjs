// @ts-check
/**
 * The smooth mesh must be a closed surface, not a picture that happens to look
 * closed: the same `buildSmoothMesh` goes into the viewport, into `.obj` and
 * into `.glb`, so a hole here is a hole in the product's output.
 *
 * Five things are asked of every mesh, and every one of them is a number the
 * mesh either has or has not got:
 *
 * - every exposed voxel face becomes a quad - a face the builder drops is a
 *   hole straight through the shell, with the dark inside showing through it;
 * - no exposed face is left carrying palette index 0, which is what makes the
 *   builder drop a quad in the first place;
 * - every mesh edge is used by exactly two quads (closed, and not a seam where
 *   three meet);
 * - every mesh edge is used once in each direction (one consistent outside,
 *   which is what back-face culling in the viewport depends on);
 * - no quad is degenerate *in space* - no two of its corners at the same point
 *   and no zero area - because a quad collapsed to a line or a point has no
 *   normal, and `src/gfx/renderer.js:258` divides by `|| 1` and draws it black;
 *   the same face leaves the product in the `.obj` and the `.glb`. Comparing
 *   vertex ids would not see it: the ids differ, the coordinates do not;
 * - the enclosed volume is positive and within a tenth of the voxel count - a
 *   mesh turned inside out or folded through itself fails this even when the
 *   edge counts pass.
 *
 * Rounding runs over the whole slider, 0 to 6 (`index.html:209`), and not only
 * over its ends: the collapse below happens at 1 and nowhere else.
 *
 * Red without the fix, twice over, both measured 2026-09-24:
 *
 * - take the `healAround` call out of the `erase` branch of `src/edit/tools.js`
 *   and the edit case fails at once with `265 quads missing on cube after
 *   erasing 300 relax=0` - erasing uncovers faces that no drawing ever painted,
 *   265 of the cube's 2640 exposed faces stay at index 0, those 265 quads are
 *   dropped and 20 edges end up used by one quad instead of two. The carve
 *   cases stay green in that state, which is the point of having both: the
 *   carve fills every face through `inferMissingFaces`, the editor has to keep
 *   doing it afterwards;
 * - put `CELL_MARGIN` in `src/export/surfacenets.js` back to 0 and the fin - a
 *   wall one voxel thick - fails at rounding 1 with `48 quads with two corners
 *   at the same point on fin relax=1`; 34 of those 880 quads also have zero
 *   area, and the rounding notches either side of 1 stay clean.
 *
 * The lorry the defect was reported on is not here on purpose: the test bench
 * takes no one's art (`docs/TESTING.md`). Measured by hand the same day on
 * `tests/art/truck.png` - its six views cut out of the sheet and carved at 256
 * with nothing mirrored - 160 914 exposed faces, 160 914 quads, 0 at index 0,
 * 0 open edges at rounding 0, 3 and 6. At rounding 6, before `CELL_MARGIN`, 2
 * of those quads had two corners at the same point and 3 had zero area, and
 * 10 of the triangles the quads split into had no normal; 0, 0 and 0 after.
 * Roundings 1 and 2 were dirtier still - 42 and 6 quads with two corners at
 * the same point - and the same three counts came out at 4, 5 and 6. The lorry is dirty input (a render, 45 709 colours), but the
 * same collapse reproduces on the synthetic fin, so it is the product's.
 */

import { carve } from '../../src/core/carve.js';
import { Palette } from '../../src/core/palette.js';
import { DIRS } from '../../src/core/volume.js';
import { buildSmoothMesh } from '../../src/export/surfacenets.js';
import { applyTool } from '../../src/edit/tools.js';
import { SHAPES, viewsOfShape } from '../fixtures.mjs';

const N = 20;

/**
 * @param {import('../../src/core/volume.js').Volume} vol
 * @param {import('../../src/export/surfacenets.js').SmoothMesh} mesh
 */
function inspect(vol, mesh) {
  let exposed = 0;
  let unpainted = 0;
  vol.forEachSolid((x, y, z) => {
    for (let d = 0; d < 6; d++) {
      const [dx, dy, dz] = DIRS[d];
      if (vol.get(x + dx, y + dy, z + dz)) continue;
      exposed++;
      if (vol.getFace(x, y, z, d) === 0) unpainted++;
    }
  });

  /** @type {Map<string, number>} undirected edge -> quads using it */
  const shared = new Map();
  /** @type {Map<string, number>} directed edge -> quads using it that way */
  const oriented = new Map();
  let coincident = 0;
  let zeroArea = 0;
  let minArea = Infinity;
  let volume6 = 0;
  const P = mesh.verts;
  const at = (id) => [P[(id - 1) * 3], P[(id - 1) * 3 + 1], P[(id - 1) * 3 + 2]];

  for (const quads of mesh.byMaterial.values()) {
    for (const quad of quads) {
      for (let i = 0; i < 4; i++) {
        const a = quad[i];
        const b = quad[(i + 1) % 4];
        const und = a < b ? a + ':' + b : b + ':' + a;
        shared.set(und, (shared.get(und) ?? 0) + 1);
        const dir = a + '>' + b;
        oriented.set(dir, (oriented.get(dir) ?? 0) + 1);
      }
      // Degeneracy is asked of the corners' coordinates, not of their ids: two
      // neighbouring cells can hold different vertices at the same point, and
      // that quad is as collapsed as one with a repeated id.
      const c = quad.map(at);
      let same = false;
      for (let i = 0; i < 4; i++) {
        for (let j = i + 1; j < 4; j++) {
          if (c[i][0] === c[j][0] && c[i][1] === c[j][1] && c[i][2] === c[j][2]) same = true;
        }
      }
      if (same) coincident++;

      // Signed volume by the divergence theorem, over the two triangles; the
      // same cross products give the area the renderer needs a normal from.
      let area = 0;
      for (const [i, j, k] of [[0, 1, 2], [0, 2, 3]]) {
        const u = [c[j][0] - c[i][0], c[j][1] - c[i][1], c[j][2] - c[i][2]];
        const v = [c[k][0] - c[i][0], c[k][1] - c[i][1], c[k][2] - c[i][2]];
        const n = [
          u[1] * v[2] - u[2] * v[1],
          u[2] * v[0] - u[0] * v[2],
          u[0] * v[1] - u[1] * v[0],
        ];
        volume6 += c[i][0] * n[0] + c[i][1] * n[1] + c[i][2] * n[2];
        area += Math.hypot(n[0], n[1], n[2]) / 2;
      }
      if (area === 0) zeroArea++;
      if (area < minArea) minArea = area;
    }
  }

  let openEdges = 0;
  for (const n of shared.values()) if (n !== 2) openEdges++;
  let flipped = 0;
  for (const n of oriented.values()) if (n !== 1) flipped++;

  return {
    exposed,
    unpainted,
    dropped: exposed - mesh.quads,
    openEdges,
    flipped,
    coincident,
    zeroArea,
    minArea: Number.isFinite(minArea) ? minArea : 0,
    volume: volume6 / 6,
  };
}

/**
 * What a quad collapsed in space is called, wherever it is found.
 *
 * @param {ReturnType<typeof inspect>} m
 * @param {string} where
 */
function collapsed(m, where) {
  if (m.coincident !== 0) return m.coincident + ' quads with two corners at the same point on ' + where;
  if (m.zeroArea !== 0) return m.zeroArea + ' quads of zero area on ' + where;
  return null;
}

/**
 * @param {ReturnType<typeof inspect>} m
 * @param {import('../../src/core/volume.js').Volume} vol
 * @param {string} where
 */
function check(m, vol, where) {
  if (m.dropped !== 0) return m.dropped + ' quads missing on ' + where;
  if (m.unpainted !== 0) return m.unpainted + ' exposed faces at index 0 on ' + where;
  if (m.openEdges !== 0) return m.openEdges + ' edges not shared by two quads on ' + where;
  if (m.flipped !== 0) return m.flipped + ' edges wound the same way twice on ' + where;
  const flat = collapsed(m, where);
  if (flat) return flat;
  // A closed mesh over the same voxels encloses about the same volume; the
  // rounding shaves the corners, so allow a tenth either way.
  if (!(m.volume > vol.solidCount * 0.9) || m.volume > vol.solidCount * 1.1) {
    return 'encloses ' + m.volume.toFixed(0) + ' against ' + vol.solidCount + ' voxels on ' + where;
  }
  return null;
}

/** Rounding notches the full inspection runs on; the collapse test runs on all. */
const FULL = [0, 3, 6];
/** The slider's range, `index.html:209`. */
const NOTCHES = [0, 1, 2, 3, 4, 5, 6];

export function run() {
  /** @type {[string, import('../../src/core/volume.js').Volume][]} */
  const cases = [];

  for (const name of ['cube', 'wedge', 'step', 'fin', 'cab']) {
    const palette = new Palette();
    const { volume } = carve(viewsOfShape(N, SHAPES[name](N)), N, palette, { mirrorMissing: false });
    cases.push([name, volume]);
  }

  // The editor has to keep the shell closed too: erasing uncovers faces that
  // were buried when the carve painted, and a buried face has never been
  // painted at all.
  const palette = new Palette();
  const { volume: edited } = carve(viewsOfShape(N, SHAPES.cube(N)), N, palette, { mirrorMissing: false });
  const colour = palette.slots()[0] ?? 1;
  let erased = 0;
  for (let step = 0; step < 4; step++) {
    erased += applyTool(edited, { x: N >> 1, y: N >> 1, z: N - 1 - step * 3, face: 4 },
      { tool: 'erase', color: colour, brush: 2 }).count;
  }
  if (erased === 0) return { ok: false, detail: 'the eraser touched nothing; the edit case measures nothing' };
  cases.push(['cube after erasing ' + erased, edited]);

  let meshes = 0;
  let minArea = Infinity;
  for (const [label, vol] of cases) {
    for (const relax of NOTCHES) {
      const m = inspect(vol, buildSmoothMesh(vol, { relax }));
      const where = label + ' relax=' + relax;
      meshes++;
      if (m.minArea < minArea) minArea = m.minArea;
      // Every notch of the slider has to give a mesh that is not collapsed in
      // space - that is where the black faces come from, and the fin only
      // collapses at 1. The rest of the inspection costs more and runs on the
      // ends and the middle.
      const flat = collapsed(m, where);
      if (flat) return { ok: false, detail: flat };
      if (!FULL.includes(relax)) continue;
      const bad = check(m, vol, where);
      if (bad) return { ok: false, detail: bad };
    }
  }

  return {
    ok: true,
    detail: meshes + ' meshes over rounding 0-6, ' + (cases.length * FULL.length)
      + ' of them inspected whole: 0 quads missing, 0 faces at index 0, 0 open edges, '
      + '0 flipped edges, 0 collapsed quads; smallest quad ' + minArea.toExponential(2)
      + ' of a voxel face',
  };
}
