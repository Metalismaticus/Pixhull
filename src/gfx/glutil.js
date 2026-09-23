// @ts-check
/** Minimal WebGL2 + mat4 helpers. No dependencies on purpose: pixel-exact
 *  output needs exact control over the projection, and a general-purpose 3D
 *  library mostly gets in the way of that. */

/**
 * @param {WebGL2RenderingContext} gl
 * @param {number} type
 * @param {string} src
 * @returns {WebGLShader}
 */
function compile(gl, type, src) {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile failed:\n' + log + '\n---\n' + numbered(src));
  }
  return sh;
}

function numbered(src) {
  return src.split('\n').map((l, i) => String(i + 1).padStart(3) + '| ' + l).join('\n');
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {string} vsSrc
 * @param {string} fsSrc
 * @returns {WebGLProgram}
 */
export function createProgram(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  if (!p) throw new Error('createProgram failed');
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error('Program link failed: ' + log);
  }
  return p;
}

/**
 * Collect uniform locations by name.
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLProgram} program
 * @param {string[]} names
 * @returns {Record<string, WebGLUniformLocation|null>}
 */
export function uniforms(gl, program, names) {
  /** @type {Record<string, WebGLUniformLocation|null>} */
  const out = {};
  for (const n of names) out[n] = gl.getUniformLocation(program, n);
  return out;
}

// ---------------------------------------------------------------------------
// mat4, column-major to match GLSL
// ---------------------------------------------------------------------------

export function mat4Identity(out = new Float32Array(16)) {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

/**
 * @param {Float32Array} a @param {Float32Array} b @param {Float32Array} [out] computes out = a * b
 */
export function mat4Mul(a, b, out = new Float32Array(16)) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    out[c * 4 + 0] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

export function mat4Translate(x, y, z, out = new Float32Array(16)) {
  mat4Identity(out);
  out[12] = x; out[13] = y; out[14] = z;
  return out;
}

export function mat4RotX(rad, out = new Float32Array(16)) {
  const c = Math.cos(rad), s = Math.sin(rad);
  mat4Identity(out);
  out[5] = c; out[6] = s; out[9] = -s; out[10] = c;
  return out;
}

export function mat4RotY(rad, out = new Float32Array(16)) {
  const c = Math.cos(rad), s = Math.sin(rad);
  mat4Identity(out);
  out[0] = c; out[2] = -s; out[8] = s; out[10] = c;
  return out;
}

/**
 * Off-centre orthographic projection.
 */
export function mat4Ortho(left, right, bottom, top, near, far, out = new Float32Array(16)) {
  mat4Identity(out);
  out[0] = 2 / (right - left);
  out[5] = 2 / (top - bottom);
  out[10] = -2 / (far - near);
  out[12] = -(right + left) / (right - left);
  out[13] = -(top + bottom) / (top - bottom);
  out[14] = -(far + near) / (far - near);
  return out;
}

/** Transform a point by a column-major mat4. @returns {[number,number,number]} */
export function transformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}
