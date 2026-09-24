// @ts-check
/**
 * Baked light and the viewport's shading are the same six numbers.
 *
 * They have to be copied rather than shared: the tints live inside a GLSL
 * string in `src/gfx/renderer.js`, a module that needs a WebGL2 context, and
 * `src/core` may not depend on the DOM (`CLAUDE.md`, "Правила проекта"). A copy
 * nobody checks is a copy that drifts, and the drift would be invisible in the
 * worst way: the model on screen would stop matching the model in the `.obj`
 * the bake just wrote, and neither would look wrong on its own.
 *
 * So this check reads the shader source as text and compares.
 *
 * How it goes red: change one number in `SHADE[6]` in the vertex shader, or in
 * `FACE_SHADE`, and the pair that drifted is named with both values.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { FACE_SHADE } from '../../src/core/bake.js';

export async function run() {
  const src = await readFile(fileURLToPath(new URL('../../src/gfx/renderer.js', import.meta.url)), 'utf8');
  const m = src.match(/SHADE\[6\]\s*=\s*float\[6\]\(([^)]*)\)/);
  if (!m) {
    return { ok: false, detail: 'no SHADE[6] array found in src/gfx/renderer.js' };
  }
  const shader = m[1].split(',').map((s) => Number(s.trim()));

  /** @type {string[]} */
  const bad = [];
  if (shader.length !== FACE_SHADE.length) {
    bad.push('length ' + shader.length + ' vs ' + FACE_SHADE.length);
  }
  for (let d = 0; d < Math.min(shader.length, FACE_SHADE.length); d++) {
    if (shader[d] !== FACE_SHADE[d]) bad.push('dir ' + d + ': shader ' + shader[d] + ' vs bake ' + FACE_SHADE[d]);
  }

  return {
    ok: bad.length === 0,
    detail: bad.length === 0
      ? shader.length + ' tints identical: ' + shader.join(' ')
      : bad.length + ' drifted: ' + bad.join('; '),
  };
}
