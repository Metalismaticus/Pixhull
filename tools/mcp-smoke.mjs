// End-to-end check of the MCP server.
//
// Drives mcp/server.js over stdio exactly as a client would - handshake, tool
// listing, then every tool - and verifies what comes back. There is no MCP
// client here to test against, so this is what stands in for one: it catches
// protocol mistakes and broken tools, not a particular client's quirks.
//
//   node tools/mcp-smoke.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { decodePng, encodePng } from '../mcp/png.js';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log('  ok   ' + label + (detail ? '  (' + detail + ')' : ''));
  } else {
    console.error('  FAIL ' + label + (detail ? '  (' + detail + ')' : ''));
    failures++;
  }
}

// ---------------------------------------------------------------- fixtures

/** A tiny RGBA canvas with axis-aligned rectangles - enough for a test car. */
function paint(w, h, rects) {
  const data = new Uint8Array(w * h * 4);
  for (const [x, y, rw, rh, hex] of rects) {
    const n = parseInt(hex.slice(1), 16);
    for (let dy = 0; dy < rh; dy++) {
      for (let dx = 0; dx < rw; dx++) {
        const px = x + dx, py = y + dy;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const o = (py * w + px) * 4;
        data[o] = (n >> 16) & 255;
        data[o + 1] = (n >> 8) & 255;
        data[o + 2] = n & 255;
        data[o + 3] = 255;
      }
    }
  }
  return { width: w, height: h, data };
}

const BODY = '#d94f4f', ROOF = '#bf3a3a', GLASS = '#7fd6e8', TYRE = '#23262e', LIGHT = '#ffd76e';

const work = mkdtempSync(join(tmpdir(), 'pixhull-mcp-'));
console.log('workspace: ' + work);

const front = paint(12, 12, [
  [0, 8, 3, 4, TYRE], [9, 8, 3, 4, TYRE], [0, 5, 12, 4, BODY],
  [2, 2, 8, 3, ROOF], [3, 3, 6, 2, GLASS], [1, 6, 2, 2, LIGHT], [9, 6, 2, 2, LIGHT],
]);
const right = paint(24, 12, [
  [2, 8, 5, 4, TYRE], [16, 8, 5, 4, TYRE], [1, 5, 22, 4, BODY],
  [6, 2, 12, 3, ROOF], [7, 3, 10, 2, GLASS], [0, 6, 2, 2, LIGHT],
]);
const top = paint(12, 24, [
  [1, 1, 10, 22, BODY], [0, 4, 12, 16, BODY], [2, 6, 8, 11, ROOF],
  [3, 7, 6, 4, GLASS], [3, 14, 6, 3, GLASS],
]);

for (const [name, img] of [['front', front], ['right', right], ['top', top]]) {
  writeFileSync(join(work, name + '.png'), encodePng(img));
}

// --------------------------------------------------------- png round trip

console.log('\nPNG codec');
{
  const back = decodePng(readFileSync(join(work, 'right.png')));
  check('size survives', back.width === right.width && back.height === right.height,
    back.width + 'x' + back.height);
  let diff = 0;
  for (let i = 0; i < right.data.length; i++) if (back.data[i] !== right.data[i]) diff++;
  check('every byte survives', diff === 0, diff + ' differing bytes');
}

// ------------------------------------------------------------- the server

const server = spawn(process.execPath, [join(root, 'mcp', 'server.js'), work], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write('    [server] ' + d));

const pending = new Map();
let nextId = 1;
createInterface({ input: server.stdout }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error('  FAIL stdout was not JSON: ' + line.slice(0, 120));
    failures++;
    return;
  }
  const resolveFn = pending.get(msg.id);
  if (resolveFn) {
    pending.delete(msg.id);
    resolveFn(msg);
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, res);
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => rej(new Error('timed out waiting for ' + method)), 20000);
  });
}

function notify(method, params) {
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

try {
  console.log('\nHandshake');
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'pixhull-smoke', version: '1.0.0' },
  });
  check('jsonrpc envelope', init.jsonrpc === '2.0' && !!init.result);
  check('protocol version echoed', init.result?.protocolVersion === '2025-06-18',
    init.result?.protocolVersion);
  check('declares tools capability', !!init.result?.capabilities?.tools);
  check('names itself', init.result?.serverInfo?.name === 'pixhull');
  notify('notifications/initialized', {});

  console.log('\nTool listing');
  const list = await request('tools/list', {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  check('three tools', names.length === 3, names.join(', '));
  check('each has a schema',
    (list.result?.tools ?? []).every((t) => t.inputSchema?.type === 'object' && t.description));

  console.log('\ncarve_views');
  const carved = await request('tools/call', {
    name: 'carve_views',
    arguments: { front: 'front.png', right: 'right.png', top: 'top.png' },
  });
  const carveText = carved.result?.content?.[0]?.text ?? '';
  check('not an error', carved.result?.isError !== true, carveText.slice(0, 80));
  const modelId = (carveText.match(/model_id: (\S+)/) ?? [])[1];
  check('returns a model id', !!modelId, modelId);
  check('reports voxels', /voxels: \d+/.test(carveText),
    (carveText.match(/voxels: \d+/) ?? [''])[0]);
  check('reports mirroring', /mirrored from the opposite view/.test(carveText));

  console.log('\nrender_preview');
  const preview = await request('tools/call', {
    name: 'render_preview',
    arguments: { model_id: modelId, directions: 4, scale: 3 },
  });
  const image = (preview.result?.content ?? []).find((c) => c.type === 'image');
  check('returns an image', !!image, image?.mimeType);
  if (image) {
    const png = decodePng(Buffer.from(image.data, 'base64'));
    check('image decodes', png.width > 0 && png.height > 0, png.width + 'x' + png.height);
    let opaque = 0;
    for (let i = 3; i < png.data.length; i += 4) if (png.data[i] > 0) opaque++;
    check('image is not blank', opaque > 100, opaque + ' opaque pixels');
    check('four frames wide', png.width % 4 === 0, 'width ' + png.width);
  }

  console.log('\nexport_model');
  for (const [format, expected] of [
    ['obj', ['car.obj', 'car.mtl']],
    ['vox', ['car.vox']],
    ['sprites', ['car-sheet.png', 'car-sprites.json']],
  ]) {
    const res = await request('tools/call', {
      name: 'export_model',
      arguments: { model_id: modelId, format, name: 'car', out_dir: 'out' },
    });
    check(format + ' reported no error', res.result?.isError !== true,
      (res.result?.content?.[0]?.text ?? '').split('\n')[0]);
    for (const file of expected) {
      const full = join(work, 'out', file);
      check(format + ' wrote ' + file, existsSync(full) && statSync(full).size > 0,
        existsSync(full) ? statSync(full).size + ' bytes' : 'missing');
    }
  }
  {
    const meta = JSON.parse(readFileSync(join(work, 'out', 'car-sprites.json'), 'utf8'));
    check('metadata has one entry per frame', meta.frames.length === meta.frameCount, meta.frameCount);
    check('every frame records a pivot', meta.frames.every((f) => Number.isFinite(f.pivotX)));
    const sheet = decodePng(readFileSync(join(work, 'out', 'car-sheet.png')));
    check('sheet matches the metadata',
      sheet.width === meta.frameWidth * meta.frameCount && sheet.height === meta.frameHeight,
      sheet.width + 'x' + sheet.height);
  }

  console.log('\nRefusals');
  const escape = await request('tools/call', {
    name: 'carve_views',
    arguments: { front: '../../../etc/passwd' },
  });
  check('refuses paths outside the root', escape.result?.isError === true,
    (escape.result?.content?.[0]?.text ?? '').slice(0, 60));

  const unknown = await request('tools/call', { name: 'no_such_tool', arguments: {} });
  check('rejects an unknown tool', !!unknown.error, unknown.error?.message);

  const missing = await request('tools/call', {
    name: 'render_preview',
    arguments: { model_id: 'model-999' },
  });
  check('reports an unknown model as a tool error', missing.result?.isError === true);
} catch (err) {
  console.error('  FAIL ' + (err instanceof Error ? err.message : String(err)));
  failures++;
} finally {
  server.stdin.end();
  server.kill();
}

console.log('');
if (failures > 0) {
  console.error(failures + ' check(s) failed.');
  process.exit(1);
}
console.log('All checks passed.');
