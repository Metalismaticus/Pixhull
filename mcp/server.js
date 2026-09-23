#!/usr/bin/env node
// @ts-check
/**
 * Pixhull as an MCP server.
 *
 * An assistant points this at PNGs on disk and gets back a model, a picture of
 * it, and files in whatever format it asked for. Everything it computes comes
 * from the same modules the web app runs, so a model made here and a model made
 * in the browser are the same model - there is no second implementation to
 * drift.
 *
 * Transport is stdio: newline-delimited JSON-RPC 2.0, which is what MCP clients
 * launch a local server with. Written directly rather than against the SDK, to
 * keep the repository free of dependencies; the protocol surface needed here is
 * small and stable.
 *
 * Two rules the implementation depends on:
 *   - stdout carries protocol frames and nothing else. Every diagnostic goes to
 *     stderr, or the client sees corrupt JSON.
 *   - file access is confined to one root directory, given on the command line
 *     or defaulting to the working directory. A tool an assistant drives should
 *     not be able to reach the whole filesystem by being asked nicely.
 */

import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { Palette } from '../src/core/palette.js';
import { SourceView, VIEW_NAMES } from '../src/core/views.js';
import { carve } from '../src/core/carve.js';
import { exportObj } from '../src/export/obj.js';
import { exportVox } from '../src/export/vox.js';
import { exportGlb } from '../src/export/gltf.js';
import { decodePng, encodePng } from './png.js';
import { renderTurnaroundCpu, packSheetCpu } from './raster.js';

const SERVER_INFO = { name: 'pixhull', version: '0.1.0' };
/** Versions this server understands; the newest is offered when the client asks for something else. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const ROOT = resolve(process.argv[2] ?? process.cwd());

/** @type {Map<string, {volume: import('../src/core/volume.js').Volume, palette: Palette, note: string}>} */
const models = new Map();
let nextModelId = 1;

// ---------------------------------------------------------------- helpers

/**
 * Resolve a path inside the root, refusing anything that escapes it.
 * @param {string} p
 * @returns {string}
 */
function safePath(p) {
  const full = isAbsolute(p) ? resolve(p) : resolve(ROOT, p);
  const rel = relative(ROOT, full);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Path is outside the server root (' + ROOT + '): ' + p);
  }
  return full;
}

/** Newline, as a constant: an editing pass once turned a \n escape into a real
 *  line break inside a string literal, and the module stopped parsing. */
const LF = String.fromCharCode(10);

/** @param {unknown} err */
const message = (err) => (err instanceof Error ? err.message : String(err));

// ------------------------------------------------------------------ tools

const TOOLS = [
  {
    name: 'carve_views',
    description:
      'Carve a 3D voxel model from orthographic pixel-art views. Give at least one PNG path; ' +
      'front, side and top together define the shape. Views may be any size and need not match ' +
      'each other. Returns a model_id to pass to the other tools.',
    inputSchema: {
      type: 'object',
      properties: {
        front: { type: 'string', description: 'PNG path, relative to the server root' },
        back: { type: 'string' },
        left: { type: 'string' },
        right: { type: 'string' },
        top: { type: 'string' },
        bottom: { type: 'string' },
        grid: { type: 'integer', minimum: 8, maximum: 256, description: 'Voxel grid size; defaults to fitting the art' },
        mirror_missing: {
          type: 'boolean',
          description: 'Fill facings with no view of their own from the opposite view. Default true.',
        },
      },
    },
  },
  {
    name: 'render_preview',
    description:
      'Render the model and return it as an image, so you can see what you made before exporting. ' +
      'Defaults to a single 2:1 dimetric view.',
    inputSchema: {
      type: 'object',
      properties: {
        model_id: { type: 'string' },
        directions: { type: 'integer', minimum: 1, maximum: 16, description: 'Frames around a turn. Default 1.' },
        elevation: { type: 'number', description: 'Camera elevation in degrees. Default 26.565 (2:1 dimetric).' },
        scale: { type: 'integer', minimum: 1, maximum: 8, description: 'Pixels per voxel. Default 4.' },
        shaded: { type: 'boolean', description: 'Tint faces for readability. Default true for previews.' },
      },
      required: ['model_id'],
    },
  },
  {
    name: 'export_model',
    description:
      'Write the model to disk. Formats: "glb" (glTF, one material with vertex colours - ' +
      'the easiest to drop into a game engine), "obj" (OBJ + MTL), "vox" (MagicaVoxel), ' +
      '"sprites" (a pixel-perfect turnaround sheet plus JSON metadata).',
    inputSchema: {
      type: 'object',
      properties: {
        model_id: { type: 'string' },
        format: { type: 'string', enum: ['glb', 'obj', 'vox', 'sprites'] },
        out_dir: { type: 'string', description: 'Directory, relative to the server root. Default ".".' },
        name: { type: 'string', description: 'Base filename. Default "pixhull".' },
        smooth: { type: 'boolean', description: 'glb and obj: a rounded low-poly shell instead of cubes.' },
        relax: { type: 'integer', minimum: 0, maximum: 6, description: 'Smoothing passes for glb and obj.' },
        directions: { type: 'integer', minimum: 1, maximum: 64, description: 'Sprites only. Default 8.' },
        elevation: { type: 'number', description: 'Sprites only, degrees. Default 26.565.' },
        scale: { type: 'integer', minimum: 1, maximum: 16, description: 'Sprites only. Default 1.' },
      },
      required: ['model_id', 'format'],
    },
  },
];

/** @param {string} id */
function requireModel(id) {
  const model = models.get(id);
  if (!model) throw new Error('No model with id "' + id + '". Call carve_views first.');
  return model;
}

/** @param {Record<string, any>} args */
function toolCarveViews(args) {
  const palette = new Palette();
  /** @type {SourceView[]} */
  const views = [];
  const loaded = [];

  for (const name of VIEW_NAMES) {
    const path = args[name];
    if (!path) continue;
    const image = decodePng(readFileSync(safePath(path)));
    views.push(new SourceView(name, image));
    loaded.push(name + ' ' + image.width + 'x' + image.height);
  }
  if (views.length === 0) throw new Error('Give at least one view, for example front, right and top.');

  let grid = args.grid;
  if (!grid) {
    grid = 8;
    for (const v of views) grid = Math.max(grid, v.trim.w, v.trim.h);
    grid = Math.min(256, grid);
  }
  for (const v of views) v.autoPlace(grid);

  const { volume, stats } = carve(views, grid, palette, {
    mirrorMissing: args.mirror_missing !== false,
  });
  if (volume.solidCount === 0) {
    throw new Error('The views carved nothing. They may not overlap, or the alpha channel may be empty.');
  }

  const id = 'model-' + nextModelId++;
  models.set(id, { volume, palette, note: loaded.join(', ') });

  const box = volume.bounds();
  const extent = box
    ? (box.max[0] - box.min[0] + 1) + 'x' + (box.max[1] - box.min[1] + 1) + 'x' + (box.max[2] - box.min[2] + 1)
    : '-';

  return text(
    [
      'model_id: ' + id,
      'views: ' + loaded.join(', '),
      'grid: ' + grid + '^3',
      'voxels: ' + volume.solidCount,
      'extent: ' + extent + ' (x, y up, z toward the front view)',
      'palette: ' + (palette.size - 1) + ' colours',
      stats.mirrored.length ? 'mirrored from the opposite view: ' + stats.mirrored.join(', ') : 'all six views supplied',
      'carved in ' + stats.ms.toFixed(0) + ' ms',
    ].join('\n')
  );
}

/** @param {Record<string, any>} args */
function toolRenderPreview(args) {
  const { volume, palette } = requireModel(args.model_id);
  const directions = Math.max(1, Math.min(16, args.directions ?? 1));
  const scale = Math.max(1, Math.min(8, args.scale ?? 4));
  const elevation = args.elevation ?? 26.565;

  const { frames, meta } = renderTurnaroundCpu(volume, palette, {
    directions,
    pitch: (elevation * Math.PI) / 180,
    scale,
    shaded: args.shaded !== false,
  });
  const sheet = frames.length === 1 ? frames[0] : packSheetCpu(frames);
  const png = encodePng(sheet);

  return {
    content: [
      {
        type: 'text',
        text:
          directions + ' frame(s) at ' + meta.frameW + 'x' + meta.frameH +
          ' px, ' + scale + ' px per voxel, elevation ' + elevation + ' degrees.',
      },
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    ],
  };
}

/** @param {Record<string, any>} args */
function toolExportModel(args) {
  const { volume, palette } = requireModel(args.model_id);
  const name = String(args.name ?? 'pixhull').replace(/[^\w.-]/g, '_');
  const dir = safePath(args.out_dir ?? '.');
  mkdirSync(dir, { recursive: true });

  /** @param {string} file @param {Buffer|string} body */
  const write = (file, body) => {
    const full = resolve(dir, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
    return relative(ROOT, full).replace(/\\/g, '/');
  };

  if (args.format === 'glb') {
    const { bytes, stats } = exportGlb(volume, palette, {
      name,
      smooth: !!args.smooth,
      relax: args.relax ?? 0,
    });
    const file = write(name + '.glb', Buffer.from(bytes));
    return text(
      'Wrote ' + file + LF +
      stats.triangles + ' triangles, ' + stats.vertices + ' vertices, one material with vertex ' +
      'colours' + (stats.smooth ? ' (smooth mesh)' : '')
    );
  }

  if (args.format === 'obj') {
    const { obj, mtl, stats } = exportObj(volume, palette, {
      name,
      smooth: !!args.smooth,
      relax: args.relax ?? 0,
    });
    const files = [write(name + '.obj', obj), write(name + '.mtl', mtl)];
    return text(
      'Wrote ' + files.join(' and ') + '\n' +
      (stats.smooth ? 'smooth mesh: ' : 'blocky mesh: ') +
      stats.quads + ' quads, ' + stats.vertices + ' vertices'
    );
  }

  if (args.format === 'vox') {
    const { bytes, stats } = exportVox(volume, palette);
    const file = write(name + '.vox', Buffer.from(bytes));
    return text(
      'Wrote ' + file + '\n' +
      stats.voxels + ' voxels, ' + stats.colors + ' colours, ' +
      stats.size.join('x') + ' (MagicaVoxel is Z-up, so the axes are reordered)'
    );
  }

  if (args.format === 'sprites') {
    const directions = Math.max(1, Math.min(64, args.directions ?? 8));
    const scale = Math.max(1, Math.min(16, args.scale ?? 1));
    const elevation = args.elevation ?? 26.565;
    const { frames, meta } = renderTurnaroundCpu(volume, palette, {
      directions,
      pitch: (elevation * Math.PI) / 180,
      scale,
      shaded: false,
    });

    const files = [write(name + '-sheet.png', encodePng(packSheetCpu(frames)))];
    const metadata = {
      generator: 'pixhull',
      frameWidth: meta.frameW,
      frameHeight: meta.frameH,
      frameCount: meta.count,
      elevation: meta.pitch,
      scale: meta.scale,
      frames: meta.angles.map((a, i) => ({
        index: i,
        yaw: a,
        sheetX: i * meta.frameW,
        sheetY: 0,
        pivotX: meta.pivots[i].x,
        pivotY: meta.pivots[i].y,
      })),
      palette: palette.colors.slice(1).map((c) => '#' + c.toString(16).padStart(6, '0')),
    };
    files.push(write(name + '-sprites.json', JSON.stringify(metadata, null, 2)));

    return text(
      'Wrote ' + files.join(' and ') + '\n' +
      meta.count + ' frames, every one ' + meta.frameW + 'x' + meta.frameH +
      ' px with its pivot recorded, so nothing drifts between frames.'
    );
  }

  throw new Error('Unknown format "' + args.format + '". Use obj, vox or sprites.');
}

/** @param {string} s */
const text = (s) => ({ content: [{ type: 'text', text: s }] });

/** @type {Record<string, (args: Record<string, any>) => any>} */
const HANDLERS = {
  carve_views: toolCarveViews,
  render_preview: toolRenderPreview,
  export_model: toolExportModel,
};

// --------------------------------------------------------------- protocol

/** @param {object} msg */
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/** @param {string|number} id @param {object} result */
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });

/** @param {string|number} id @param {number} code @param {string} msg */
const fail = (id, code, msg) => send({ jsonrpc: '2.0', id, error: { code, message: msg } });

/** @param {any} request */
function handle(request) {
  const { id, method, params } = request;

  // Notifications carry no id and get no reply.
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      reply(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Carve a voxel model from orthographic pixel-art views, then look at it with ' +
          'render_preview before exporting. File paths are relative to ' + ROOT + '.',
      });
      return;
    }

    case 'ping':
      reply(id, {});
      return;

    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;

    case 'tools/call': {
      const handler = HANDLERS[params?.name];
      if (!handler) {
        fail(id, -32602, 'Unknown tool: ' + params?.name);
        return;
      }
      try {
        reply(id, handler(params.arguments ?? {}));
      } catch (err) {
        // Tool failures come back as content, not as protocol errors, so the
        // assistant can read what went wrong and try something else.
        reply(id, { content: [{ type: 'text', text: 'Error: ' + message(err) }], isError: true });
      }
      return;
    }

    default:
      fail(id, -32601, 'Method not found: ' + method);
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    fail(0, -32700, 'Parse error');
    return;
  }
  try {
    handle(request);
  } catch (err) {
    process.stderr.write('pixhull-mcp: ' + message(err) + '\n');
    if (request?.id !== undefined) fail(request.id, -32603, message(err));
  }
});

process.stderr.write('pixhull-mcp ready, root ' + ROOT + '\n');
