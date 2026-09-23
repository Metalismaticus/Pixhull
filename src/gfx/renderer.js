// @ts-check
/**
 * Instanced voxel-face renderer.
 *
 * One quad per exposed face, one draw call for the whole model, geometry
 * expanded in the vertex shader from 8 bytes per face. A 256^3 model with a
 * few hundred thousand exposed faces draws in a single instanced call, so
 * painting a voxel means rewriting 8 bytes, not rebuilding a mesh.
 */

import { createProgram, uniforms } from './glutil.js';
import { PALETTE_MAX } from '../core/palette.js';

const VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aVox;
layout(location = 1) in float aDir;
layout(location = 2) in float aColor;

uniform mat4 uViewProj;
uniform sampler2D uPalette;
uniform float uShade;

out vec4 vColor;

// Per face: origin corner, then two tangents whose cross product is the
// outward normal. Winding comes out counter-clockwise seen from outside.
const vec3 BASE[6] = vec3[6](
  vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, 0.0),
  vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, 0.0),
  vec3(0.0, 0.0, 1.0), vec3(0.0, 0.0, 0.0));
const vec3 T1[6] = vec3[6](
  vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, 1.0),
  vec3(0.0, 0.0, 1.0), vec3(1.0, 0.0, 0.0),
  vec3(1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0));
const vec3 T2[6] = vec3[6](
  vec3(0.0, 0.0, 1.0), vec3(0.0, 1.0, 0.0),
  vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, 1.0),
  vec3(0.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0));

// Readability tint for the editor viewport only. Exports default to flat so
// nothing off-palette can sneak into the sprite.
const float SHADE[6] = float[6](0.88, 0.74, 1.0, 0.58, 0.95, 0.68);

void main() {
  int d = int(aDir + 0.5);
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec3 p = aVox + BASE[d] + T1[d] * c.x + T2[d] * c.y;
  gl_Position = uViewProj * vec4(p, 1.0);

  vec4 col = texelFetch(uPalette, ivec2(int(aColor + 0.5), 0), 0);
  vColor = vec4(mix(col.rgb, col.rgb * SHADE[d], uShade), col.a);
}`;

const FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 fragColor;
void main() {
  if (vColor.a < 0.5) discard;
  fragColor = vec4(vColor.rgb, 1.0);
}`;

const BOX_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
uniform mat4 uViewProj;
void main() { gl_Position = uViewProj * vec4(aPos, 1.0); }`;

const BOX_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 fragColor;
void main() { fragColor = uColor; }`;

export class Renderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false, // every pixel must land on an exact palette colour
      depth: true,
      preserveDrawingBuffer: false,
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.canvas = canvas;
    this.gl = gl;

    this.program = createProgram(gl, VS, FS);
    this.u = uniforms(gl, this.program, ['uViewProj', 'uPalette', 'uShade']);
    this.boxProgram = createProgram(gl, BOX_VS, BOX_FS);
    this.boxU = uniforms(gl, this.boxProgram, ['uViewProj', 'uColor']);

    this.vao = gl.createVertexArray();
    this.instanceBuffer = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    // stride 8: int16 x, y, z | uint8 dir | uint8 palette index
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.SHORT, false, 8, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.UNSIGNED_BYTE, false, 8, 6);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.UNSIGNED_BYTE, false, 8, 7);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);

    this.boxVao = gl.createVertexArray();
    this.boxBuffer = gl.createBuffer();
    gl.bindVertexArray(this.boxVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boxBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.boxVertexCount = 0;

    this.paletteTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, PALETTE_MAX, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    this.instanceCount = 0;
    this.shade = 1;
    /** @type {[number, number, number, number]} */
    this.clearColor = [0.09, 0.10, 0.13, 1];
  }

  /** @param {import('../core/palette.js').Palette} palette */
  setPalette(palette) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, PALETTE_MAX, 1, gl.RGBA, gl.UNSIGNED_BYTE, palette.toTextureData());
  }

  /**
   * @param {import('../core/volume.js').Volume} volume
   * @returns {number} exposed face count
   */
  setVolume(volume) {
    const gl = this.gl;
    const { buffer, count } = volume.buildFaceInstances();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, buffer, gl.DYNAMIC_DRAW);
    this.instanceCount = count;
    this.setBounds(volume.nx, volume.ny, volume.nz);
    return count;
  }

  /** Wireframe of the working grid, so the edges of the space stay visible. */
  setBounds(nx, ny, nz) {
    const c = [[0, 0, 0], [nx, 0, 0], [nx, ny, 0], [0, ny, 0], [0, 0, nz], [nx, 0, nz], [nx, ny, nz], [0, ny, nz]];
    const edges = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
    const data = new Float32Array(edges.length * 3);
    edges.forEach((ci, i) => data.set(c[ci], i * 3));
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boxBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.boxVertexCount = edges.length;
  }

  /**
   * Match the drawing buffer to the element size.
   * @param {number} dpr
   * @returns {boolean} true when the size changed
   */
  resize(dpr = 1) {
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    return true;
  }

  /**
   * @param {import('./camera.js').OrthoCamera} camera
   * @param {{showBounds?: boolean}} [opts]
   */
  render(camera, opts = {}) {
    this.draw(camera, this.canvas.width, this.canvas.height, opts);
  }

  /**
   * Render into an offscreen target and read it back. This is the export path:
   * no antialiasing, transparent clear, bounds hidden, so every returned pixel
   * is either empty or an exact palette colour.
   * @param {import('./camera.js').OrthoCamera} camera
   * @param {number} w @param {number} h
   * @returns {ImageData}
   */
  renderToImageData(camera, w, h) {
    const gl = this.gl;
    const fbo = gl.createFramebuffer();
    const color = gl.createRenderbuffer();
    const depth = gl.createRenderbuffer();
    try {
      gl.bindRenderbuffer(gl.RENDERBUFFER, color);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w, h);
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Export framebuffer incomplete: 0x' + status.toString(16));

      const prevClear = this.clearColor;
      this.clearColor = [0, 0, 0, 0];
      this.draw(camera, w, h, { showBounds: false });
      this.clearColor = prevClear;

      const pixels = new Uint8ClampedArray(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      // GL reads bottom-up; images are top-down.
      return flipVertically(new ImageData(pixels, w, h));
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      gl.deleteRenderbuffer(color);
      gl.deleteRenderbuffer(depth);
    }
  }

  /**
   * @param {import('./camera.js').OrthoCamera} camera
   * @param {number} w @param {number} h
   * @param {{showBounds?: boolean}} [opts]
   */
  draw(camera, w, h, opts = {}) {
    const gl = this.gl;
    gl.viewport(0, 0, w, h);
    gl.clearColor(this.clearColor[0], this.clearColor[1], this.clearColor[2], this.clearColor[3]);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.frontFace(gl.CCW);
    gl.cullFace(gl.BACK);

    const vp = camera.viewProj(w, h);

    if (this.instanceCount > 0) {
      gl.useProgram(this.program);
      gl.uniformMatrix4fv(this.u.uViewProj, false, vp);
      gl.uniform1f(this.u.uShade, this.shade);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
      gl.uniform1i(this.u.uPalette, 0);
      gl.bindVertexArray(this.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.instanceCount);
      gl.bindVertexArray(null);
    }

    if (opts.showBounds && this.boxVertexCount > 0) {
      gl.disable(gl.CULL_FACE);
      gl.useProgram(this.boxProgram);
      gl.uniformMatrix4fv(this.boxU.uViewProj, false, vp);
      gl.uniform4f(this.boxU.uColor, 1, 1, 1, 0.12);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(this.boxVao);
      gl.drawArrays(gl.LINES, 0, this.boxVertexCount);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }
  }
}

/** @param {ImageData} img @returns {ImageData} */
function flipVertically(img) {
  const { width: w, height: h, data } = img;
  const row = w * 4;
  const tmp = new Uint8ClampedArray(row);
  for (let y = 0; y < (h >> 1); y++) {
    const a = y * row;
    const b = (h - 1 - y) * row;
    tmp.set(data.subarray(a, a + row));
    data.copyWithin(a, b, b + row);
    data.set(tmp, b);
  }
  return img;
}
