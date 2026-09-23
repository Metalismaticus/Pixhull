// @ts-check
/**
 * App wiring: source views in, voxels out, sprites and OBJ out the other side.
 */

import { Palette } from './core/palette.js';
import { SourceView, VIEW_NAMES, decodeImage, suggestGridSize } from './core/views.js';
import { carve } from './core/carve.js';
import { Renderer } from './gfx/renderer.js';
import { OrthoCamera, PITCH_PRESETS, directionYaws, DEG } from './gfx/camera.js';
import { renderTurnaround, packSheet, snapToPalette, imageDataToPng, downloadBlob } from './export/sprite.js';
import { exportObj } from './export/obj.js';
import { makeZip, blobBytes } from './export/zip.js';
import { buildDemoViews } from './demo.js';
import { t, num, getLang, setLang, applyTranslations } from './i18n.js';
import { detectTheme, getTheme, setTheme, toggleTheme, cssColorToGl } from './ui/theme.js';

/** @param {string} id */
const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error('Missing element #' + id);
  return el;
};

const state = {
  palette: new Palette(),
  /** @type {Map<string, SourceView>} */
  views: new Map(),
  /** @type {import('./core/volume.js').Volume | null} */
  volume: null,
  /** @type {import('./core/carve.js').CarveStats | null} */
  lastStats: null,
  gridSize: 32,
  /** @type {string | null} slot awaiting a file from the picker */
  pendingSlot: null,
  dirty: true,
};

const camera = new OrthoCamera();
/** Scratch camera for exports so the viewport is never disturbed. */
const exportCamera = new OrthoCamera();

const canvas = /** @type {HTMLCanvasElement} */ ($('gl'));
let renderer;
try {
  renderer = new Renderer(canvas);
} catch (err) {
  document.body.innerHTML =
    '<div style="padding:40px;font:14px system-ui;color:var(--text);height:100%">' +
    '<h1 style="font-size:16px"></h1><p style="color:var(--text-dim)"></p></div>';
  const h = document.querySelector('h1');
  const p = document.querySelector('p');
  if (h) h.textContent = t('error.webgl');
  if (p) p.textContent = String(err instanceof Error ? err.message : err);
  throw err;
}

// ---------------------------------------------------------------- status

/**
 * The status bar remembers its key so it can be re-rendered on a language
 * switch without the caller having to say anything again.
 * @type {{key: string, params?: Record<string, string|number|string[]>, level: 'info'|'warn'|'error'}}
 */
let lastStatus = { key: 'status.ready', level: 'info' };

/**
 * @param {string} key i18n key
 * @param {Record<string, string|number|string[]>} [params]
 * @param {'info'|'warn'|'error'} [level]
 */
function status(key, params, level = 'info') {
  lastStatus = { key, params, level };
  renderStatus();
}

function renderStatus() {
  const el = $('statusbar');
  el.textContent = t(lastStatus.key, lastStatus.params);
  el.className = 'statusbar' + (lastStatus.level === 'info' ? '' : ' ' + lastStatus.level);
}

// ----------------------------------------------------------- source views

function buildSlots() {
  const host = $('view-slots');
  host.innerHTML = '';
  for (const name of VIEW_NAMES) {
    const slot = document.createElement('div');
    slot.className = 'slot';
    slot.dataset.view = name;
    slot.innerHTML =
      '<span class="slot-name" data-i18n="views.' + name + '"></span>' +
      '<canvas width="52" height="52"></canvas>' +
      '<span class="slot-size"></span>' +
      '<div class="slot-tools">' +
      '<button data-act="h" data-i18n-title="views.flipH">H</button>' +
      '<button data-act="v" data-i18n-title="views.flipV">V</button>' +
      '<button data-act="x" data-i18n-title="views.remove">&times;</button>' +
      '</div>';

    slot.addEventListener('click', (e) => {
      const btn = /** @type {HTMLElement} */ (e.target).closest('button');
      if (btn) {
        e.stopPropagation();
        slotAction(name, btn.dataset.act ?? '');
        return;
      }
      state.pendingSlot = name;
      /** @type {HTMLInputElement} */ ($('file-input')).click();
    });

    slot.addEventListener('dragover', (e) => {
      e.preventDefault();
      slot.classList.add('dragover');
    });
    slot.addEventListener('dragleave', () => slot.classList.remove('dragover'));
    slot.addEventListener('drop', async (e) => {
      e.preventDefault();
      slot.classList.remove('dragover');
      const file = e.dataTransfer?.files?.[0];
      if (file) await loadInto(name, file);
    });

    host.appendChild(slot);
  }
  applyTranslations(host);
}

/** @param {string} name @param {string} act */
function slotAction(name, act) {
  const view = state.views.get(name);
  if (!view) return;
  if (act === 'h') view.flipH = !view.flipH;
  else if (act === 'v') view.flipV = !view.flipV;
  else if (act === 'x') state.views.delete(name);
  refreshSlots();
  build();
}

/** @param {string} name @param {Blob} file */
async function loadInto(name, file) {
  try {
    const img = await decodeImage(file);
    setView(name, img);
    autoGrid();
    refreshSlots();
    build();
  } catch (err) {
    status('status.badImage', { err: String(err instanceof Error ? err.message : err) }, 'error');
  }
}

/** @param {string} name @param {ImageData} img */
function setView(name, img) {
  const view = new SourceView(name, img);
  state.views.set(name, view);
}

function refreshSlots() {
  for (const name of VIEW_NAMES) {
    const slot = /** @type {HTMLElement|null} */ (document.querySelector('.slot[data-view="' + name + '"]'));
    if (!slot) continue;
    const view = state.views.get(name);
    const thumb = /** @type {HTMLCanvasElement} */ (slot.querySelector('canvas'));
    const size = /** @type {HTMLElement} */ (slot.querySelector('.slot-size'));
    slot.classList.toggle('filled', !!view);

    for (const btn of slot.querySelectorAll('.slot-tools button')) {
      const act = /** @type {HTMLElement} */ (btn).dataset.act;
      btn.classList.toggle('on', !!view && ((act === 'h' && view.flipH) || (act === 'v' && view.flipV)));
    }

    const ctx = thumb.getContext('2d');
    if (!ctx) continue;
    ctx.clearRect(0, 0, thumb.width, thumb.height);
    if (!view) {
      size.textContent = t('views.empty');
      continue;
    }
    size.textContent = view.image.width + '×' + view.image.height;
    drawThumb(ctx, view, thumb.width, thumb.height);
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {SourceView} view
 * @param {number} w @param {number} h
 */
function drawThumb(ctx, view, w, h) {
  const src = view.image;
  const tmp = document.createElement('canvas');
  tmp.width = src.width;
  tmp.height = src.height;
  const tctx = tmp.getContext('2d');
  if (!tctx) return;
  tctx.putImageData(src, 0, 0);
  if (view.flipH || view.flipV) {
    const flipped = document.createElement('canvas');
    flipped.width = src.width;
    flipped.height = src.height;
    const fctx = flipped.getContext('2d');
    if (fctx) {
      fctx.imageSmoothingEnabled = false;
      fctx.translate(view.flipH ? src.width : 0, view.flipV ? src.height : 0);
      fctx.scale(view.flipH ? -1 : 1, view.flipV ? -1 : 1);
      fctx.drawImage(tmp, 0, 0);
      tmp.width = flipped.width;
      tctx.clearRect(0, 0, tmp.width, tmp.height);
      tctx.drawImage(flipped, 0, 0);
    }
  }
  const s = Math.min(w / src.width, h / src.height);
  const dw = Math.max(1, Math.floor(src.width * s));
  const dh = Math.max(1, Math.floor(src.height * s));
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, Math.floor((w - dw) / 2), Math.floor((h - dh) / 2), dw, dh);
}

/** Pick the smallest listed grid that fits the loaded art. */
function autoGrid() {
  const need = suggestGridSize([...state.views.values()]);
  const select = /** @type {HTMLSelectElement} */ ($('grid-size'));
  const options = [...select.options].map((o) => +o.value).sort((a, b) => a - b);
  const pick = options.find((v) => v >= need) ?? options[options.length - 1];
  select.value = String(pick);
  state.gridSize = pick;
}

// ------------------------------------------------------------------ build

function build() {
  const views = [...state.views.values()];
  if (views.length === 0) {
    state.volume = null;
    state.lastStats = null;
    renderer.instanceCount = 0;
    $('viewport-empty').classList.remove('hidden');
    updateStats(null, 0);
    state.dirty = true;
    status('status.ready');
    return;
  }

  const N = state.gridSize;
  state.palette = new Palette();
  for (const v of views) v.autoPlace(N);

  const mirrorMissing = /** @type {HTMLInputElement} */ ($('mirror-toggle')).checked;
  const { volume, stats } = carve(views, N, state.palette, { mirrorMissing });
  state.volume = volume;
  state.lastStats = stats;

  renderer.setPalette(state.palette);
  const faces = renderer.setVolume(volume);

  const box = volume.bounds();
  if (box) camera.fit(box, canvas.width || 800, canvas.height || 600);

  $('viewport-empty').classList.toggle('hidden', volume.solidCount > 0);
  updateStats(stats, faces);
  updateZoomLabel();
  updateFramePreview();
  state.dirty = true;

  if (volume.solidCount === 0) {
    status('status.emptyCarve', undefined, 'warn');
  } else if (state.palette.overflowed) {
    status('status.paletteOverflow', { ms: stats.ms.toFixed(0) }, 'warn');
  } else if (stats.mirrored.length > 0) {
    status('status.builtMirrored', {
      n: volume.solidCount,
      ms: stats.ms.toFixed(0),
      views: stats.mirrored.map((v) => 'views.' + v),
    });
  } else {
    status('status.built', { n: volume.solidCount, ms: stats.ms.toFixed(0) });
  }
}

/**
 * @param {import('./core/carve.js').CarveStats | null} stats
 * @param {number} faces
 */
function updateStats(stats, faces) {
  const el = $('stats');
  el.textContent = '';
  if (!stats || !state.volume) {
    const row = document.createElement('div');
    row.textContent = t('stats.none');
    el.appendChild(row);
    return;
  }

  const b = state.volume.bounds();
  const size = b
    ? (b.max[0] - b.min[0] + 1) + '×' + (b.max[1] - b.min[1] + 1) + '×' + (b.max[2] - b.min[2] + 1)
    : '—';

  /** @type {Array<[string, string]>} */
  const rows = [
    ['stats.voxels', num(stats.solid)],
    ['stats.faces', num(faces)],
    ['stats.extent', size],
    ['stats.palette', String(state.palette.size - 1)],
    ['stats.inferred', num(stats.inferred)],
  ];
  if (stats.mirrored.length > 0) rows.push(['stats.mirrored', String(stats.mirrored.length)]);

  for (const [key, value] of rows) {
    const row = document.createElement('div');
    row.append(t(key) + ' ');
    const b2 = document.createElement('b');
    b2.textContent = value;
    row.appendChild(b2);
    el.appendChild(row);
  }
}

// ------------------------------------------------------------- viewport UI

const ANGLE_CHIPS = [
  { key: 'angle.front', yaw: 0 },
  { key: 'angle.right', yaw: 90 },
  { key: 'angle.back', yaw: 180 },
  { key: 'angle.left', yaw: 270 },
  { key: 'angle.iso', yaw: 45 },
];

function buildAngleChips() {
  const host = $('angle-chips');
  host.innerHTML = '';
  for (const chip of ANGLE_CHIPS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.i18n = chip.key;
    b.textContent = t(chip.key);
    b.addEventListener('click', () => {
      camera.yaw = chip.yaw * DEG;
      camera.panX = 0;
      camera.panY = 0;
      state.dirty = true;
      markActiveChip();
    });
    host.appendChild(b);
  }
  markActiveChip();
}

function markActiveChip() {
  const deg = ((camera.yaw / DEG) % 360 + 360) % 360;
  const buttons = $('angle-chips').querySelectorAll('button');
  ANGLE_CHIPS.forEach((chip, i) => {
    buttons[i]?.classList.toggle('on', Math.abs(deg - chip.yaw) < 0.01);
  });
}

function buildPitchPresets() {
  const sel = /** @type {HTMLSelectElement} */ ($('pitch-preset'));
  const keep = sel.value;
  sel.innerHTML = '';
  for (const p of PITCH_PRESETS) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = t(p.key);
    sel.appendChild(o);
  }
  sel.value = keep || 'iso21';
  if (sel.selectedIndex < 0) sel.value = 'iso21';
}

function wirePitchPresets() {
  const sel = /** @type {HTMLSelectElement} */ ($('pitch-preset'));
  sel.addEventListener('change', () => {
    const p = PITCH_PRESETS.find((x) => x.id === sel.value);
    if (p) {
      camera.pitch = p.pitch;
      state.dirty = true;
    }
  });
}

function updateZoomLabel() {
  $('zoom-label').textContent = camera.pixelsPerVoxel + '×';
}

/** @param {number} delta */
function zoomBy(delta) {
  camera.pixelsPerVoxel = Math.max(1, Math.min(64, camera.pixelsPerVoxel + delta));
  updateZoomLabel();
  state.dirty = true;
}

function setupOrbit() {
  let mode = /** @type {null | 'orbit' | 'pan'} */ (null);
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener('pointerdown', (e) => {
    mode = e.button === 1 || e.shiftKey || e.ctrlKey ? 'pan' : 'orbit';
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('dragging');
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!mode) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (mode === 'orbit') {
      camera.yaw += dx * 0.01;
      camera.pitch = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, camera.pitch + dy * 0.01));
      markActiveChip();
    } else {
      const dpr = window.devicePixelRatio || 1;
      camera.panX += dx * dpr;
      camera.panY -= dy * dpr;
    }
    state.dirty = true;
  });

  const end = (/** @type {PointerEvent} */ e) => {
    mode = null;
    canvas.classList.remove('dragging');
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
}

// ---------------------------------------------------------------- exports

/** @returns {import('./export/sprite.js').TurnaroundOptions} */
function turnaroundOptions() {
  const pitchId = /** @type {HTMLSelectElement} */ ($('pitch-preset')).value;
  const preset = PITCH_PRESETS.find((p) => p.id === pitchId) ?? PITCH_PRESETS[0];
  return {
    directions: Math.max(1, Math.min(64, +(/** @type {HTMLInputElement} */ ($('dir-count')).value) || 8)),
    angleMode: /** @type {'clean'|'uniform'} */ (/** @type {HTMLSelectElement} */ ($('angle-mode')).value),
    pitch: preset.pitch,
    scale: Math.max(1, +(/** @type {HTMLInputElement} */ ($('export-scale')).value) || 1),
    padding: Math.max(0, +(/** @type {HTMLInputElement} */ ($('export-pad')).value) || 0),
    shaded: /** @type {HTMLInputElement} */ ($('export-shaded')).checked,
  };
}

function updateFramePreview() {
  const opts = turnaroundOptions();
  const yaws = directionYaws(opts.directions, opts.angleMode);
  const shown = yaws.slice(0, 6).map((y) => ((y * 180) / Math.PI).toFixed(2).replace(/\.?0+$/, '') + '°');
  $('angle-preview').textContent =
    shown.join(', ') + (yaws.length > shown.length ? ', …' : '');

  if (!state.volume) {
    $('frame-preview').textContent = '—';
    return;
  }
  const box = state.volume.bounds();
  if (!box) {
    $('frame-preview').textContent = '—';
    return;
  }
  let maxW = 0;
  let maxH = 0;
  const probe = new OrthoCamera();
  probe.pitch = opts.pitch;
  probe.target = [
    (box.min[0] + box.max[0] + 1) / 2,
    (box.min[1] + box.max[1] + 1) / 2,
    (box.min[2] + box.max[2] + 1) / 2,
  ];
  for (const yaw of yaws) {
    probe.yaw = yaw;
    const e = probe.projectedExtent(box);
    maxW = Math.max(maxW, e.w);
    maxH = Math.max(maxH, e.h);
  }
  const scale = opts.scale ?? 1;
  const pad = opts.padding ?? 0;
  const fw = Math.ceil(maxW * scale) + pad * 2;
  const fh = Math.ceil(maxH * scale) + pad * 2;
  $('frame-preview').textContent = t('export.framePreview', {
    fw, fh, sw: fw * yaws.length, sh: fh,
  });
}

async function exportSheet() {
  if (!state.volume) return;
  status('status.rendering');
  await nextFrame();
  try {
    const opts = turnaroundOptions();
    const { frames, meta } = renderTurnaround(renderer, state.volume, exportCamera, opts);
    if (opts.shaded) for (const f of frames) snapToPalette(f, state.palette);
    const { image } = packSheet(frames, meta.frameW, meta.frameH);
    downloadBlob(await imageDataToPng(image), 'pixhull-sheet-' + meta.count + 'dir.png');
    status('status.exportedSheet', { n: meta.count, w: meta.frameW, h: meta.frameH });
  } catch (err) {
    status('status.badImage', { err: String(err instanceof Error ? err.message : err) }, 'error');
  }
}

async function exportFrames() {
  if (!state.volume) return;
  status('status.rendering');
  await nextFrame();
  try {
    const opts = turnaroundOptions();
    const { frames, meta } = renderTurnaround(renderer, state.volume, exportCamera, opts);
    if (opts.shaded) for (const f of frames) snapToPalette(f, state.palette);

    /** @type {Array<{name: string, data: Uint8Array}>} */
    const files = [];
    for (let i = 0; i < frames.length; i++) {
      files.push({
        name: 'frames/' + String(i).padStart(3, '0') + '.png',
        data: await blobBytes(await imageDataToPng(frames[i])),
      });
    }
    const { image } = packSheet(frames, meta.frameW, meta.frameH);
    files.push({ name: 'sheet.png', data: await blobBytes(await imageDataToPng(image)) });

    const json = {
      generator: 'pixhull',
      frameWidth: meta.frameW,
      frameHeight: meta.frameH,
      frameCount: meta.count,
      elevation: meta.pitch,
      scale: meta.scale,
      angleMode: opts.angleMode,
      frames: meta.angles.map((a, i) => ({
        index: i,
        yaw: a,
        sheetX: i * meta.frameW,
        sheetY: 0,
        pivotX: meta.pivots[i].x,
        pivotY: meta.pivots[i].y,
      })),
      palette: state.palette.colors.slice(1).map((c) => '#' + c.toString(16).padStart(6, '0')),
    };
    files.push({ name: 'sprites.json', data: new TextEncoder().encode(JSON.stringify(json, null, 2)) });

    downloadBlob(makeZip(files), 'pixhull-sprites.zip');
    status('status.exportedFrames', { n: meta.count });
  } catch (err) {
    status('status.badImage', { err: String(err instanceof Error ? err.message : err) }, 'error');
  }
}

async function doExportObj() {
  if (!state.volume) return;
  status('status.meshing');
  await nextFrame();
  try {
    const { obj, mtl, stats } = exportObj(state.volume, state.palette, { name: 'pixhull' });
    const enc = new TextEncoder();
    downloadBlob(
      makeZip([
        { name: 'pixhull.obj', data: enc.encode(obj) },
        { name: 'pixhull.mtl', data: enc.encode(mtl) },
      ]),
      'pixhull-model.zip'
    );
    const saved = stats.rawQuads > 0 ? Math.round((1 - stats.quads / stats.rawQuads) * 100) : 0;
    status('status.exportedObj', { quads: stats.quads, saved, verts: stats.vertices });
  } catch (err) {
    status('status.badImage', { err: String(err instanceof Error ? err.message : err) }, 'error');
  }
}

// ------------------------------------------------------------ project I/O

async function saveProject() {
  /** @type {Record<string, unknown>} */
  const views = {};
  for (const [name, v] of state.views) {
    const blob = await imageDataToPng(v.image);
    views[name] = {
      png: await blobToBase64(blob),
      flipH: v.flipH,
      flipV: v.flipV,
      enabled: v.enabled,
      offsetX: v.offsetX,
      offsetY: v.offsetY,
    };
  }
  const project = { format: 'pixhull-project', version: 1, gridSize: state.gridSize, views };
  downloadBlob(new Blob([JSON.stringify(project)], { type: 'application/json' }), 'project.pixhull.json');
  status('status.projectSaved');
}

/** @param {File} file */
async function loadProject(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.format !== 'pixhull-project') throw new Error('Not a Pixhull project file');
    state.views.clear();
    for (const name of VIEW_NAMES) {
      const v = data.views?.[name];
      if (!v) continue;
      const img = await decodeImage(await (await fetch(v.png)).blob());
      const sv = new SourceView(name, img);
      sv.flipH = !!v.flipH;
      sv.flipV = !!v.flipV;
      sv.enabled = v.enabled !== false;
      state.views.set(name, sv);
    }
    state.gridSize = data.gridSize || 32;
    /** @type {HTMLSelectElement} */ ($('grid-size')).value = String(state.gridSize);
    refreshSlots();
    build();
    status('status.projectLoaded');
  } catch (err) {
    status('status.projectFailed', { err: String(err instanceof Error ? err.message : err) }, 'error');
  }
}

/** @param {Blob} blob @returns {Promise<string>} */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// ------------------------------------------------------------------- loop

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r(undefined)));
}

function frame() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (renderer.resize(dpr)) state.dirty = true;
  if (state.dirty) {
    renderer.render(camera, { showBounds: /** @type {HTMLInputElement} */ ($('bounds-toggle')).checked });
    state.dirty = false;
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------- init

function loadDemo() {
  const demo = buildDemoViews();
  state.views.clear();
  setView('front', demo.front);
  setView('right', demo.right);
  setView('top', demo.top);
  autoGrid();
  refreshSlots();
  build();
}

// ------------------------------------------------------- theme & language

/** Pull the viewport colours out of the stylesheet so there is one source. */
function applyThemeToRenderer() {
  renderer.clearColor = cssColorToGl('--viewport-bg');
  const rgb = cssColorToGl('--bounds-color');
  const alpha = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--bounds-alpha')
  );
  renderer.boundsColor = [rgb[0], rgb[1], rgb[2], Number.isFinite(alpha) ? alpha : 0.12];
  state.dirty = true;
}

function refreshThemeButton() {
  $('theme-icon').textContent = getTheme() === 'light' ? '◑' : '◐';
}

function refreshLanguageButton() {
  $('btn-lang').textContent = getLang().toUpperCase();
}

/** Re-render everything that holds a translated string. */
function retranslate() {
  applyTranslations();
  buildPitchPresets();
  buildAngleChips();
  refreshSlots();
  refreshLanguageButton();
  renderStatus();
  updateStats(state.lastStats, renderer.instanceCount);
  updateFramePreview();
}

function init() {
  setTheme(detectTheme());
  applyThemeToRenderer();
  refreshThemeButton();
  setLang(getLang());

  buildSlots();
  buildAngleChips();
  buildPitchPresets();
  wirePitchPresets();
  setupOrbit();
  applyTranslations();
  refreshLanguageButton();

  $('btn-theme').addEventListener('click', () => {
    toggleTheme();
    applyThemeToRenderer();
    refreshThemeButton();
  });

  $('btn-lang').addEventListener('click', () => {
    setLang(getLang() === 'en' ? 'ru' : 'en');
    retranslate();
  });

  $('mirror-toggle').addEventListener('change', build);

  $('btn-demo').addEventListener('click', loadDemo);
  $('btn-demo-2').addEventListener('click', loadDemo);
  $('btn-clear').addEventListener('click', () => {
    state.views.clear();
    refreshSlots();
    build();
  });
  $('btn-build').addEventListener('click', build);
  $('btn-autofit').addEventListener('click', () => {
    autoGrid();
    build();
  });

  $('grid-size').addEventListener('change', (e) => {
    state.gridSize = +(/** @type {HTMLSelectElement} */ (e.target).value);
    build();
  });

  $('shade-toggle').addEventListener('change', (e) => {
    renderer.shade = /** @type {HTMLInputElement} */ (e.target).checked ? 1 : 0;
    state.dirty = true;
  });
  $('bounds-toggle').addEventListener('change', () => { state.dirty = true; });

  $('zoom-in').addEventListener('click', () => zoomBy(1));
  $('zoom-out').addEventListener('click', () => zoomBy(-1));

  for (const id of ['dir-count', 'angle-mode', 'export-scale', 'export-pad']) {
    $(id).addEventListener('input', updateFramePreview);
    $(id).addEventListener('change', updateFramePreview);
  }
  $('pitch-preset').addEventListener('change', updateFramePreview);

  $('btn-export-sheet').addEventListener('click', exportSheet);
  $('btn-export-frames').addEventListener('click', exportFrames);
  $('btn-export-obj').addEventListener('click', doExportObj);
  $('btn-save').addEventListener('click', saveProject);
  $('btn-load').addEventListener('click', () => /** @type {HTMLInputElement} */ ($('project-input')).click());

  const fileInput = /** @type {HTMLInputElement} */ ($('file-input'));
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (file && state.pendingSlot) await loadInto(state.pendingSlot, file);
    fileInput.value = '';
    state.pendingSlot = null;
  });

  const projectInput = /** @type {HTMLInputElement} */ ($('project-input'));
  projectInput.addEventListener('change', async () => {
    const file = projectInput.files?.[0];
    if (file) await loadProject(file);
    projectInput.value = '';
  });

  // Dropping anywhere that is not a slot fills the first empty slot.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    if (/** @type {HTMLElement} */ (e.target).closest('.slot')) return;
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const free = VIEW_NAMES.find((n) => !state.views.has(n)) ?? 'front';
    await loadInto(free, file);
  });

  window.addEventListener('keydown', (e) => {
    if (/** @type {HTMLElement} */ (e.target).matches('input, select, textarea')) return;
    const idx = '12345'.indexOf(e.key);
    if (idx >= 0) {
      camera.yaw = ANGLE_CHIPS[idx].yaw * DEG;
      state.dirty = true;
      markActiveChip();
    }
  });

  updateFramePreview();
  loadDemo();
  requestAnimationFrame(frame);

  // Handy from the browser console, and how the smoke tests reach in:
  //   const { renderTurnaround } = await import('/src/export/sprite.js')
  /** @type {any} */ (window).pixhull = { state, camera, renderer, build, loadDemo };
}

init();
