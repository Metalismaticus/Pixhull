// @ts-check
/**
 * App wiring: source views in, voxels out, sprites and OBJ out the other side.
 */

import { Palette } from './core/palette.js';
import { SourceView, VIEW_NAMES, suggestGridSize, fitViews } from './core/views.js';
import { decodeImage, toImageData } from './ui/decode.js';
import { carve } from './core/carve.js';
import { detectCells, cropCell, guessViews } from './core/sheet.js';
import { Renderer } from './gfx/renderer.js';
import { OrthoCamera, PITCH_PRESETS, directionYaws, DEG } from './gfx/camera.js';
import { renderTurnaround, packSheet, snapToPalette, imageDataToPng, downloadBlob } from './export/sprite.js';
import { exportObj } from './export/obj.js';
import { exportVox } from './export/vox.js';
import { exportGlb } from './export/gltf.js';
import { buildSmoothMesh } from './export/surfacenets.js';
import { makeZip, blobBytes } from './export/zip.js';
import { buildDemoViews } from './demo.js';
import { t, num, getLang, setLang, applyTranslations } from './i18n.js';
import { detectTheme, getTheme, setTheme, toggleTheme, cssColorToGl } from './ui/theme.js';
import { screenRay, raycastVoxel, rayPlanePoint } from './edit/pick.js';
import { History } from './edit/history.js';
import { applyTool, boxExtent, applyBox } from './edit/tools.js';
import { serializeVolume, deserializeVolume } from './core/serialize.js';

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
  /** Source pixels per grid cell in the last build; 1 means art was used 1:1. */
  fitScale: 1,
  /** @type {{name: string|null, amount: number}} the view that agreed least with the rest */
  worstFit: { name: null, amount: 1 },
  gridSize: 32,
  /** @type {string | null} slot awaiting a file from the picker */
  pendingSlot: null,
  /** the viewport needs redrawing */
  dirty: true,
  /** the instance buffer is stale; coalesced to one rebuild per frame */
  geometryDirty: false,

  /** @type {'orbit'|'paint'|'fill'|'erase'|'add'|'pick'|'box'|'boxErase'} */
  tool: 'orbit',
  /** palette index the editing tools apply */
  color: 1,
  /** cube radius; 0 is a single voxel */
  brush: 0,
  history: new History(),
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
      '<button data-act="r" data-i18n-title="views.rotate">↻</button>' +
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
  // Any manual change to how a view sits takes it out of the solvers' hands.
  if (act === 'r') {
    view.rotate = (view.rotate + 90) % 360;
    view.orientLocked = true;
  } else if (act === 'h') {
    view.flipH = !view.flipH;
    view.orientLocked = true;
  } else if (act === 'v') {
    view.flipV = !view.flipV;
    view.orientLocked = true;
  }
  if (act === 'x') state.views.delete(name);
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
      btn.classList.toggle('on', !!view && (
        (act === 'r' && view.rotate !== 0) ||
        (act === 'h' && view.flipH) ||
        (act === 'v' && view.flipV)));
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
  tctx.putImageData(toImageData(src), 0, 0);

  // Rotation swaps which dimension has to fit.
  const turned = view.rotate % 180 !== 0;
  const vw = turned ? src.height : src.width;
  const vh = turned ? src.width : src.height;
  const s = Math.min(w / vw, h / vh);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(w / 2, h / 2);
  ctx.rotate((view.rotate * Math.PI) / 180);
  // Flips happen in the drawing's own space, before the turn, matching how
  // the sampler maps a grid cell back to a source pixel.
  ctx.scale(view.flipH ? -1 : 1, view.flipV ? -1 : 1);
  const dw = src.width * s;
  const dh = src.height * s;
  ctx.drawImage(tmp, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
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
  // Art larger than the grid is reduced, not cropped, and the views are
  // reconciled against each other before it happens.
  const fit = fitViews(views, N);
  state.fitScale = fit.reduction;
  state.worstFit = fit.worst;

  const mirrorMissing = /** @type {HTMLInputElement} */ ($('mirror-toggle')).checked;
  const { volume, stats } = carve(views, N, state.palette, { mirrorMissing });
  state.volume = volume;
  state.lastStats = stats;

  state.history.clear();
  refreshHistoryButtons();
  renderer.setPalette(state.palette);
  refreshPalette();
  const faces = renderer.setVolume(volume);

  const box = volume.bounds();
  if (box) camera.fit(box, canvas.width || 800, canvas.height || 600);

  $('viewport-empty').classList.toggle('hidden', volume.solidCount > 0);
  updateStats(stats, faces);
  updateZoomLabel();
  updateFramePreview();
  state.dirty = true;

  // Ordered by how badly each one invalidates the result. A drawing in the
  // wrong slot makes the whole model meaningless; running out of palette
  // entries only makes it slightly off-colour.
  if (volume.solidCount === 0) {
    status('status.emptyCarve', undefined, 'warn');
  } else if (stats.lookalikes.length > 0) {
    const worst = stats.lookalikes[0];
    status('status.lookalikeViews', {
      a: ['views.' + worst.a],
      b: ['views.' + worst.b],
      pct: Math.round(worst.similarity * 100),
    }, 'warn');
  } else if (state.worstFit.amount > 1.1 && state.worstFit.name) {
    status('status.viewsDisagree', {
      n: volume.solidCount,
      view: ['views.' + state.worstFit.name],
      amount: state.worstFit.amount.toFixed(2),
    }, 'warn');
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
  if (state.fitScale > 1.001) rows.push(['stats.reduction', state.fitScale.toFixed(2) + '×']);

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

// ---------------------------------------------------------- sheet slicing

/**
 * The sheet currently open in the dialog, and the drawings found on it.
 * @type {{image: {width: number, height: number, data: Uint8ClampedArray}, cells: import('./core/sheet.js').Cell[]} | null}
 */
let sheet = null;

/** @param {Blob} file */
async function openSheet(file) {
  try {
    sheet = { image: await decodeImage(file), cells: [] };
    refreshSheetCells();
    /** @type {HTMLDialogElement} */ ($('sheet-dialog')).showModal();
  } catch (err) {
    status('status.badImage', { err: String(err instanceof Error ? err.message : err) }, 'error');
  }
}

function refreshSheetCells() {
  if (!sheet) return;
  const gap = +(/** @type {HTMLInputElement} */ ($('sheet-gap')).value);
  $('sheet-gap-label').textContent = String(gap);

  sheet.cells = detectCells(sheet.image, { gap });
  const guessed = guessViews(sheet.cells);
  // guessViews only names front, right and top when the sizes leave no doubt;
  // anything else is reading order, which is a guess and should not claim to be
  // more than that.
  const confident =
    sheet.cells.length === 3 &&
    ['front', 'right', 'top'].every((name) => guessed.includes(name));

  $('sheet-summary').textContent = sheet.cells.length === 0
    ? t('sheet.none')
    : t(confident ? 'sheet.summaryGuessed' : 'sheet.summary', {
        n: sheet.cells.length,
        w: sheet.image.width,
        h: sheet.image.height,
      });

  const host = $('sheet-cells');
  host.innerHTML = '';
  sheet.cells.forEach((cell, i) => {
    const box = document.createElement('div');
    box.className = 'sheet-cell' + (guessed[i] ? ' assigned' : '');

    const canvas = document.createElement('canvas');
    canvas.width = cell.w;
    canvas.height = cell.h;
    const ctx = canvas.getContext('2d');
    if (ctx && sheet) {
      const crop = cropCell(sheet.image, cell);
      ctx.putImageData(toImageData(crop), 0, 0);
    }

    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = cell.w + '×' + cell.h;

    const select = document.createElement('select');
    select.dataset.cell = String(i);
    const skip = document.createElement('option');
    skip.value = '';
    skip.textContent = t('sheet.ignore');
    select.appendChild(skip);
    for (const name of VIEW_NAMES) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = t('views.' + name);
      select.appendChild(option);
    }
    select.value = guessed[i] ?? '';
    select.addEventListener('change', () => {
      box.classList.toggle('assigned', !!select.value);
    });

    box.append(canvas, size, select);
    host.appendChild(box);
  });
}

function applySheet() {
  if (!sheet) return;

  /** @type {Array<[string, number]>} */
  const chosen = [];
  for (const el of $('sheet-cells').querySelectorAll('select')) {
    const select = /** @type {HTMLSelectElement} */ (el);
    if (select.value) chosen.push([select.value, +(select.dataset.cell ?? 0)]);
  }
  if (chosen.length === 0) return;

  // A sheet replaces the whole set of views. Keeping leftovers from an earlier
  // load would quietly carve against art the artist has already moved on from.
  state.views.clear();
  for (const [name, index] of chosen) {
    const crop = cropCell(sheet.image, sheet.cells[index]);
    setView(name, /** @type {any} */ (crop));
  }
  autoGrid();
  refreshSlots();
  build();
}

// ----------------------------------------------------------------- editor

const TOOL_BUTTONS = [
  { id: 'orbit', key: 'tool.orbit', glyph: '⟳', hotkey: 'v' },
  { id: 'paint', key: 'tool.paint', glyph: '◉', hotkey: 'b' },
  { id: 'fill', key: 'tool.fill', glyph: '▣', hotkey: 'g' },
  { id: 'erase', key: 'tool.erase', glyph: '⌫', hotkey: 'e' },
  { id: 'add', key: 'tool.add', glyph: '⬜', hotkey: 'a' },
  { id: 'pick', key: 'tool.pick', glyph: '◔', hotkey: 'i' },
  { id: 'box', key: 'tool.box', glyph: '⬛', hotkey: 'r' },
  { id: 'boxErase', key: 'tool.boxErase', glyph: '⬚', hotkey: 't' },
];

function buildToolBar() {
  const host = $('tool-bar');
  host.innerHTML = '';
  for (const tool of TOOL_BUTTONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.tool = tool.id;
    b.title = t(tool.key) + '  (' + tool.hotkey.toUpperCase() + ')';
    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.textContent = tool.glyph;
    const label = document.createElement('span');
    label.textContent = t(tool.key);
    b.append(glyph, label);
    b.addEventListener('click', () => setTool(/** @type {any} */ (tool.id)));
    host.appendChild(b);
  }
  markActiveTool();
}

/** @param {typeof state.tool} tool */
function setTool(tool) {
  state.tool = tool;
  markActiveTool();
}

function markActiveTool() {
  for (const b of $('tool-bar').querySelectorAll('button')) {
    b.classList.toggle('on', /** @type {HTMLElement} */ (b).dataset.tool === state.tool);
  }
  canvas.className = state.tool === 'orbit' ? '' : 'tool-' + state.tool;
}

function refreshPalette() {
  const host = $('palette-strip');
  host.innerHTML = '';
  for (let i = 1; i < state.palette.size; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.background = state.palette.hex(i);
    b.title = state.palette.hex(i);
    b.classList.toggle('on', i === state.color);
    b.addEventListener('click', () => {
      state.color = i;
      refreshPalette();
    });
    host.appendChild(b);
  }
  if (state.color >= state.palette.size) state.color = Math.max(1, state.palette.size - 1);
}

function refreshHistoryButtons() {
  /** @type {HTMLButtonElement} */ ($('btn-undo')).disabled = !state.history.canUndo;
  /** @type {HTMLButtonElement} */ ($('btn-redo')).disabled = !state.history.canRedo;
}

/**
 * Where a pointer event lands in the model.
 * @param {PointerEvent} e
 */
function hitAt(e) {
  if (!state.volume) return null;
  const rect = canvas.getBoundingClientRect();
  const sx = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const sy = ((e.clientY - rect.top) / rect.height) * canvas.height;
  const ray = screenRay(camera, sx, sy, canvas.width, canvas.height);
  return raycastVoxel(state.volume, ray.origin, ray.dir);
}

/**
 * @param {PointerEvent} e
 * @returns {boolean} true when the model was touched
 */
function runToolAt(e) {
  if (!state.volume || state.tool === 'orbit') return false;
  const hit = hitAt(e);
  if (!hit) return false;

  if (state.tool === 'pick') {
    const picked = state.volume.getFace(hit.x, hit.y, hit.z, hit.face);
    if (picked) {
      state.color = picked;
      refreshPalette();
    }
    return true;
  }

  const result = applyTool(state.volume, hit, {
    tool: state.tool,
    color: state.color,
    brush: state.brush,
    faceOnly: /** @type {HTMLInputElement} */ ($('face-only')).checked,
    symmetryX: /** @type {HTMLInputElement} */ ($('symmetry-x')).checked,
    history: state.history,
  });

  if (result.changed) {
    state.geometryDirty = true;
    state.dirty = true;
  }
  return true;
}

function undo() {
  if (!state.volume || !state.history.undo(state.volume)) {
    status('status.nothingToUndo');
    return;
  }
  state.geometryDirty = true;
  state.dirty = true;
  refreshHistoryButtons();
  status('status.undone');
}

function redo() {
  if (!state.volume || !state.history.redo(state.volume)) return;
  state.geometryDirty = true;
  state.dirty = true;
  refreshHistoryButtons();
  status('status.redone');
}

/**
 * Live state of a box drag: where it began and the cuboid it currently covers.
 * @type {{anchor: {x: number, y: number, z: number, face: number}, extent: {min: [number,number,number], max: [number,number,number]}} | null}
 */
let boxDrag = null;

const isBoxTool = () => state.tool === 'box' || state.tool === 'boxErase';

/**
 * The far corner of the drag, found by meeting the plane of the face it began
 * on. Using the plane rather than a second voxel hit means the rectangle keeps
 * growing when the pointer wanders off the model.
 * @param {PointerEvent} e
 * @param {{x: number, y: number, z: number, face: number}} anchor
 * @returns {[number, number, number]}
 */
function boxCornerAt(e, anchor) {
  const vol = state.volume;
  const fallback = /** @type {[number, number, number]} */ ([anchor.x, anchor.y, anchor.z]);
  if (!vol) return fallback;

  const rect = canvas.getBoundingClientRect();
  const sx = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const sy = ((e.clientY - rect.top) / rect.height) * canvas.height;
  const ray = screenRay(camera, sx, sy, canvas.width, canvas.height);

  const axis = anchor.face >> 1;
  // Even face indices point along +axis, so their plane sits one step further on.
  const plane = [anchor.x, anchor.y, anchor.z][axis] + (anchor.face % 2 === 0 ? 1 : 0);
  const hit = rayPlanePoint(ray.origin, ray.dir, axis, plane);
  if (!hit) return fallback;

  const dims = [vol.nx, vol.ny, vol.nz];
  const out = fallback.slice();
  for (let i = 0; i < 3; i++) {
    if (i === axis) continue;
    out[i] = Math.max(0, Math.min(dims[i] - 1, Math.floor(hit[i])));
  }
  return /** @type {[number, number, number]} */ (out);
}

/** @param {PointerEvent} e */
function updateBoxDrag(e) {
  if (!boxDrag || !state.volume) return;
  const corner = boxCornerAt(e, boxDrag.anchor);
  const extent = boxExtent(boxDrag.anchor, corner, state.brush + 1, state.tool === 'box');
  const vol = state.volume;
  const dims = [vol.nx, vol.ny, vol.nz];
  for (let i = 0; i < 3; i++) {
    extent.min[i] = Math.max(0, Math.min(dims[i] - 1, extent.min[i]));
    extent.max[i] = Math.max(0, Math.min(dims[i] - 1, extent.max[i]));
  }
  boxDrag.extent = extent;
  renderer.setPreviewBox(extent.min, extent.max);
  state.dirty = true;
}

function commitBoxDrag() {
  const drag = boxDrag;
  boxDrag = null;
  renderer.clearPreviewBox();
  state.dirty = true;
  if (!drag || !state.volume) return;

  state.history.begin();
  const changed = applyBox(state.volume, drag.extent, {
    fill: state.tool === 'box',
    color: state.color,
    symmetryX: /** @type {HTMLInputElement} */ ($('symmetry-x')).checked,
    history: state.history,
  });
  if (changed > 0) {
    state.geometryDirty = true;
    if (state.history.commit(state.volume)) refreshHistoryButtons();
    status('status.boxApplied', {
      n: changed,
      w: drag.extent.max[0] - drag.extent.min[0] + 1,
      h: drag.extent.max[1] - drag.extent.min[1] + 1,
      d: drag.extent.max[2] - drag.extent.min[2] + 1,
    });
  } else {
    state.history.commit(state.volume);
  }
}
function setupPointer() {
  let mode = /** @type {null | 'orbit' | 'pan' | 'tool'} */ (null);
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    lastX = e.clientX;
    lastY = e.clientY;
    // Capture can be refused for a pointer the browser no longer tracks;
    // losing it only costs us drags that leave the canvas.
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not fatal */ }

    // Middle button or Ctrl always pans; Shift and right-drag orbit even while
    // a paint tool is armed, so the view stays reachable without switching.
    if (e.button === 1 || e.ctrlKey) mode = 'pan';
    else if (e.button === 2 || e.shiftKey || state.tool === 'orbit') mode = 'orbit';
    else mode = 'tool';

    if (mode === 'tool' && isBoxTool()) {
      const hit = hitAt(e);
      if (hit) {
        boxDrag = { anchor: hit, extent: { min: [0, 0, 0], max: [0, 0, 0] } };
        updateBoxDrag(e);
      } else {
        mode = null;
      }
    } else if (mode === 'tool') {
      state.history.begin();
      runToolAt(e);
    } else {
      canvas.classList.add('dragging');
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!mode) return;
    if (mode === 'tool') {
      if (boxDrag) updateBoxDrag(e);
      else runToolAt(e);
      return;
    }
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
    if (mode === 'tool' && boxDrag) {
      commitBoxDrag();
    } else if (mode === 'tool' && state.volume) {
      // One undo step per stroke, not per voxel.
      if (state.history.commit(state.volume)) refreshHistoryButtons();
    }
    mode = null;
    canvas.classList.remove('dragging');
    try {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    } catch { /* not fatal */ }
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

async function doExportGlb() {
  if (!state.volume) return;
  status('status.meshing');
  await nextFrame();
  try {
    const smooth = /** @type {HTMLInputElement} */ ($('obj-smooth')).checked;
    const relax = +(/** @type {HTMLInputElement} */ ($('obj-relax')).value);
    const { bytes, stats } = exportGlb(state.volume, state.palette, { name: 'pixhull', smooth, relax });
    downloadBlob(new Blob([bytes], { type: 'model/gltf-binary' }), 'pixhull.glb');
    status('status.exportedGlb', { tris: stats.triangles, verts: stats.vertices });
  } catch (err) {
    status('status.badImage', { err: String(err instanceof Error ? err.message : err) }, 'error');
  }
}

async function doExportVox() {
  if (!state.volume) return;
  status('status.meshing');
  await nextFrame();
  try {
    const { bytes, stats } = exportVox(state.volume, state.palette);
    downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), 'pixhull.vox');
    status('status.exportedVox', {
      n: stats.voxels, c: stats.colors,
      w: stats.size[0], h: stats.size[1], d: stats.size[2],
    });
  } catch (err) {
    status('status.badImage', { err: String(err instanceof Error ? err.message : err) }, 'error');
  }
}

async function doExportObj() {
  if (!state.volume) return;
  status('status.meshing');
  await nextFrame();
  try {
    const smooth = /** @type {HTMLInputElement} */ ($('obj-smooth')).checked;
    const relax = +(/** @type {HTMLInputElement} */ ($('obj-relax')).value);
    const { obj, mtl, stats } = exportObj(state.volume, state.palette, { name: 'pixhull', smooth, relax });
    const enc = new TextEncoder();
    downloadBlob(
      makeZip([
        { name: 'pixhull.obj', data: enc.encode(obj) },
        { name: 'pixhull.mtl', data: enc.encode(mtl) },
      ]),
      'pixhull-model.zip'
    );
    if (stats.smooth) {
      status('status.exportedObjSmooth', { quads: stats.quads, verts: stats.vertices });
    } else {
      const saved = stats.rawQuads > 0 ? Math.round((1 - stats.quads / stats.rawQuads) * 100) : 0;
      status('status.exportedObj', { quads: stats.quads, saved, verts: stats.vertices });
    }
  } catch (err) {
    status('status.badImage', { err: String(err instanceof Error ? err.message : err) }, 'error');
  }
}

// ------------------------------------------------------------ project I/O

async function saveProject() {
  /** @type {Record<string, unknown>} */
  const views = {};
  for (const [name, v] of state.views) {
    const blob = await imageDataToPng(toImageData(v.image));
    views[name] = {
      png: await blobToBase64(blob),
      flipH: v.flipH,
      flipV: v.flipV,
      enabled: v.enabled,
      offsetX: v.offsetX,
      offsetY: v.offsetY,
    };
  }
  // The voxels travel with the project, not just the source views: a rebuild
  // from the same PNGs cannot reproduce anything carved or painted by hand.
  const project = {
    format: 'pixhull-project',
    version: 2,
    gridSize: state.gridSize,
    views,
    palette: state.palette.serialize(),
    volume: state.volume ? serializeVolume(state.volume) : null,
  };
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

    if (data.volume && data.palette) {
      // Restore the saved voxels rather than re-carving, so hand edits survive.
      state.palette = Palette.deserialize(data.palette);
      state.volume = deserializeVolume(data.volume);
      state.lastStats = { solid: state.volume.solidCount, painted: 0, inferred: 0, mirrored: [], ms: 0 };
      state.history.clear();
      refreshHistoryButtons();
      renderer.setPalette(state.palette);
      refreshPalette();
      const faces = renderer.setVolume(state.volume);
      const box = state.volume.bounds();
      if (box) camera.fit(box, canvas.width || 800, canvas.height || 600);
      $('viewport-empty').classList.toggle('hidden', state.volume.solidCount > 0);
      updateStats(state.lastStats, faces);
      updateZoomLabel();
      updateFramePreview();
      state.dirty = true;
    } else {
      build();
    }
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

/** The one checkbox drives both the viewport and the OBJ export. */
const smoothPreviewOn = () => /** @type {HTMLInputElement} */ ($('obj-smooth')).checked;
const relaxAmount = () => +(/** @type {HTMLInputElement} */ ($('obj-relax')).value);

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r(undefined)));
}

function frame() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (renderer.resize(dpr)) state.dirty = true;
  if (state.geometryDirty && state.volume) {
    // Dragging a brush can touch the model dozens of times per frame; rebuild
    // once instead of once per event.
    const faces = renderer.setVolume(state.volume);
    // The voxel buffer is rebuilt either way so the face count stays honest and
    // the grid wireframe stays in step; the smooth mesh is extra on top.
    renderer.useSmooth = smoothPreviewOn();
    if (renderer.useSmooth) {
      renderer.setSmoothMesh(buildSmoothMesh(state.volume, { relax: relaxAmount() }));
    }
    // Editing changes the voxel count, so the carve-time figure is stale.
    if (state.lastStats) state.lastStats.solid = state.volume.solidCount;
    updateStats(state.lastStats, faces);
    state.geometryDirty = false;
    state.dirty = true;
  }
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
  renderer.previewColor = cssColorToGl('--accent');
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
  buildToolBar();
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
  buildToolBar();
  buildPitchPresets();
  wirePitchPresets();
  setupPointer();
  applyTranslations();
  refreshLanguageButton();

  const brush = /** @type {HTMLInputElement} */ ($('brush-size'));
  brush.addEventListener('input', () => {
    state.brush = +brush.value;
    const side = state.brush * 2 + 1;
    $('brush-label').textContent = side + '³';
  });

  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);

  $('btn-add-color').addEventListener('click', () => {
    const hex = /** @type {HTMLInputElement} */ ($('new-color')).value;
    const n = parseInt(hex.slice(1), 16);
    const before = state.palette.size;
    const idx = state.palette.add((n >> 16) & 255, (n >> 8) & 255, n & 255);
    state.color = idx;
    renderer.setPalette(state.palette);
    refreshPalette();
    state.dirty = true;
    if (state.palette.size === before && state.palette.overflowed) status('status.paletteFull', undefined, 'warn');
    else status('status.colorAdded', { n: state.palette.size - 1 });
  });

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
  $('btn-export-glb').addEventListener('click', doExportGlb);
  $('btn-export-vox').addEventListener('click', doExportVox);

  const sheetInput = /** @type {HTMLInputElement} */ ($('sheet-input'));
  const sheetDialog = /** @type {HTMLDialogElement} */ ($('sheet-dialog'));
  $('btn-sheet').addEventListener('click', () => sheetInput.click());
  sheetInput.addEventListener('change', async () => {
    const file = sheetInput.files?.[0];
    if (file) await openSheet(file);
    sheetInput.value = '';
  });
  $('sheet-gap').addEventListener('input', refreshSheetCells);
  $('sheet-cancel').addEventListener('click', () => sheetDialog.close());
  $('sheet-apply').addEventListener('click', () => {
    applySheet();
    sheetDialog.close();
  });

  const smoothToggle = /** @type {HTMLInputElement} */ ($('obj-smooth'));
  const relaxRange = /** @type {HTMLInputElement} */ ($('obj-relax'));
  smoothToggle.addEventListener('change', () => {
    relaxRange.disabled = !smoothToggle.checked;
    state.geometryDirty = true;
  });
  relaxRange.addEventListener('input', () => {
    $('relax-label').textContent = relaxRange.value;
    if (smoothToggle.checked) state.geometryDirty = true;
  });
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

    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
      return;
    }

    const idx = '12345'.indexOf(e.key);
    if (idx >= 0) {
      camera.yaw = ANGLE_CHIPS[idx].yaw * DEG;
      state.dirty = true;
      markActiveChip();
      return;
    }

    const tool = TOOL_BUTTONS.find((b) => b.hotkey === e.key.toLowerCase());
    if (tool) setTool(/** @type {any} */ (tool.id));
  });

  updateFramePreview();
  loadDemo();
  requestAnimationFrame(frame);

  // Handy from the browser console, and how the smoke tests reach in:
  //   const { renderTurnaround } = await import('/src/export/sprite.js')
  /** @type {any} */ (window).pixhull = { state, camera, renderer, build, loadDemo };
}

init();
