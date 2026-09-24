// @ts-check
/**
 * App wiring: source views in, voxels out, sprites and OBJ out the other side.
 */

import { Palette, MERGE_DELTA_E } from './core/palette.js';
import { SourceView, VIEW_NAMES, suggestGridSize, fitViews } from './core/views.js';
import { decodeImage, toImageData } from './ui/decode.js';
import { startBuild, cancelBuild } from './ui/build-task.js';
import { detectCells, cropCell, guessViews, solveBySize } from './core/sheet.js';
import { packViewSheet, projectViewRows } from './core/viewsheet.js';
import { Renderer } from './gfx/renderer.js';
import { OrthoCamera, PITCH_PRESETS, directionYaws, DEG } from './gfx/camera.js';
import { renderTurnaround, packSheet, snapToPalette, imageDataToPng, downloadBlob } from './export/sprite.js';
import { exportObj } from './export/obj.js';
import { exportVox, VOX_MAX_SIZE } from './export/vox.js';
import { exportGlb } from './export/gltf.js';
import { buildSmoothMesh } from './export/surfacenets.js';
import { makeZip, blobBytes } from './export/zip.js';
import { buildDemoViews } from './demo.js';
import { mapInstances, mapAt, bandTextureData, BANDS, BAND_LONELY } from './core/disagree.js';
import { t, num, getLang, setLang, applyTranslations } from './i18n.js';
import { detectTheme, getTheme, setTheme, toggleTheme, cssColorToGl } from './ui/theme.js';
import { screenRay, raycastVoxel, rayPlanePoint } from './edit/pick.js';
import { History } from './edit/history.js';
import { applyTool, collectFillRegion, mirrorX } from './edit/tools.js';
import { boxEdges, faceEdges, faceDiagonals, cellGrid, regionOutline, brushExtent, addSeed, joinLines, GRID_RADIUS } from './edit/preview.js';
import {
  dragExtent, clampExtent, resizeExtent, extentSize, extentCells, countBlock,
  boxFaceUnderRay, axisPointFromRay, applySelection, COUNT_LIMIT,
} from './edit/selection.js';
import { paletteBands, paletteOrder } from './edit/palette-order.js';
import { mergeOffer } from './edit/merge-offer.js';
import { bakeOffer } from './edit/bake-offer.js';
import { applyBake } from './core/bake.js';
import { strokeSamples, strokeStepPx } from './edit/stroke.js';
import { ViewStroke, blankSheet, paintAt, eraseAt, pickAt, fillAt } from './edit/draw2d.js';
import { serializeVolume, deserializeVolume } from './core/serialize.js';

/**
 * The tool Alt was borrowed from, or null when Alt is not held.
 * @type {typeof state.tool | null}
 */
let altBorrowedFrom = null;

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
  /**
   * Where the drawings disagreed about a voxel's colour, as the last build saw
   * it, or null. Null is not an error: a project loaded from a file has a model
   * and no map, because the map is made of the drawings, not of the model
   * (`src/core/serialize.js` keeps neither, and should not).
   * @type {import('./core/disagree.js').DisagreementMap | null}
   */
  map: null,
  /** the viewport is showing the map instead of the model's own colours */
  mapOn: false,
  /** Source pixels per grid cell in the last build; 1 means art was used 1:1. */
  fitScale: 1,
  /** @type {{name: string|null, amount: number}} the view that agreed least with the rest */
  worstFit: { name: null, amount: 1 },
  /** @type {Array<{axis: string, amount: number}>} axes cut back over a contested spike */
  trimmed: [],
  gridSize: 32,
  /** @type {string | null} slot awaiting a file from the picker */
  pendingSlot: null,
  /** the viewport needs redrawing */
  dirty: true,
  /**
   * A build is running somewhere else and the model on screen is the previous
   * one. Editing has to be refused while it is set: the build ends by replacing
   * the volume and clearing the history, so an edit made now would vanish
   * without a word - the very thing the rebuild guard exists to prevent.
   */
  building: false,
  /** the instance buffer is stale; coalesced to one rebuild per frame */
  geometryDirty: false,

  /** @type {'orbit'|'paint'|'fill'|'erase'|'add'|'pick'|'box'} */
  tool: 'orbit',
  /**
   * The block the box tool left behind, in voxel coordinates, or null.
   *
   * It outlives the drag on purpose: the whole point of the rewrite is that
   * marking a block and doing something to it are two steps, with a look in
   * between.
   * @type {{min: [number, number, number], max: [number, number, number]} | null}
   */
  selection: null,
  /** palette index the editing tools apply */
  color: 1,
  /** cube radius; 0 is a single voxel */
  brush: 0,
  history: new History(),

  /**
   * Which of the two things the viewport is: the model, or one of the six
   * drawings it is carved from. Mutually exclusive on purpose - a mode that
   * draws on a picture and a mode that draws on voxels cannot share a pointer.
   * @type {'3d'|'2d'}
   */
  mode: '3d',
  /** The drawing on screen in 2D mode, by view name. */
  view2d: 'front',
  /** Whole screen pixels per drawing pixel, 1..64; its own zoom, not the camera's. */
  zoom2d: 1,
  /** Where the drawing has been dragged to, in CSS pixels. */
  pan2d: { x: 0, y: 0 },
  /**
   * Views painted, projected or started blank since the last build.
   *
   * The model is behind these drawings until the next carve, and the panel says
   * so rather than leaving it to be discovered (screen spec, section 3.4).
   * @type {Set<string>}
   */
  editedViews: new Set(),
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

/**
 * What the pointer is over right now, shown on top of `lastStatus`.
 *
 * An overlay rather than a replacement, so moving the mouse never costs the
 * user the report of the edit they just made: the moment the cursor leaves the
 * model the previous message is simply visible again.
 * @type {{key: string, params?: Record<string, string|number|string[]>} | null}
 */
let hoverLine = null;

function renderStatus() {
  const el = $('statusbar');
  const shown = hoverLine
    ? { key: hoverLine.key, params: hoverLine.params, level: /** @type {const} */ ('info') }
    : lastStatus;
  el.textContent = t(shown.key, shown.params);
  el.className = 'statusbar' + (shown.level === 'info' ? '' : ' ' + shown.level);
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
      '<button data-act="e" data-i18n-title="views.edit">✎</button>' +
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
  // Painting a drawing changes no voxel, so it asks nothing and rebuilds
  // nothing - it only moves the viewport to the picture (spec 4.4).
  if (act === 'e') {
    showView2d(name);
    setMode('2d');
    return;
  }
  // Turning and flipping keep the pixels; dropping the slot throws them away.
  guardRebuild(() => {
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
    if (act === 'x') {
      state.views.delete(name);
      // The drawing is gone, so it is no longer ahead of anything.
      state.editedViews.delete(name);
    }
    refreshSlots();
    build();
  }, undefined, act === 'x' ? name : undefined);
}

/** @param {string} name @param {Blob} file */
async function loadInto(name, file) {
  try {
    const img = await decodeImage(file);
    // A new file replaces the slot's drawing whole - including anything painted
    // on the one already there.
    guardRebuild(() => {
      setView(name, img);
      autoGrid();
      refreshSlots();
      build();
    }, undefined, name);
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
    // Painted here and not yet carved: the model is behind this drawing.
    const ahead = !!view && state.editedViews.has(name);
    slot.classList.toggle('edited', ahead);
    slot.title = ahead ? t('views.edited') : '';

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

// ---------------------------------------------------------- rebuild guard

/**
 * Hand edits live only in the volume, and every rebuild throws that volume
 * away together with the undo history. Ask before that happens.
 *
 * Only when there is something to lose, though: changing the grid, flipping a
 * view or pressing Demo on an untouched model is the normal working loop, and
 * a question on every click would be worse than the disease.
 *
 * Two losses, two questions. A rebuild is what a painted drawing is *waiting*
 * for, so painting alone never makes `hasEdits` true (spec 4.4) - but Demo,
 * Clear, loading a project, dropping a PNG into a filled slot and emptying a
 * slot do not rebuild from the drawing, they destroy it. Those are exactly the
 * clicks that used to lose a painting without a word.
 *
 * @param {string|true} [drawings] the drawings this action destroys: a view
 *   name, or `true` for all six. Omit when the drawings survive it.
 * @returns {boolean} true when the caller may go ahead and replace the model
 */
function mayDiscardEdits(drawings) {
  const losesModel = state.history.hasEdits;
  const losesDrawing = drawings !== undefined
    && state.history.hasViewEdits(drawings === true ? undefined : drawings);
  if (!losesModel && !losesDrawing) return true;
  // The model is named first when both are at stake: it is the bigger loss,
  // and its sentence already says the history goes with it.
  const warn = losesModel ? 'edit.rebuildWarning' : 'edit.drawingWarning';
  const ask = losesModel ? 'edit.rebuildConfirm' : 'edit.drawingConfirm';
  if (window.confirm(t(warn) + '\n\n' + t(ask))) return true;
  status(losesModel ? 'edit.rebuildKept' : 'edit.drawingKept', undefined, 'warn');
  return false;
}

/**
 * @param {() => void} proceed what replaces the model
 * @param {() => void} [revert] put back the control the user just moved, so a
 *   refused rebuild does not leave the panel describing a model that is not there
 * @param {string|true} [drawings] which drawings `proceed` destroys, if any
 */
function guardRebuild(proceed, revert, drawings) {
  if (mayDiscardEdits(drawings)) {
    proceed();
    return;
  }
  if (revert) revert();
}

// ------------------------------------------------------------------ build

/**
 * Show how far the build has got, or hide the bar with `null`.
 *
 * The bar carries the fraction and the status line carries the words, because
 * the two answer different questions - "will this finish?" and "what is it
 * doing?" - and the status line is the one place this app says what is
 * happening (`docs/DESIGN.md`, §6).
 *
 * @param {number|null} fraction 0..1, or null when no build is running
 * @param {string} [stage] name of the stage, as `carve.js` reports it
 */
function showBuildProgress(fraction, stage = 'sample') {
  const host = $('build-progress');
  if (fraction === null) {
    host.classList.add('hidden');
    return;
  }
  const pct = Math.round(fraction * 100);
  host.classList.remove('hidden');
  host.setAttribute('aria-valuenow', String(pct));
  /** @type {HTMLElement} */ ($('build-progress-fill')).style.width = pct + '%';
  status('status.building', { pct, stage: ['build.' + stage] });
}

/**
 * Take the build in flight off the screen and out of the future.
 *
 * Anything that puts a different model up has to call this first. A build that
 * is still running owns `state.volume`, `state.palette` and the history the
 * moment it finishes (`build()`, after the await), so a model that arrived from
 * somewhere else - a loaded project, a cleared scene - would be silently
 * replaced by an answer to a question the user has since withdrawn. Cancelling
 * makes that promise reject as `cancelled`, and `build()` returns without
 * touching anything.
 */
function dropBuild() {
  cancelBuild();
  state.building = false;
  showBuildProgress(null);
  refreshMergeOffer();
  invalidateBakeOffers();
  refreshSelectionPanel();
  refreshMapPanel();
}

/**
 * Build the model, off the main thread.
 *
 * Nothing awaits this - callers fire it and carry on, exactly as they did when
 * it was synchronous. What changed is that the tab now stays alive for the
 * eleven seconds a 512 grid takes: the carve, the face instances and the
 * bounding box all happen in a worker (`src/ui/build-task.js`), and this
 * function only waits for the answer and puts it on screen.
 *
 * The model already on screen stays there while the new one is being built.
 * Blanking it would be honest about the state and useless in practice - the
 * artist has nothing to look at and no way to tell a slow build from a broken
 * one, whereas the old model plus a progress bar says both.
 */
async function build() {
  const views = [...state.views.values()];
  if (views.length === 0) {
    dropBuild();
    dropMap();
    state.volume = null;
    state.lastStats = null;
    renderer.instanceCount = 0;
    state.editedViews.clear();
    refreshViewsAhead();
    refreshEmptyViewport();
    markModeChips();
    refreshView2dEmpty();
    refreshView2dReadout();
    drawView2d();
    updateStats(null, 0);
    // After the volume goes, not before: the reason under the checkbox is
    // "there is no model yet", and it can only be read off a model that is gone.
    refreshMapPanel();
    state.dirty = true;
    status('status.ready');
    return;
  }

  const N = state.gridSize;
  // Art larger than the grid is reduced, not cropped, and the views are
  // reconciled against each other before it happens. Cheap enough to stay here
  // (11 ms at 512), and the panel needs its answer either way.
  const fit = fitViews(views, N);
  state.fitScale = fit.reduction;
  state.worstFit = fit.worst;
  state.trimmed = fit.trimmed ?? [];

  const mirrorMissing = /** @type {HTMLInputElement} */ ($('mirror-toggle')).checked;
  const job = { views: views.map((v) => v.snapshot()), N, mirrorMissing };

  state.building = true;
  // The map belongs to the model being replaced, and it is not recomputed until
  // this build lands; it goes now rather than describing a model that is gone.
  dropMap();
  // The buttons under the block go dark while the volume is being replaced,
  // and say why; the block itself goes when the new volume lands.
  refreshSelectionPanel();
  showBuildProgress(0, 'sample');
  // The merge button acts on the model the build is about to replace, so it goes
  // dark for the duration and says why.
  refreshMergeOffer();
  invalidateBakeOffers();
  /** @type {import('./ui/build-task.js').BuildResult} */
  let built;
  try {
    built = await startBuild(job, (fraction, stage) => showBuildProgress(fraction, stage));
  } catch (err) {
    // A build the user replaced with another one says nothing: the newer build
    // owns the progress bar and the status line now.
    if (err instanceof Error && /** @type {any} */ (err).cancelled) return;
    state.building = false;
    showBuildProgress(null);
    refreshMergeOffer();
    invalidateBakeOffers();
    refreshSelectionPanel();
    refreshMapPanel();
    status('status.buildFailed', { err: String(err instanceof Error ? err.message : err) }, 'error');
    return;
  }
  state.building = false;
  showBuildProgress(null);
  // The volume is replaced whole, so the block's coordinates name cells that
  // no longer exist.
  clearSelection();

  const { volume, stats } = built;
  state.palette = built.palette;
  state.volume = volume;
  state.lastStats = stats;
  state.map = built.map;
  mapFaces = null;

  state.history.clear();
  refreshHistoryButtons();
  uploadPalette();
  refreshPalette();
  scheduleUsage();
  clearHover();
  const faces = renderer.setVolume(volume, built.faces);

  const box = built.box;
  if (box) camera.fit(box, canvas.width || 800, canvas.height || 600);

  // The carve has now seen every drawing, so none of them is ahead of it.
  state.editedViews.clear();
  refreshViewsAhead();
  refreshEmptyViewport();
  markModeChips();
  refreshView2dEmpty();
  refreshView2dReadout();
  drawView2d();
  updateStats(stats, faces, box);
  updateZoomLabel();
  updateFramePreview();
  refreshMapPanel();
  // The solvers turn and mirror views inside the carve, so the slots have to be
  // redrawn afterwards. Showing them untouched while the model had been turned
  // meant pressing H fought an invisible flip - and locked the view into a state
  // that was never visible.
  refreshSlots();
  refreshVoxAvailability();
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
  } else if (state.trimmed.length > 0) {
    status(state.trimmed[0].kept ? 'status.spikePlaced' : 'status.spikeTrimmed', {
      n: volume.solidCount,
      axis: ['axis.' + state.trimmed[0].axis],
      pct: Math.round(state.trimmed[0].amount * 100),
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
 * @param {{min: number[], max: number[]}|null} [bounds] the box, when the caller
 *   already has it. Walking for it costs a fifth of a second at 512, and a
 *   fresh build is handed the box by the worker that carved it.
 */
function updateStats(stats, faces, bounds) {
  const el = $('stats');
  el.textContent = '';
  if (!stats || !state.volume) {
    const row = document.createElement('div');
    row.textContent = t('stats.none');
    el.appendChild(row);
    return;
  }

  const b = bounds ?? state.volume.bounds();
  const size = b
    ? (b.max[0] - b.min[0] + 1) + '×' + (b.max[1] - b.min[1] + 1) + '×' + (b.max[2] - b.min[2] + 1)
    : '—';

  /** @type {Array<[string, string]>} */
  const rows = [
    ['stats.voxels', num(stats.solid)],
    ['stats.faces', num(faces)],
    ['stats.extent', size],
    ['stats.palette', String(state.palette.live)],
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


// ------------------------------------------------------- disagreement map

/**
 * Where the six drawings disagree, drawn over the model.
 *
 * Nothing here edits anything. The map is a second colouring of the same
 * exposed faces: its own instance buffer, its own six-colour lookup texture,
 * and the model's own palette and face bytes left exactly where they were
 * (`docs/ROADMAP.md`, "Карта расхождений"; the screen is specified in
 * `docs/specs/2026-09-24-3-disagreement-map.md`).
 */

/** Band colours, loudest first, as the stylesheet defines them. */
const MAP_VARS = ['--map-max', '--map-high', '--map-mid', '--map-low', '--map-agree', '--map-none'];

/**
 * The ranges beside each band. Numbers and symbols, so they are not
 * translated - and they are written here rather than derived so that the scale
 * on screen reads the way the thresholds do in `disagree.js`.
 */
const BAND_RANGES = ['\u2265 50', '25\u201350', '10\u201325', '3\u201310', '< 3', '\u2014'];

/**
 * The map's instances, cached: building them walks every solid voxel, and the
 * checkbox may be flicked on and off while the artist looks. Dropped whenever
 * the model or the map changes.
 * @type {{buffer: ArrayBuffer, count: number} | null}
 */
let mapFaces = null;

/** Why the map cannot be shown, as an i18n key, or null when it can. */
function mapDisabledReason() {
  // Looking at the model and painting a drawing are two modes, and they do not
  // combine (`docs/DESIGN.md` section 6, rule 7).
  if (state.mode === '2d') return 'view2d.mapOff';
  if (state.building) return 'view.mapBuilding';
  if (!state.volume || state.volume.solidCount === 0) return 'view.mapNoModel';
  if (!state.map) return 'view.mapNoData';
  return null;
}

/** The six band colours as 0..255 triples, read out of the active theme. */
function bandColours() {
  return MAP_VARS.map((name) => {
    const [r, g, b] = cssColorToGl(name);
    return /** @type {[number, number, number]} */ (
      [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]);
  });
}

/**
 * A count for a 56px monospaced column: nine digits fit, more do not, and a
 * column that grows or wraps would take the scale apart. Past that the order of
 * magnitude is what the number is for anyway.
 * @param {number} n
 */
function shortCount(n) {
  const full = num(n);
  if (full.length <= 9) return full;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'G';
  return (n / 1e6).toFixed(1) + 'M';
}

/** The lookup texture and the instances the viewport should be drawing. */
function applyViewColours() {
  if (!state.volume) return;
  if (state.mapOn && state.map) {
    if (!mapFaces) mapFaces = mapInstances(state.volume, state.map);
    renderer.setPaletteData(bandTextureData(bandColours()));
    renderer.setVolume(state.volume, mapFaces);
    // The map lives on voxel faces, and the smooth mesh has none; the face tint
    // would move a colour further than the gap between two bands, which would
    // make the scale a lie (spec §10.2).
    renderer.useSmooth = false;
    renderer.shade = 0;
  } else {
    renderer.setPalette(state.palette);
    renderer.setVolume(state.volume);
    renderer.useSmooth = smoothPreviewOn();
    if (renderer.useSmooth) {
      renderer.setSmoothMesh(buildSmoothMesh(state.volume, { relax: relaxAmount() }));
    }
    renderer.shade = /** @type {HTMLInputElement} */ ($('shade-toggle')).checked ? 1 : 0;
  }
  state.dirty = true;
}

/** The palette texture, unless the map is borrowing it. */
function uploadPalette() {
  if (state.mapOn) return;
  renderer.setPalette(state.palette);
}

/** The checkbox, its one line of explanation, the figures and the scale. */
function refreshMapPanel() {
  const box = /** @type {HTMLInputElement} */ ($('map-toggle'));
  const why = mapDisabledReason();
  box.disabled = why !== null;
  box.checked = state.mapOn;

  // One line under the checkbox, never two: either what the map does or why it
  // cannot run (`docs/DESIGN.md`, section 6 - a control that goes dark says so).
  const hint = $('map-hint');
  hint.textContent = t(why ?? 'view.mapHint');
  hint.classList.toggle('warn', why !== null);

  $('map-block').classList.toggle('hidden', !state.mapOn);
  $('map-export-note').classList.toggle('hidden', !state.mapOn);
  $('map-smooth-note').classList.toggle('hidden', !state.mapOn);
  if (!state.mapOn || !state.map) return;

  const map = state.map;
  $('map-readout').textContent = map.disputed === 0
    ? t('view.mapNone')
    : t('view.mapCount', {
      n: map.disputed,
      total: map.total,
      pct: (map.total ? (100 * map.disputed) / map.total : 0).toFixed(1),
    });

  const host = $('map-scale');
  host.textContent = '';
  for (let i = 0; i < BANDS.length; i++) {
    const row = document.createElement('div');
    row.className = 'scale-row' + (map.counts[i] === 0 ? ' empty' : '');
    const chip = document.createElement('span');
    chip.className = 'scale-chip';
    chip.style.background = 'var(' + MAP_VARS[i] + ')';
    const range = document.createElement('span');
    range.className = 'scale-range';
    range.textContent = BAND_RANGES[i];
    const name = document.createElement('span');
    name.className = 'scale-name';
    name.textContent = t(BANDS[i].key);
    const count = document.createElement('span');
    count.className = 'scale-count';
    count.textContent = shortCount(map.counts[i]);
    row.append(chip, range, name, count);
    host.appendChild(row);
  }
}

/**
 * Turn the map on or off.
 *
 * On: the tool goes back to Rotate, the block is dropped and the six editing
 * tools go dark. Painting a model whose colours are not on screen is a trap,
 * and the block's actions are edits (spec §10.5). Off: the model comes back in
 * its own colours and Rotate stays - silently re-arming an eraser would be
 * worse than leaving the safe tool selected.
 *
 * @param {boolean} on
 */
function setMapMode(on) {
  const want = on && mapDisabledReason() === null;
  if (want === state.mapOn) {
    refreshMapPanel();
    return;
  }
  state.mapOn = want;
  if (want) {
    clearSelection();
    setTool('orbit');
  }
  clearHover();
  applyViewColours();
  markActiveTool();
  refreshToolControls();
  refreshMapPanel();
  if (want && state.map) {
    status('status.mapOn', { n: state.map.disputed, total: state.map.total });
  } else if (!want) {
    status('status.ready');
  }
}

/** The map is made of the drawings; a new model means a new map or none. */
function dropMap(map = null) {
  if (state.mapOn) setMapMode(false);
  state.map = map;
  mapFaces = null;
  refreshMapPanel();
}

/**
 * What the map says about the voxel under the cursor.
 *
 * `updateHover` gives up as soon as the tool is Rotate, and Rotate is exactly
 * the tool the map mode runs in, so the map does its own reading here. It only
 * reads: no outline, no highlight, no armed face - the pointer promises
 * nothing in this mode.
 *
 * @param {{x: number, y: number, z: number}} hit
 */
function mapHoverLine(hit) {
  const map = state.map;
  const at = map ? mapAt(map, hit.x, hit.y, hit.z) : null;
  // Coordinates as strings: as numbers they would be given thousands
  // separators, and "1,024" is not a coordinate.
  const where = { x: String(hit.x), y: String(hit.y), z: String(hit.z) };
  if (!at) {
    setHoverLine('status.mapUnknown', where);
    return;
  }
  const nameOf = (i) => t('views.' + VIEW_NAMES[i]);
  if (at.band === BAND_LONELY || at.viewB === 255) {
    setHoverLine('status.mapLonely', { ...where, a: nameOf(at.viewA) });
    return;
  }
  setHoverLine('status.mapHit', {
    ...where,
    a: nameOf(at.viewA),
    b: nameOf(at.viewB),
    d: at.delta.toFixed(1),
    ha: state.palette.hex(at.colorA),
    hb: state.palette.hex(at.colorB),
  });
}

/** @param {PointerEvent} e */
function updateMapHover(e) {
  const vol = state.volume;
  if (!vol) return;
  const [sx, sy] = canvasPoint(e);
  const ray = screenRay(camera, sx, sy, canvas.width, canvas.height);
  const hit = raycastVoxel(vol, ray.origin, ray.dir);
  if (!hit) {
    clearHover();
    return;
  }
  updateCellGrid(hit);
  const key = ((hit.x * vol.ny + hit.y) * vol.nz + hit.z) * 6 + hit.face;
  if (key === hoverKey) return;
  hoverKey = key;
  mapHoverLine(hit);
}

/**
 * Run something with the model's own colours on the GPU, whatever the viewport
 * is showing. Every export goes through the model, never the map (spec §6.6).
 * @template T @param {() => T} fn
 */
function withModelColours(fn) {
  if (!state.mapOn) return fn();
  const on = state.mapOn;
  state.mapOn = false;
  applyViewColours();
  try {
    return fn();
  } finally {
    state.mapOn = on;
    applyViewColours();
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

/**
 * The pair that says what the viewport is showing.
 *
 * The glyphs are not translated: `3D` and `2D` read the same in both
 * languages, like the numbers on the disagreement scale. The meaning is in the
 * title (screen spec, section 7).
 */
const MODE_CHIPS = /** @type {const} */ ([
  { mode: '3d', label: '3D', key: 'view2d.toModel' },
  { mode: '2d', label: '2D', key: 'view2d.toDrawing' },
]);

function buildModeChips() {
  const host = $('mode-chips');
  host.innerHTML = '';
  for (const chip of MODE_CHIPS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.mode = chip.mode;
    b.textContent = chip.label;
    b.title = t(chip.key);
    b.addEventListener('click', () => setMode(chip.mode));
    host.appendChild(b);
  }
  markModeChips();
}

/** The 2D chip is dark when there is nothing to paint and nothing to project. */
function mode2dAvailable() {
  return state.views.size > 0 || !!(state.volume && state.volume.solidCount > 0);
}

function markModeChips() {
  const available = mode2dAvailable();
  for (const el of $('mode-chips').querySelectorAll('button')) {
    const b = /** @type {HTMLButtonElement} */ (el);
    const on = b.dataset.mode === state.mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
    b.disabled = b.dataset.mode === '2d' && !available && state.mode !== '2d';
  }
}

/**
 * The second group in the overlay: five camera angles in 3D, the six drawings
 * in 2D. One row, so it always answers the same question - what am I looking
 * at - whichever mode is on.
 *
 * One row means one tab stop, arrows inside, in *both* modes (screen spec
 * section 8; `#mode-chips` next to it already works this way). The row is a
 * single control whose contents swap with the mode; giving the keyboard one
 * path in 2D and six tab stops in 3D would change the way the row behaves
 * under a user who only pressed P.
 */
function buildAngleChips() {
  const host = $('angle-chips');
  host.innerHTML = '';
  host.setAttribute('role', 'radiogroup');
  host.setAttribute('aria-label', t(state.mode === '2d' ? 'views.heading' : 'view.heading'));
  if (state.mode === '2d') {
    for (const name of VIEW_NAMES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.view = name;
      b.dataset.i18n = 'views.' + name;
      b.textContent = t('views.' + name);
      b.addEventListener('click', () => showView2d(name));
      host.appendChild(b);
    }
  } else {
    for (const chip of ANGLE_CHIPS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
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
  }
  markActiveChip();
}

function markActiveChip() {
  const buttons = /** @type {NodeListOf<HTMLButtonElement>} */
    ($('angle-chips').querySelectorAll('button'));
  const deg = ((camera.yaw / DEG) % 360 + 360) % 360;
  let active = -1;
  buttons.forEach((b, i) => {
    const on = state.mode === '2d'
      ? b.dataset.view === state.view2d
      : !!ANGLE_CHIPS[i] && Math.abs(deg - ANGLE_CHIPS[i].yaw) < 0.01;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    if (on && active < 0) active = i;
  });
  // A camera turned by hand matches no chip, and a row where every button is
  // tabIndex -1 would be unreachable from the keyboard at all: the first chip
  // holds the stop until one of them is current again.
  const stop = active < 0 ? 0 : active;
  buttons.forEach((b, i) => { b.tabIndex = i === stop ? 0 : -1; });
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
  const drawing = state.mode === '2d';
  $('zoom-label').textContent = (drawing ? state.zoom2d : camera.pixelsPerVoxel) + '×';
  // Saying "there is no grid yet, and here is the zoom that brings it" beats
  // leaving an empty viewport to be worked out. The same checkbox drives the
  // grid in both modes, so the line under it names the threshold of the mode
  // that is on (screen spec, section 6.5).
  $('bounds-hint').textContent = drawing
    ? t('view2d.gridHint', { min: GRID_MIN_CELL_PX, now: state.zoom2d })
    : t('view.boundsHint', { min: GRID_MIN_ZOOM, now: camera.pixelsPerVoxel });
}

/** @param {number} delta */
function zoomBy(delta) {
  if (state.mode === '2d') {
    state.zoom2d = Math.max(1, Math.min(64, state.zoom2d + delta));
    updateZoomLabel();
    drawView2d();
    return;
  }
  camera.pixelsPerVoxel = Math.max(1, Math.min(64, camera.pixelsPerVoxel + delta));
  // The patch belongs to a cell under a cursor that has not moved since; at a
  // new zoom it may not be drawn at all.
  renderer.clearGrid();
  updateZoomLabel();
  state.dirty = true;
}

// --------------------------------------------------------- drawing mode

/**
 * Painting the drawings themselves, without leaving the tab.
 *
 * The heavy half was written for the round trip (`src/core/viewsheet.js`):
 * `projectView` turns a model back into any of the six drawings, and the
 * slicer reads a sheet back in. What is added here is a flat canvas and the
 * brush over it - no second carve, no second projection, no format of our own.
 * The screen is specified in
 * `docs/specs/2026-09-24-3-view-editing-2d-3d.md`.
 *
 * The one rule that holds the mode together: **painting a drawing does not
 * touch the model.** A carve costs 1.1 s at 256 and 11 s at 512
 * (`docs/TESTING.md`, `tests/perf`), so a rebuild per brush stroke would put a
 * progress bar under every dab. The model catches up when "Build model" is
 * pressed, and until then the panel says out loud which drawings are ahead of
 * it (spec 4.4 and 3.4).
 */

const view2d = /** @type {HTMLCanvasElement} */ ($('view2d'));

/**
 * Lowest zoom at which the cell grid is drawn over a drawing, in screen pixels
 * per grid cell.
 *
 * Not a new number: `DECISIONS.md` fixes the floor of readability at 6 px - a
 * 1 px line with a 5 px hole beside it - and `GRID_MIN_ZOOM` is that floor
 * divided by the 0.5774 voxel the tightest cell spans under the 2:1 dimetric.
 * A drawing faces the screen square on, the foreshortening is 1, and the same
 * floor lands on 6 px of cell (spec 4.2). At one art pixel per cell that is
 * zoom 6; on art denser than the grid the grid appears sooner, because a cell
 * is then wider than a pixel.
 */
const GRID_MIN_CELL_PX = 6;

/**
 * Cost of projecting one view, in milliseconds at a 512 grid.
 *
 * Measured, not guessed: the screen specification's browser run gives 38 ms at
 * 128, 256 ms at 256 and 1943 ms at 512, which is the cube law within the
 * noise. Node agrees on the shape of the curve and is faster in absolute terms
 * - 171 / 438 / 1181 ms at 256 / 384 / 512 on a worst case where almost every
 * ray walks the whole depth (measured 2026-09-24) - so the figure quoted to
 * the user is the slower of the two. Saying the price for the grid that is
 * actually selected is the point; "this may take a while" is what it replaces
 * (spec 6.4).
 */
const PROJECT_MS_AT_512 = 1943;

/** Rows per progress step: silence never covers more than a sixteenth. */
const PROJECT_STEPS = 16;

/** Grids from which the projection shows a bar; below it is under a third of a second. */
const PROJECT_BAR_FROM = 384;

/** @param {number} n grid size @returns {string} seconds, as the button says them */
function projectCost(n) {
  const sec = (PROJECT_MS_AT_512 * (n / 512) ** 3) / 1000;
  // Never "0.00 s": a price of zero reads as a broken readout rather than as a
  // cheap operation, and at 16 or 24 the walk really is under a hundredth.
  if (sec < 0.01) return '0.01';
  return sec < 0.1 ? sec.toFixed(2) : sec.toFixed(1);
}

/**
 * A CSS custom property, as a colour string the 2D context understands.
 * Read rather than written down: a theme switch has to reach the canvas too
 * (`docs/DESIGN.md` section 2 - no colour is spelled out in code).
 * @param {string} name
 */
function themeVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The drawing on screen, or null when this slot is empty. */
function currentDrawing() {
  return state.views.get(state.view2d) ?? null;
}

/**
 * Where the drawing sits on the canvas, in CSS pixels.
 *
 * `w` and `h` are the size *after* the slot's quarter turn, because what the
 * canvas shows is the drawing as the carve sees it (spec 4.3), and a turned
 * drawing swaps its sides.
 */
function view2dLayout() {
  const view = currentDrawing();
  if (!view) return null;
  const turned = view.rotate % 180 !== 0;
  const w = turned ? view.image.height : view.image.width;
  const h = turned ? view.image.width : view.image.height;
  const z = state.zoom2d;
  const cw = view2d.clientWidth || 1;
  const ch = view2d.clientHeight || 1;
  return {
    view, w, h, z, cw, ch,
    ox: Math.round((cw - w * z) / 2) + state.pan2d.x,
    oy: Math.round((ch - h * z) / 2) + state.pan2d.y,
  };
}

/** The whole zoom that fits the drawing with an 8% margin, as `camera.fit` does. */
function fitView2d() {
  state.pan2d = { x: 0, y: 0 };
  const l = view2dLayout();
  if (!l) return;
  const z = Math.floor(Math.min((l.cw * 0.84) / l.w, (l.ch * 0.84) / l.h));
  state.zoom2d = Math.max(1, Math.min(64, z));
  updateZoomLabel();
}

/**
 * Turn a point on the canvas into a pixel of the drawing as it is displayed.
 * @param {{clientX: number, clientY: number}} e
 * @returns {[number, number] | null} null when the point is off the drawing
 */
function view2dPixel(e) {
  const l = view2dLayout();
  if (!l) return null;
  const rect = view2d.getBoundingClientRect();
  const a = Math.floor((e.clientX - rect.left - l.ox) / l.z);
  const b = Math.floor((e.clientY - rect.top - l.oy) / l.z);
  if (a < 0 || b < 0 || a >= l.w || b >= l.h) return null;
  return [a, b];
}

/**
 * The source pixel a displayed pixel came from.
 *
 * The inverse of what `drawThumb` paints and what `SourceView.toSource` does
 * for the carve - the same four cases, over the whole image rather than over
 * its trimmed content, because the editor writes into raw pixels.
 * @param {import('./core/views.js').SourceView} view
 * @param {number} a @param {number} b
 * @returns {[number, number]}
 */
function sourcePixel(view, a, b) {
  const w = view.image.width, h = view.image.height;
  let tx, ty;
  switch (view.rotate) {
    case 90: tx = b; ty = h - 1 - a; break;
    case 180: tx = w - 1 - a; ty = h - 1 - b; break;
    case 270: tx = w - 1 - b; ty = a; break;
    default: tx = a; ty = b;
  }
  if (view.flipH) tx = w - 1 - tx;
  if (view.flipV) ty = h - 1 - ty;
  return [tx, ty];
}

/** Source pixels per grid cell, as the last build placed the art. */
const cellInPixels = () => (state.fitScale > 1.001 ? state.fitScale : 1);

/** Scratch canvas holding the drawing itself. @type {HTMLCanvasElement | null} */
let drawingScratch = null;

/** Push the drawing's bytes onto the scratch canvas the compositor draws from. */
function refreshDrawingScratch() {
  const view = currentDrawing();
  if (!view) {
    drawingScratch = null;
    return;
  }
  if (!drawingScratch) drawingScratch = document.createElement('canvas');
  drawingScratch.width = view.image.width;
  drawingScratch.height = view.image.height;
  const ctx = drawingScratch.getContext('2d');
  if (ctx) ctx.putImageData(toImageData(view.image), 0, 0);
}

/** Repaint the flat viewport. Cheap: one `drawImage` plus a frame and a grid. */
function drawView2d() {
  if (state.mode !== '2d') return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = view2d.clientWidth || 1;
  const ch = view2d.clientHeight || 1;
  if (view2d.width !== Math.round(cw * dpr) || view2d.height !== Math.round(ch * dpr)) {
    view2d.width = Math.round(cw * dpr);
    view2d.height = Math.round(ch * dpr);
  }
  const ctx = view2d.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);

  const l = view2dLayout();
  if (!l || !drawingScratch) return;
  const pw = l.w * l.z, ph = l.h * l.z;

  // The transparency check is 8 screen pixels whatever the zoom, exactly as it
  // is in a slot: it is a property of the surface, not of the picture.
  ctx.save();
  ctx.beginPath();
  ctx.rect(l.ox, l.oy, pw, ph);
  ctx.clip();
  ctx.fillStyle = themeVar('--checker-b') || '#12151d';
  ctx.fillRect(l.ox, l.oy, pw, ph);
  ctx.fillStyle = themeVar('--checker-a') || '#1a1e28';
  for (let y = 0; y < ph; y += 8) {
    for (let x = ((y / 8) % 2) * 8; x < pw; x += 16) {
      ctx.fillRect(l.ox + x, l.oy + y, 8, 8);
    }
  }
  ctx.restore();

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(l.ox + pw / 2, l.oy + ph / 2);
  ctx.rotate((l.view.rotate * Math.PI) / 180);
  // Flips happen in the drawing's own space, before the turn - the same order
  // `drawThumb` and the sampler use.
  ctx.scale(l.view.flipH ? -1 : 1, l.view.flipV ? -1 : 1);
  const sw = l.view.image.width * l.z, sh = l.view.image.height * l.z;
  ctx.drawImage(drawingScratch, -sw / 2, -sh / 2, sw, sh);
  ctx.restore();

  // The cell grid, when a cell is wide enough to aim into and the checkbox that
  // draws the grid on the model is on.
  const cellPx = l.z * cellInPixels();
  if (/** @type {HTMLInputElement} */ ($('bounds-toggle')).checked && cellPx >= GRID_MIN_CELL_PX) {
    ctx.strokeStyle = themeVar('--line-soft') || '#1c202a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= pw + 0.5; x += cellPx) {
      ctx.moveTo(Math.round(l.ox + x) + 0.5, l.oy);
      ctx.lineTo(Math.round(l.ox + x) + 0.5, l.oy + ph);
    }
    for (let y = 0; y <= ph + 0.5; y += cellPx) {
      ctx.moveTo(l.ox, Math.round(l.oy + y) + 0.5);
      ctx.lineTo(l.ox + pw, Math.round(l.oy + y) + 0.5);
    }
    ctx.stroke();
  }

  ctx.strokeStyle = themeVar('--line') || '#262b38';
  ctx.lineWidth = 1;
  ctx.strokeRect(l.ox - 0.5, l.oy - 0.5, pw + 1, ph + 1);
}

/** One monospaced line: how big the drawing is and how it lands on the grid. */
function refreshView2dReadout() {
  const el = $('view2d-readout');
  const l = state.mode === '2d' ? view2dLayout() : null;
  if (!l) {
    el.textContent = '';
    return;
  }
  const k = cellInPixels();
  el.textContent = k > 1.001
    ? t('view2d.scaled', { w: l.w, h: l.h, n: state.gridSize, k: k.toFixed(2) })
    : t('view2d.exact', { w: l.w, h: l.h, n: state.gridSize });
}

/** The invitation shown where a drawing would be, and the price of filling it. */
function refreshView2dEmpty() {
  const host = $('view2d-empty');
  const empty = state.mode === '2d' && !currentDrawing();
  host.classList.toggle('hidden', !empty);
  if (!empty) return;

  const hasModel = !!state.volume && state.volume.solidCount > 0;
  $('view2d-empty-title').textContent = t(hasModel ? 'view2d.empty' : 'view2d.noModel');

  const take = /** @type {HTMLButtonElement} */ ($('btn-view-take'));
  const blank = /** @type {HTMLButtonElement} */ ($('btn-view-blank'));
  take.textContent = t('view2d.take');
  blank.textContent = t('view2d.blank', { n: state.gridSize });
  take.disabled = !hasModel || state.building;
  blank.disabled = state.building;

  // The reason a button is dark stands under it, and so does the price of the
  // one that is lit: a number of seconds for this grid, not "this may be slow".
  $('view2d-empty-cost').textContent = state.building
    ? t('view2d.building')
    : hasModel ? t('view2d.takeCost', { s: projectCost(state.gridSize), n: state.gridSize }) : '';
  $('view2d-empty-note').textContent = hasModel && !state.building ? t('view2d.takeNote') : '';
}

/** Which drawings the model has not seen, under the button that would fix it. */
function refreshViewsAhead() {
  const el = $('views-ahead');
  const names = VIEW_NAMES.filter((n) => state.editedViews.has(n) && state.views.has(n));
  el.classList.toggle('hidden', names.length === 0);
  if (names.length === 0) return;
  el.textContent = t('grid.viewsAhead', { views: names.map((n) => t('views.' + n)).join(', ') });
}

/** @param {string} name */
function markViewEdited(name) {
  state.editedViews.add(name);
  refreshViewsAhead();
  refreshSlots();
}

/**
 * Show a drawing. Keeps the zoom when the size has not changed, so stepping
 * through the six views does not throw the artist's zoom away each time.
 * @param {string} name
 */
function showView2d(name) {
  const before = view2dLayout();
  state.view2d = name;
  refreshDrawingScratch();
  const after = view2dLayout();
  if (!before || !after || before.w !== after.w || before.h !== after.h) fitView2d();
  clearHover();
  markActiveChip();
  refreshView2dEmpty();
  refreshView2dReadout();
  updateZoomLabel();
  drawView2d();
}

/**
 * Switch between the model and the drawings.
 *
 * The two modes do not overlap: `#gl` goes away entirely while a drawing is on
 * screen, and the disagreement map - which is a way of *looking* at the model -
 * goes with it (`docs/DESIGN.md` section 6, rule 7).
 * @param {'3d'|'2d'} mode
 */
function setMode(mode) {
  if (mode === state.mode) return;
  if (mode === '2d' && !mode2dAvailable()) return;
  if (mode === '2d' && state.mapOn) setMapMode(false);
  state.mode = mode;
  // A block lives in the volume; there is nothing to select on a drawing.
  if (mode === '2d') clearSelection();
  clearHover();
  canvas.classList.toggle('hidden', mode === '2d');
  view2d.classList.toggle('hidden', mode !== '2d');
  refreshEmptyViewport();
  buildAngleChips();
  markModeChips();
  markActiveTool();
  refreshToolControls();
  refreshMapPanel();
  if (mode === '2d') {
    refreshDrawingScratch();
    fitView2d();
  }
  refreshView2dEmpty();
  refreshView2dReadout();
  updateZoomLabel();
  drawView2d();
  state.dirty = true;
}

/** The 3D invitation belongs to the 3D viewport and goes away with it. */
function refreshEmptyViewport() {
  const hasModel = !!state.volume && state.volume.solidCount > 0;
  $('viewport-empty').classList.toggle('hidden', state.mode === '2d' || hasModel);
}

// ------------------------------------------------ filling an empty drawing

/** @param {string} name @param {{width: number, height: number, data: Uint8ClampedArray}} img */
function putDrawing(name, img) {
  setView(name, /** @type {any} */ (img));
  markViewEdited(name);
  refreshDrawingScratch();
  fitView2d();
  refreshView2dEmpty();
  refreshView2dReadout();
  updateZoomLabel();
  markModeChips();
  drawView2d();
}

/** A blank square at the grid's own size - see `blankSheet` for why square. */
function makeBlankDrawing() {
  const n = state.gridSize;
  putDrawing(state.view2d, blankSheet(n));
  status('view2d.blankMade', { n, view: ['views.' + state.view2d] });
}

/** True while a projection is walking the model, so a second press is refused. */
let projecting = false;

/**
 * Take the missing drawing off the model.
 *
 * Spread over frames rather than run in one blocking call: at 512 the walk
 * costs about two seconds, and `docs/DESIGN.md` section 6 wants a bar on
 * anything over a second. Sixteen steps, so silence never covers more than a
 * sixteenth of the work.
 */
async function takeDrawingFromModel() {
  const vol = state.volume;
  if (!vol || vol.solidCount === 0 || state.building || projecting) return;
  const name = state.view2d;
  const N = vol.nx;
  if (vol.ny !== N || vol.nz !== N) return;

  projecting = true;
  const bar = N >= PROJECT_BAR_FROM;
  const out = new Uint8ClampedArray(N * N * 4);
  const step = Math.max(1, Math.ceil(N / PROJECT_STEPS));
  try {
    for (let v = 0; v < N; v += step) {
      const end = Math.min(N, v + step);
      projectViewRows(vol, state.palette, name, v, end, out);
      if (bar) {
        showProjectProgress(end / N);
        status('view2d.projecting', { view: ['views.' + name] });
        await nextFrame();
      }
    }
  } finally {
    projecting = false;
    if (bar) showBuildProgress(null);
  }

  let opaque = 0;
  for (let i = 3; i < out.length; i += 4) if (out[i] >= 128) opaque++;
  putDrawing(name, { width: N, height: N, data: out });
  if (opaque === 0) status('view2d.takenEmpty', undefined, 'warn');
  else status('view2d.taken', { view: ['views.' + name], n: opaque });
}

/**
 * The same bar the build uses, without the build's own wording: the projection
 * says what it is doing in the status line itself.
 * @param {number} fraction 0..1
 */
function showProjectProgress(fraction) {
  const host = $('build-progress');
  const pct = Math.round(fraction * 100);
  host.classList.remove('hidden');
  host.setAttribute('aria-valuenow', String(pct));
  /** @type {HTMLElement} */ ($('build-progress-fill')).style.width = pct + '%';
}

// ------------------------------------------------------- drawing with tools

/** The stroke being painted on a drawing, or null. @type {ViewStroke | null} */
let stroke2d = null;

/** Where the 2D stroke last applied, in displayed pixels. @type {[number, number] | null} */
let stroke2dLast = null;

/** Open a stroke on the drawing on screen. */
function beginStroke2d() {
  const view = currentDrawing();
  if (!view) return;
  stroke2d = new ViewStroke(state.view2d, /** @type {any} */ (view.image));
}

/**
 * Close the stroke: one undo step, one line in the status bar, one redraw of
 * the thumbnail - and the trim recomputed, because where the ink stops is what
 * decides how the drawing lands on the grid.
 */
function endStroke2d() {
  const s = stroke2d;
  stroke2d = null;
  if (!s) return;
  const entry = s.finish();
  if (!entry) {
    // `status.editedNothing` talks about a face already wearing the colour,
    // which is not what happened here; the same line with a zero is the honest
    // one, and it names the drawing the hand was over.
    if (state.tool !== 'pick' && state.tool !== 'orbit') {
      hoverLine = null;
      status('view2d.stroke', { view: ['views.' + s.name], n: 0 }, 'warn');
    }
    return;
  }
  state.history.pushView(entry);
  afterDrawingChanged(s.name);
  hoverLine = null;
  status('view2d.stroke', { view: ['views.' + s.name], n: s.count });
  refreshHistoryButtons();
}

/**
 * Everything that has to follow a drawing changing, whoever changed it - a
 * stroke, an undo or a redo.
 * @param {string} name
 */
function afterDrawingChanged(name) {
  const view = state.views.get(name);
  if (view) view.computeTrim();
  markViewEdited(name);
  if (name === state.view2d) {
    refreshDrawingScratch();
    refreshView2dReadout();
    drawView2d();
  }
}

/**
 * Run the armed tool at one point of the drawing.
 * @param {number} a @param {number} b displayed pixel
 * @returns {boolean} the pointer was over the drawing
 */
function runTool2dAt(a, b) {
  const view = currentDrawing();
  if (!view || state.tool === 'orbit') return false;
  const img = /** @type {any} */ (view.image);
  const [x, y] = sourcePixel(view, a, b);

  if (state.tool === 'pick') {
    const picked = pickAt(img, x, y);
    if (picked === null) {
      hoverLine = null;
      status('view2d.pickEmpty', undefined, 'warn');
      return true;
    }
    const idx = state.palette.add((picked >> 16) & 255, (picked >> 8) & 255, picked & 255);
    uploadPalette();
    refreshPalette();
    selectSwatch(idx);
    focusSwatch(idx);
    hoverLine = null;
    status('status.picked', { i: idx, hex: state.palette.hex(idx) });
    return true;
  }

  if (!stroke2d) beginStroke2d();
  const s = stroke2d;
  if (!s) return false;
  const rgb = state.palette.colors[state.color] | 0;
  if (state.tool === 'paint') s.count += paintAt(img, x, y, brushRadius(), rgb);
  else if (state.tool === 'erase') s.count += eraseAt(img, x, y, brushRadius());
  else if (state.tool === 'fill') s.count += fillAt(img, x, y, rgb).count;
  refreshDrawingScratch();
  drawView2d();
  return true;
}

/**
 * What is under the cursor, in the status line.
 * @param {PointerEvent} e
 */
function updateHover2d(e) {
  const view = currentDrawing();
  const at = view ? view2dPixel(e) : null;
  if (!view || !at) {
    if (hoverLine) {
      hoverLine = null;
      renderStatus();
    }
    return;
  }
  const [x, y] = sourcePixel(view, at[0], at[1]);
  const img = view.image;
  const o = (y * img.width + x) * 4;
  const where = { view: ['views.' + state.view2d], x: String(at[0]), y: String(at[1]) };
  if (img.data[o + 3] < 128) {
    setHoverLine('view2d.hoverEmpty', where);
    return;
  }
  const hex = '#' + [img.data[o], img.data[o + 1], img.data[o + 2]]
    .map((v) => v.toString(16).padStart(2, '0')).join('');
  setHoverLine('view2d.hover', { ...where, hex });
}

/** True when the viewport has changed size since the flat canvas was drawn. */
function view2dNeedsResize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  return view2d.width !== Math.round((view2d.clientWidth || 1) * dpr)
    || view2d.height !== Math.round((view2d.clientHeight || 1) * dpr);
}

function setupPointer2d() {
  let mode = /** @type {null | 'pan' | 'tool'} */ (null);
  let lastX = 0, lastY = 0;

  view2d.addEventListener('contextmenu', (e) => e.preventDefault());

  view2d.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    lastX = e.clientX;
    lastY = e.clientY;
    try { view2d.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    if (e.button === 1 || e.ctrlKey || e.button === 2 || e.shiftKey || state.tool === 'orbit') {
      mode = 'pan';
      view2d.classList.add('dragging');
      return;
    }
    mode = 'tool';
    const at = view2dPixel(e);
    stroke2dLast = at;
    if (at) runTool2dAt(at[0], at[1]);
  });

  view2d.addEventListener('pointermove', (e) => {
    if (!mode) {
      updateHover2d(e);
      return;
    }
    if (mode === 'pan') {
      state.pan2d.x += e.clientX - lastX;
      state.pan2d.y += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      drawView2d();
      return;
    }
    // A drag is resampled the way a stroke on the model is, so a fast hand
    // leaves a line rather than a dotted trail. Half a pixel of step, because
    // the step is already in the units the tool applies in.
    const at = view2dPixel(e);
    if (!at) return;
    if (stroke2dLast) {
      for (const [sx, sy] of strokeSamples(stroke2dLast[0], stroke2dLast[1], at[0], at[1], 0.5)) {
        runTool2dAt(Math.round(sx), Math.round(sy));
      }
    } else {
      runTool2dAt(at[0], at[1]);
    }
    stroke2dLast = at;
  });

  const end = (/** @type {PointerEvent} */ e) => {
    if (mode === 'tool') endStroke2d();
    mode = null;
    stroke2dLast = null;
    view2d.classList.remove('dragging');
    try {
      if (view2d.hasPointerCapture(e.pointerId)) view2d.releasePointerCapture(e.pointerId);
    } catch { /* not fatal */ }
  };
  view2d.addEventListener('pointerup', end);
  view2d.addEventListener('pointercancel', end);
  view2d.addEventListener('pointerleave', () => {
    if (!hoverLine) return;
    hoverLine = null;
    renderStatus();
  });

  view2d.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
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
  // The sizes identify the views on a three-cell sheet and on a six-cell one,
  // and only when they leave no doubt; anything else is reading order, which is
  // a guess and should not claim to be more than that.
  const confident = solveBySize(sheet.cells) !== null;

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
  const src = sheet;

  /** @type {Array<[string, number]>} */
  const chosen = [];
  for (const el of $('sheet-cells').querySelectorAll('select')) {
    const select = /** @type {HTMLSelectElement} */ (el);
    if (select.value) chosen.push([select.value, +(select.dataset.cell ?? 0)]);
  }
  if (chosen.length === 0) return;

  guardRebuild(() => {
    // A sheet replaces the whole set of views. Keeping leftovers from an earlier
    // load would quietly carve against art the artist has already moved on from.
    state.views.clear();
    for (const [name, index] of chosen) {
      const crop = cropCell(src.image, src.cells[index]);
      setView(name, /** @type {any} */ (crop));
    }
    autoGrid();
    refreshSlots();
    build();
  });
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
];

/**
 * Tools the brush slider does not reach: Fill and Pick work one face at a
 * time, and the Box now takes all three of its sizes from the drag itself. A
 * live slider that changes nothing is a promise the tool does not keep.
 */
const BRUSHLESS_TOOLS = new Set(['orbit', 'fill', 'pick', 'box']);

/**
 * Tools that have nothing to act on in a drawing. Add puts a voxel beside the
 * one under the cursor and the Box marks a volume; a picture has neither.
 */
const TOOLS_OFF_IN_2D = new Set(['add', 'box']);

/** Axis names for the hover line. Not translated: they are axes, not words. */
const FACE_NAMES = ['+X', '\u2212X', '+Y', '\u2212Y', '+Z', '\u2212Z'];

function buildToolBar() {
  const host = $('tool-bar');
  host.innerHTML = '';
  for (const tool of TOOL_BUTTONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.tool = tool.id;
    // One radio group, so eight tools cost one tab stop instead of eight and
    // the arrow keys move the choice - the behaviour a chooser is expected to
    // have, and what keeps the palette below within reach of the keyboard.
    b.setAttribute('role', 'radio');
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
  // A viewing mode has one tool. Asking for another from the keyboard or the
  // toolbar is refused rather than silently obeyed.
  if (state.mapOn && tool !== 'orbit') return;
  // A drawing has no voxels: Add lays a cube and the Box marks a block, and
  // neither has anything to work on here (spec 6.2).
  if (state.mode === '2d' && TOOLS_OFF_IN_2D.has(tool)) return;
  const wasBox = isBoxTool();
  state.tool = tool;
  // A block belongs to the box tool; leaving the tool leaves the block.
  if (wasBox && tool !== 'box') clearSelection();
  markActiveTool();
  refreshToolControls();
  // The old tool's promise is no longer true; the new one makes its own on the
  // next pointer move.
  clearHover();
}

function markActiveTool() {
  for (const b of $('tool-bar').querySelectorAll('button')) {
    const el = /** @type {HTMLElement} */ (b);
    const on = el.dataset.tool === state.tool;
    el.classList.toggle('on', on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
    el.tabIndex = on ? 0 : -1;
  }
  const cursor = state.tool === 'orbit' ? '' : 'tool-' + state.tool;
  canvas.className = (state.mode === '2d' ? 'hidden ' : '') + cursor;
  view2d.className = (state.mode === '2d' ? '' : 'hidden ') + cursor;
}

/**
 * The hint under the toolbar, and the controls the chosen tool does not use.
 *
 * A control that goes dark without a reason beside it is a defect in this
 * project's terms (`docs/DESIGN.md`, section 6), so each one that goes dark
 * brings its own line saying why.
 */
function refreshToolControls() {
  const drawing = state.mode === '2d';
  const hint = $('tool-hint');
  // One line under the row explains everything that is dark there, and the
  // same line covers the two checkboxes below it (`docs/DESIGN.md` section 6,
  // rule 3; spec 6.2 and 6.3) - not one warning each.
  hint.textContent = state.mapOn
    ? t('edit.mapReadOnly')
    : drawing
      ? t('view2d.toolsOff')
      : t(isBoxTool() ? 'edit.boxHint' : 'tool.' + state.tool + '.hint');
  hint.classList.toggle('warn', state.mapOn || drawing);
  for (const b of $('tool-bar').querySelectorAll('button')) {
    const el = /** @type {HTMLButtonElement} */ (b);
    el.disabled = (state.mapOn && el.dataset.tool !== 'orbit')
      || (drawing && TOOLS_OFF_IN_2D.has(el.dataset.tool ?? ''));
  }

  const brush = /** @type {HTMLInputElement} */ ($('brush-size'));
  const brushOff = BRUSHLESS_TOOLS.has(state.tool);
  brush.disabled = brushOff;
  // A brush on a drawing is flat, and a cube in the label would be a lie
  // (spec 10.3). Same slider, same five steps.
  const unit = drawing ? '\u00b2' : '\u00b3';
  $('brush-label').textContent = brushOff ? '\u2014' : (state.brush * 2 + 1) + unit;
  $('brush-note').classList.toggle('hidden', !brushOff);

  const faceOnly = /** @type {HTMLInputElement} */ ($('face-only'));
  const faceOff = drawing || state.tool !== 'paint';
  // Disabling keeps the checkbox's value, so the setting comes back with the
  // brush instead of being silently reset every time another tool is used.
  faceOnly.disabled = faceOff;
  // In the drawing mode the reason is the shared line above; a second warning
  // saying the same thing twice is what rule 3 forbids.
  $('face-only-note').classList.toggle('hidden', drawing || !faceOff);
  // The X mirror measures the centre of the *grid*, not of a drawing, and the
  // parity defect that pairs it with `autoPlace` is still open
  // (`docs/BATCH.md`). Painting a drawing through it would multiply a known
  // mistake, so it goes dark and the shared line says why (spec 6.3).
  /** @type {HTMLInputElement} */ ($('symmetry-x')).disabled = drawing;
}

// --------------------------------------------------------- palette panel

/**
 * How many exposed faces each palette slot paints, and whether the walk
 * finished.
 * @type {{counts: Uint32Array, complete: boolean, measured: boolean}}
 */
let usage = { counts: new Uint32Array(256), complete: false, measured: false };
let usageTimer = 0;

/**
 * Budgets for the usage count. Neither number came from the owner.
 *
 * The count walks every solid voxel, so it must never run inside a stroke: it
 * waits for the hand to stop (300 ms) and then gets 100 ms to finish. A model
 * too large for that reports "not counted" rather than zero, because zero
 * would be read as "this colour is unused" and would dim swatches that paint
 * half the model.
 */
const USAGE_DELAY_MS = 300;
const USAGE_BUDGET_MS = 100;

function scheduleUsage() {
  clearTimeout(usageTimer);
  usageTimer = setTimeout(recountUsage, USAGE_DELAY_MS);
}

function recountUsage() {
  if (!state.volume) {
    usage = { counts: new Uint32Array(256), complete: true, measured: true };
  } else {
    const r = state.volume.countExposedFaces(performance.now() + USAGE_BUDGET_MS);
    usage = { counts: r.counts, complete: r.complete, measured: true };
  }
  applyUsage();
}

/** Push the counts onto the swatches without rebuilding any of them. */
function applyUsage() {
  for (const el of $('palette-box').querySelectorAll('button')) {
    const b = /** @type {HTMLElement} */ (el);
    const i = +(b.dataset.slot ?? 0);
    b.classList.toggle('unused', usage.measured && usage.complete && usage.counts[i] === 0);
    b.title = swatchTitle(i);
  }
  updatePaletteFoot();
  refreshMergeOffer();
  invalidateBakeOffers();
}

/**
 * One line about a slot: which one it is, what colour, how much of the model
 * it paints. The count lives here and under the box rather than on the swatch
 * itself - six digits do not fit in 20 px at any size this project allows.
 * @param {number} i
 */
function swatchLine(i) {
  const hex = state.palette.hex(i);
  if (!usage.measured || !usage.complete) return t('edit.swatchUncounted', { i, hex });
  const n = usage.counts[i];
  return n === 0 ? t('edit.swatchUnused', { i, hex }) : t('edit.swatchInfo', { i, hex, n });
}

/** @param {number} i */
function swatchTitle(i) {
  // The double-click affordance rides along: the tooltip is the only place it
  // is announced at all.
  return swatchLine(i) + ' \u00b7 ' + t('edit.recolour');
}

function updatePaletteFoot() {
  $('palette-foot').textContent = state.palette.size > 1 ? swatchLine(state.color) : '';
}

/**
 * Rebuild the whole box: for when the set of colours changes, not when the
 * selection moves.
 */
function refreshPalette() {
  const host = $('palette-box');
  host.innerHTML = '';
  if (state.color >= state.palette.size) state.color = Math.max(1, state.palette.size - 1);
  // A merged palette has holes in it - after a load or an undo the selection can
  // be sitting on one, and a hole has no swatch to select.
  if (!state.palette.has(state.color)) state.color = state.palette.slots()[0] ?? 1;

  const empty = state.palette.size <= 1;
  host.classList.toggle('empty', empty);
  if (empty) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = t('edit.paletteEmpty');
    host.appendChild(p);
  } else {
    // Bands are hue; the one wider gap between them is the whole notation.
    for (const band of paletteBands(state.palette)) {
      const row = document.createElement('div');
      row.className = 'palette-band';
      for (const i of band) row.appendChild(makeSwatch(i));
      host.appendChild(row);
    }
  }

  $('palette-full-note').classList.toggle('hidden', !state.palette.full);
  applyUsage();
}

/** @param {number} i */
function makeSwatch(i) {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('role', 'radio');
  b.dataset.slot = String(i);
  b.style.background = state.palette.hex(i);
  const on = i === state.color;
  b.classList.toggle('on', on);
  b.setAttribute('aria-checked', on ? 'true' : 'false');
  // Roving tab stop: 255 colours must not cost 255 presses of Tab.
  b.tabIndex = on ? 0 : -1;
  return b;
}

/**
 * Move the selection. Only the two swatches involved change, so choosing a
 * colour never rebuilds the box under the cursor.
 * @param {number} i
 */
function selectSwatch(i) {
  if (!i || i >= state.palette.size) return;
  state.color = i;
  for (const el of $('palette-box').querySelectorAll('button')) {
    const b = /** @type {HTMLElement} */ (el);
    const on = +(b.dataset.slot ?? 0) === i;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  }
  updatePaletteFoot();
  // An outline asked to use the selected colour costs something different for
  // every slot, so the line under that button follows the selection.
  if (/** @type {HTMLInputElement} */ ($('outline-use-color')).checked) invalidateBakeOffers();
}

/** @param {number} i */
function focusSwatch(i) {
  const b = /** @type {HTMLElement|null} */ ($('palette-box').querySelector('[data-slot="' + i + '"]'));
  b?.focus();
}

/**
 * Which swatch an event landed on, or 0.
 *
 * Listening on the box rather than on each button is what lets a double-click
 * survive any redraw the first click causes - and keeps one pair of listeners
 * instead of 255.
 * @param {Event} e
 */
function swatchSlot(e) {
  const el = /** @type {HTMLElement|null} */ (e.target);
  const slot = el && el.dataset ? el.dataset.slot : undefined;
  return slot ? +slot : 0;
}

/**
 * Repaint one swatch without rebuilding the box.
 *
 * A picker drag fires an event per pointer move, and rebuilding 255 buttons
 * each time is what would make an instant operation feel slow. A recoloured
 * slot can belong in another band, so the box is re-sorted once, when the drag
 * ends - never under the cursor mid-drag.
 * @param {number} i
 */
function updateSwatch(i) {
  const b = /** @type {HTMLElement|null} */ ($('palette-box').querySelector('[data-slot="' + i + '"]'));
  if (!b) return;
  b.style.background = state.palette.hex(i);
  b.title = swatchTitle(i);
  updatePaletteFoot();
}

/**
 * The swatch whose colour the open picker is rewriting, and the colour it held
 * when the drag began - the one Ctrl+Z has to restore.
 */
let recolourSlot = 0;
let recolourBefore = 0;

/** @param {number} i */
function openRecolour(i) {
  // Same reason as the drawing tools: the build that is running will replace
  // this palette wholesale when it lands.
  if (state.building) return;
  const input = /** @type {HTMLInputElement} */ ($('edit-color'));
  state.history.endPalette();
  recolourSlot = i;
  recolourBefore = state.palette.colors[i] | 0;
  input.value = state.palette.hex(i);
  // showPicker() opens the picker without focusing a visible control; where it
  // is missing, clicking the input does the same thing.
  const anyInput = /** @type {any} */ (input);
  if (typeof anyInput.showPicker === 'function') {
    try {
      anyInput.showPicker();
      return;
    } catch { /* fall through to click() */ }
  }
  input.click();
}

/**
 * Live recolour. No voxel is read or written and no geometry is rebuilt: the
 * face bytes already say "slot i", so the model is repainted by uploading the
 * 256x1 palette texture, which costs the same at 512 as at 32.
 */
function applyRecolour() {
  if (!recolourSlot) return;
  const input = /** @type {HTMLInputElement} */ ($('edit-color'));
  const n = parseInt(input.value.slice(1), 16);
  if (!Number.isFinite(n)) return;
  if (!state.palette.replace(recolourSlot, (n >> 16) & 255, (n >> 8) & 255, n & 255)) return;
  state.history.pushPalette(recolourSlot, recolourBefore, state.palette.colors[recolourSlot] | 0);
  uploadPalette();
  updateSwatch(recolourSlot);
  // A recolour moves one colour in Lab, so the near-duplicate pairs are not the
  // ones the panel promised a moment ago: measured, #ff8844 + #fe8845 offered
  // "free 1 slot", and recolouring the second to #0078ff left the offer lit
  // while the pair had drifted to dE 52.7. The plan is what the click applies,
  // so it is recomputed here rather than on the press. The undo/redo path gets
  // this through `refreshPalette()` already.
  refreshMergeOffer();
  invalidateBakeOffers();
  state.dirty = true;
  refreshHistoryButtons();
  status('status.colorReplaced', { n: recolourSlot, hex: state.palette.hex(recolourSlot) });
}

/**
 * What a merge would free right now, or null when there is no palette.
 *
 * Kept as state rather than recomputed on the click, because the button has to
 * say whether it would do anything before it is pressed - and because the plan
 * is what the click applies, so the user cannot get a different answer from the
 * one the panel just promised.
 * @type {{remap: Uint8Array, freed: number[], groups: number, worst: number} | null}
 */
let mergePlan = null;

/**
 * Light or dim the merge button and say why, in one line for the pair.
 *
 * The plan is built against the usage counts when they are complete, so the
 * colour painting more of the model is the one that keeps its index. Without
 * counts it falls back to index order, which is still deterministic.
 */
function refreshMergeOffer() {
  const btn = /** @type {HTMLButtonElement} */ ($('btn-merge-colors'));
  const note = $('merge-note');
  const offer = mergeOffer({
    palette: state.palette,
    volume: state.volume,
    building: state.building,
    deltaE: MERGE_DELTA_E,
    weights: usage.measured && usage.complete ? usage.counts : undefined,
  });
  mergePlan = offer.plan;
  btn.disabled = !offer.enabled;
  note.textContent = offer.noteKey ? t(offer.noteKey, offer.noteParams) : '';
  // A reason for something being off wears `.hint.warn`; a plain `.hint` is for
  // a hint about something that works (`docs/DESIGN.md` §8).
  note.classList.toggle('warn', offer.warn);
}

/**
 * Fuse every pair of slots nobody can tell apart, and hand the slots back.
 *
 * Two halves that have to happen together: the face bytes go through the map
 * (`Volume.remapFaces`) and the palette frees the slots the map emptied. One
 * without the other leaves faces pointing at a hole.
 *
 * Undoable as one step. It has to be: the operation rewrites face bytes across
 * the whole model, and an operation that quietly throws hand work away is the
 * defect the rebuild guard was built to end.
 */
function mergeColors() {
  // The button is dark in all three cases (`refreshMergeOffer`), so these are
  // the keyboard and the stale-plan paths rather than the ordinary ones. They
  // still answer out loud: silence on a press is the defect this pair had.
  if (state.building) {
    status('status.buildRunning', undefined, 'warn');
    return;
  }
  if (!state.volume) {
    status('status.noModel', undefined, 'warn');
    return;
  }
  if (!mergePlan || mergePlan.freed.length === 0) {
    status('status.noNearDuplicates', undefined, 'warn');
    return;
  }
  const plan = mergePlan;
  const before = state.palette.snapshot();
  const record = state.volume.remapFaces(plan.remap);
  const freed = state.palette.applyMerge(plan);
  state.history.pushMerge(plan.remap, record, before, state.palette.snapshot());

  // The selection can be one of the slots that just went away; it follows its
  // colour rather than pointing at a hole.
  if (!state.palette.has(state.color)) state.color = plan.remap[state.color] || 1;

  uploadPalette();
  // Every face instance carries its palette byte, so the buffer is stale.
  state.geometryDirty = true;
  refreshPalette();
  scheduleUsage();
  state.dirty = true;
  refreshHistoryButtons();
  status('status.colorsMerged', {
    n: freed,
    g: plan.groups,
    faces: record.changed,
    free: state.palette.free.size,
  });
}

/**
 * Budget for one bake count. Not the owner's number.
 *
 * A bake plan walks every exposed face, and a refresh takes two - one per
 * operation. Nothing of the size people build finishes inside a budget worth
 * having: on a 256 lorry (2 952 960 voxels, Node) a whole count is 282 ms for
 * light and 400 / 463 / 621 ms for an outline of thickness 1 / 2 / 3. So the
 * budget buys a usable floor instead of a freeze, and an unfinished count says
 * out loud that it is a floor (`edit.bakePartial`, `edit.bakeOverflowPartial`).
 * Applying has no budget at all - it happens once, on a press, and a number it
 * did not finish would be a lie rather than a floor.
 *
 * 150 ms is now what 150 ms means: `walkBake` reads the clock on the walk, so
 * both counts stop at 150 ms measured rather than at 369-636 ms. And the pair
 * is bought only when the hand reaches for the section, never after a stroke -
 * see `invalidateBakeOffers`.
 */
const BAKE_BUDGET_MS = 150;

/** Same wait as the usage count, and for the same reason: never inside a stroke. */
const BAKE_DELAY_MS = 300;
let bakeTimer = 0;

/** True while the two notes describe a model that has since changed. */
let bakeStale = true;

/**
 * Say the counts are out of date, and do not pay for new ones.
 *
 * This is what the editing paths call, and it is the whole of the answer to a
 * count that used to run after every stroke. Both plans walk the model, and on
 * the 256 lorry (2 952 960 voxels, measured in Node) one walk costs 289 ms for
 * light and 408 / 469 / 636 ms for an outline of thickness 1 / 2 / 3 - so a
 * refresh of the pair cost up to 925 ms of frozen main thread, 300 ms after
 * every stroke landed. Nobody asked for those numbers: they are read when the
 * hand reaches for the buttons, which is what `countBakeOffers` is for.
 *
 * The answers that need no walk - no model, or a build in flight - are given
 * at once instead: a button that stays lit after a build starts is a button
 * that lies, and it costs nothing to be honest immediately.
 */
function invalidateBakeOffers() {
  clearTimeout(bakeTimer);
  if (state.building || !state.volume || state.palette.live === 0) {
    refreshBakeOffers();
    return;
  }
  bakeStale = true;
  // The button stays live: a press has no budget and walks the whole model, and
  // it answers out loud when there turns out to be nothing to do
  // (`status.bakedNothing`). Dimming it here would be a guess.
  for (const id of ['btn-bake-outline', 'btn-bake-light']) {
    /** @type {HTMLButtonElement} */ ($(id)).disabled = false;
  }
  for (const id of ['bake-outline-note', 'bake-light-note']) {
    const note = $(id);
    note.textContent = t('edit.bakeStale');
    // Not a warning: nothing is wrong, the number is simply not taken yet.
    note.classList.remove('warn');
  }
}

/** Take the counts now, if they are owed. Cheap when they are not. */
function countBakeOffers() {
  if (bakeStale) refreshBakeOffers();
}

/**
 * A bake control changed under the hand, so the counts are owed again - but
 * after the same 300 ms wait, because a slider sends one event per step.
 */
function scheduleBakeOffers() {
  invalidateBakeOffers();
  if (bakeStale) bakeTimer = setTimeout(countBakeOffers, BAKE_DELAY_MS);
}

/** Options the outline buttons act with, read from the two controls. */
function outlineOptions() {
  const thickness = +(/** @type {HTMLInputElement} */ ($('outline-thickness')).value) || 1;
  const useColor = /** @type {HTMLInputElement} */ ($('outline-use-color')).checked;
  return { op: /** @type {'outline'} */ ('outline'), thickness, index: useColor ? state.color : 0 };
}

/** Light or dim both bake buttons and say, under each, what it would cost. */
function refreshBakeOffers() {
  clearTimeout(bakeTimer);
  bakeStale = false;
  // Unlike the merge, the plan is not kept: the press walks the model again
  // with the very same options, and nothing between the count and the click can
  // change what that walk finds. Keeping a copy would only give it a way to go
  // stale.
  /** @type {Array<[string, string, import('./core/bake.js').BakeOptions]>} */
  const pair = [
    ['btn-bake-outline', 'bake-outline-note', outlineOptions()],
    ['btn-bake-light', 'bake-light-note', { op: 'light' }],
  ];
  for (const [btnId, noteId, opts] of pair) {
    const offer = bakeOffer({
      palette: state.palette,
      volume: state.volume,
      building: state.building,
      opts,
      deadline: performance.now() + BAKE_BUDGET_MS,
    });
    /** @type {HTMLButtonElement} */ ($(btnId)).disabled = !offer.enabled;
    const note = $(noteId);
    note.textContent = offer.noteKey ? t(offer.noteKey, offer.noteParams) : '';
    // A reason for something being off wears `.hint.warn`; a plain `.hint` is
    // for a hint about something that works (`docs/DESIGN.md` §8).
    note.classList.toggle('warn', offer.warn);
  }
}

/**
 * Write an outline, or the shading, into the face bytes of the model itself.
 *
 * The difference from the viewport's own shading is the whole point: this ends
 * up in `.obj`, `.glb` and `.vox`, because those carry face bytes. It is also
 * why it has to be one undo step - an operation that rewrites colour across the
 * whole model and cannot be taken back is the defect the rebuild guard exists
 * to end.
 *
 * @param {'outline'|'light'} op
 */
function bake(op) {
  // The buttons are dark in both cases, so these are the keyboard and
  // stale-state paths. They still answer out loud: silence on a press is what
  // `docs/DESIGN.md` §7 calls the wrong column.
  if (state.building) {
    status('status.buildRunning', undefined, 'warn');
    return;
  }
  if (!state.volume) {
    status('status.noModel', undefined, 'warn');
    return;
  }
  const opts = op === 'outline' ? outlineOptions() : { op: /** @type {'light'} */ ('light') };
  const before = state.palette.snapshot();
  const { record, colours, added } = applyBake(state.volume, state.palette, opts);
  if (record.changed === 0) {
    // Nothing was written, so nothing is pushed: an undo entry that undoes
    // nothing is a Ctrl+Z that looks broken.
    state.palette.restore(before);
    status('status.bakedNothing', undefined, 'warn');
    return;
  }
  state.history.pushBake(op, record, before, state.palette.snapshot());

  uploadPalette();
  // Every face instance carries its palette byte, so the buffer is stale.
  state.geometryDirty = true;
  refreshPalette();
  scheduleUsage();
  state.dirty = true;
  refreshHistoryButtons();
  status(op === 'outline' ? 'status.bakedOutline' : 'status.bakedLight', {
    faces: record.changed,
    colours,
    added,
    free: state.palette.free.size,
  });

  // Baked light and the viewport's own shading are the same tint, and leaving
  // both on multiplies it twice - the model would look darker than the file it
  // exports to. The checkbox goes off, and the status line says so rather than
  // letting a control change under the user in silence.
  const shadeBox = /** @type {HTMLInputElement} */ ($('shade-toggle'));
  if (op === 'light' && shadeBox.checked) {
    shadeBox.checked = false;
    if (!state.mapOn) renderer.shade = 0;
    status('status.bakeShadeOff');
  }
}

function refreshHistoryButtons() {
  const canUndo = state.history.canUndo;
  const canRedo = state.history.canRedo;
  /** @type {HTMLButtonElement} */ ($('btn-undo')).disabled = !canUndo;
  /** @type {HTMLButtonElement} */ ($('btn-redo')).disabled = !canRedo;
  // Two buttons that are dark only because nothing has happened yet do not
  // each need their own reason written under them; one line for the pair, and
  // it goes away for good the moment there is anything to undo.
  if (canUndo || canRedo) everEdited = true;
  $('history-note').classList.toggle('hidden', everEdited);
}

/** True once the model has been edited at all in this session. */
let everEdited = false;

/**
 * Pointer position in drawing-buffer pixels, which is the space rays are cast
 * in and the space a stroke is resampled in.
 * @param {{clientX: number, clientY: number}} e
 * @returns {[number, number]}
 */
function canvasPoint(e) {
  const rect = canvas.getBoundingClientRect();
  return [
    ((e.clientX - rect.left) / rect.width) * canvas.width,
    ((e.clientY - rect.top) / rect.height) * canvas.height,
  ];
}

/**
 * @param {number} sx @param {number} sy drawing-buffer pixels
 * @returns {{x: number, y: number, z: number, face: number} | null}
 */
function hitAtPoint(sx, sy) {
  if (!state.volume) return null;
  const ray = screenRay(camera, sx, sy, canvas.width, canvas.height);
  return raycastVoxel(state.volume, ray.origin, ray.dir);
}

/**
 * @param {number} sx @param {number} sy drawing-buffer pixels
 * @returns {boolean} true when the model was touched
 */
function runToolAtPoint(sx, sy) {
  // A build in flight ends by replacing the volume and clearing the history, so
  // anything drawn now would be thrown away without a word.
  if (!state.volume || state.building || state.tool === 'orbit') return false;
  const hit = hitAtPoint(sx, sy);
  if (!hit) return false;

  // Resampling a drag produces many samples per voxel on purpose - that is what
  // stops the stroke breaking up. Applying the tool at every one of them would
  // be repeating work on a face already done, so consecutive samples that land
  // on the same face collapse into one application.
  //
  // This is thrift, not a safeguard, and it is not one application per stroke:
  // a drag still applies once per face it crosses, which for fill is more
  // applications than the one-per-event the product did before. Measured on a
  // solid 128-cube - `tests/edit/fill-drag.mjs` - a 720 px fill drag is 1501
  // samples, 168 applications and around 60 ms, because `fillSurface` returns
  // at its first line once the surface already wears the new colour. What keeps
  // that cheap is the early return, not this line.
  const key = ((hit.x * state.volume.ny + hit.y) * state.volume.nz + hit.z) * 6 + hit.face;
  if (key === strokeLastHit) return true;
  strokeLastHit = key;

  if (state.tool === 'pick') {
    const picked = state.volume.getFace(hit.x, hit.y, hit.z, hit.face);
    if (picked) {
      selectSwatch(picked);
      focusSwatch(picked);
      hoverLine = null;
      status('status.picked', { i: picked, hex: state.palette.hex(picked) });
    }
    return true;
  }

  const result = applyTool(state.volume, hit, {
    tool: state.tool,
    color: state.color,
    brush: brushRadius(),
    faceOnly: /** @type {HTMLInputElement} */ ($('face-only')).checked,
    symmetryX: /** @type {HTMLInputElement} */ ($('symmetry-x')).checked,
    history: state.history,
  });

  // The number the user is shown is the whole stroke's, not one pointer
  // event's: the stroke is one undo step, so it is one report too.
  strokeCount += result.count;
  strokeCapped = strokeCapped || result.capped;

  if (result.changed) {
    state.geometryDirty = true;
    state.dirty = true;
  }
  return true;
}

/**
 * The brush radius the armed tool actually uses. Fill and Pick work one face
 * at a time whatever the slider says, and the preview must promise what will
 * happen, not what the slider reads. The Box never asks: it draws the block it
 * has.
 */
function brushRadius() {
  return BRUSHLESS_TOOLS.has(state.tool) ? 0 : state.brush;
}

/** Faces or voxels the current stroke has changed so far. */
let strokeCount = 0;
let strokeCapped = false;

/**
 * Say what the finished stroke did, in a number.
 *
 * Until now only the box drag reported; a brush of 729 voxels and a fill of up
 * to 400 000 faces both finished in silence, and the fill was cut off at its
 * limit without a word.
 */
function reportStroke() {
  if (state.tool === 'orbit' || state.tool === 'pick') return;
  // Editing is refused while a build is running, and saying "nothing changed -
  // the face is already that colour" would be a lie about why.
  if (state.building) {
    hoverLine = null;
    status('status.editBlocked', undefined, 'warn');
    return;
  }
  // The report has to win over the hover line, or the cursor sitting where it
  // just painted would hide the answer.
  hoverLine = null;

  if (state.tool === 'fill') {
    if (strokeCapped) status('status.filledCapped', { n: strokeCount }, 'warn');
    else if (strokeCount > 0) status('status.filled', { n: strokeCount });
    else status('status.editedNothing', undefined, 'warn');
    return;
  }

  if (strokeCount > 0) status('status.edited', { n: strokeCount, tool: t('tool.' + state.tool) });
  else status('status.editedNothing', undefined, 'warn');
}

function undo() {
  // A drawing can be painted before anything has ever been built, so undo is
  // not the model's alone any more; a voxel step still refuses without one.
  const kind = !state.building ? state.history.undo(state.volume, state.palette) : null;
  if (!kind) {
    status('status.nothingToUndo');
    return;
  }
  afterHistoryStep(kind);
  status('status.undone');
}

function redo() {
  const kind = !state.building ? state.history.redo(state.volume, state.palette) : null;
  if (!kind) return;
  afterHistoryStep(kind);
  status('status.redone');
}

/**
 * Refresh only what the undone step actually touched. A recoloured slot leaves
 * every voxel and every face byte exactly where they were, so rebuilding the
 * face buffer for it would cost the whole model's worth of work to show a
 * 1 KB texture change.
 * A merge is both at once: it freed slots and rewrote the face bytes that named
 * them, so the texture, the panel and the face buffer all have to be redone.
 * A drawing is none of those: undoing a stroke on a picture leaves every voxel
 * where it was, and the model stays exactly as far behind as it was.
 * A bake is a merge's twin here: it too rewrote face bytes and may have grown
 * the palette, so both the texture and the face buffer are stale.
 * @param {'voxels'|'palette'|'merge'|'bake'|'view'} kind
 */
function afterHistoryStep(kind) {
  if (kind === 'view') {
    // Exactly the drawing the step wrote into. Refreshing all six would mark
    // views the artist never touched as ahead of the model.
    const name = state.history.lastView;
    if (name) afterDrawingChanged(name);
    refreshHistoryButtons();
    return;
  }
  if (kind === 'palette' || kind === 'merge' || kind === 'bake') {
    uploadPalette();
    // Undoing a merge brings a freed slot back; redoing one takes it away
    // again, and the selection must never sit on a hole.
    if (!state.palette.has(state.color)) state.color = 1;
    refreshPalette();
  }
  // A recoloured slot leaves every face byte where it was; a merge and a stroke
  // both rewrote bytes, so their face buffer is stale.
  if (kind !== 'palette') {
    state.geometryDirty = true;
    scheduleUsage();
  }
  state.dirty = true;
  refreshHistoryButtons();
  // Undoing an action leaves the block where it was, so its counts - and with
  // them which of the three buttons are lit - have to be worked out again.
  refreshSelectionPanel();
}

/**
 * Live state of a box drag.
 *
 * `new` is a rectangle being pulled out on the face it started on; `face` is
 * one side of the finished block being moved along its own axis.
 * @type {{kind: 'new'|'face', anchor?: {x: number, y: number, z: number, face: number}, face: number, start: {min: [number,number,number], max: [number,number,number]} | null, offset: number} | null}
 */
let boxDrag = null;

/**
 * The voxel face the current stroke touched last, as a packed index.
 *
 * Cleared when a stroke starts, so a new stroke over the same spot applies
 * again; within a stroke it collapses a run of samples that land on one face
 * into one application. Only the last face, deliberately: a stroke that leaves
 * a face and comes back to it is meant to apply there again, and remembering
 * every face a long drag touched would be the larger cost.
 * @type {number | null}
 */
let strokeLastHit = null;

/**
 * Where the pointer was when the tool last ran, in drawing-buffer pixels.
 * The gap between this and the next event is what gets filled in.
 * @type {[number, number] | null}
 */
let strokeLastPoint = null;

const isBoxTool = () => state.tool === 'box';

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

/**
 * Lowest zoom at which the cell grid is drawn, in device pixels per voxel.
 *
 * Not the owner's number, and not `designer`'s either: the specification
 * proposed 8 and told the implementer to measure it.
 *
 * Measured on the default camera (yaw 45 degrees, pitch atan 0.5 - the 2:1
 * dimetric the app opens in), by projecting the unit voxel edges through
 * `OrthoCamera.viewMatrix` and taking the distance between neighbouring grid
 * lines. The tightest face is the top one: its two line families sit 0.5774
 * voxel apart on screen, against 0.7071 and 0.8165 on the front and side
 * faces. In device pixels that spacing is 2.3 at 4x, 4.6 at 8x, 6.9 at 12x,
 * 9.2 at 16x.
 *
 * So the figure the specification gave as grounds for 8 - "a cell is about
 * the height of a panel label" - is wrong: a 1 px line every 4.6 px leaves a
 * 3.6 px gap on the top face, which is a grey wash at the exact angle the app
 * starts in, and no zoom below 18x reaches the 10 px of the smallest readable
 * type (`docs/DESIGN.md` section 3). Type height turns out to be the wrong
 * yardstick anyway - what matters is a gap wide enough to aim into.
 *
 * 11 is where the spacing first clears 6 px, that is a 1 px line with a 5 px
 * hole beside it; 12 is where an independent run reported being able to count
 * the cells, and it is one step further, so 12 it is. Both are reachable -
 * zoom steps by 1, not by doubling. `tests/edit/grid-threshold` keeps the
 * number tied to that measurement in both directions. The figure is the
 * implementer's, not the owner's and not `designer`'s.
 *
 * The camera opens at 4, so the grid is off until the user zooms in - which is
 * why the checkbox says so in words rather than leaving an empty viewport to
 * be puzzled over.
 */
const GRID_MIN_ZOOM = 12;

/** The face of the block the cursor has armed, or null. */
let armedFace = null;

/** The last counts worked out for the block, for the buttons' promises. */
let selectionCounts = { solid: 0, empty: 0, cells: 0, counted: false };

/**
 * The centre of one face of the block, in corner coordinates - the point the
 * dragged face's axis line runs through.
 * @param {{min: [number, number, number], max: [number, number, number]}} sel
 * @param {number} face
 * @returns {[number, number, number]}
 */
function boxFaceCentre(sel, face) {
  const axis = face >> 1;
  const c = /** @type {[number, number, number]} */ ([
    (sel.min[0] + sel.max[0] + 1) / 2,
    (sel.min[1] + sel.max[1] + 1) / 2,
    (sel.min[2] + sel.max[2] + 1) / 2,
  ]);
  c[axis] = face % 2 === 0 ? sel.max[axis] + 1 : sel.min[axis];
  return c;
}

/**
 * The outline of the block, plus the diagonals of an armed face.
 *
 * Called wherever the hover outline used to be cleared: the block is not a
 * promise the cursor makes, it is a thing that exists, and it has to survive
 * the pointer wandering off the model.
 */
function drawSelection() {
  const sel = state.selection;
  if (!sel || !isBoxTool()) {
    renderer.clearPreview();
    state.dirty = true;
    return;
  }
  const parts = [boxEdges(sel.min, sel.max)];
  if (armedFace !== null) parts.push(faceDiagonals(sel.min, sel.max, armedFace));
  renderer.setPreviewLines(joinLines(parts));
  state.dirty = true;
}

/**
 * @param {{min: [number, number, number], max: [number, number, number]}} ext
 */
function setSelection(ext) {
  state.selection = ext;
  drawSelection();
  refreshSelectionPanel();
}

function clearSelection() {
  if (!state.selection) return;
  state.selection = null;
  armedFace = null;
  canvas.classList.remove('box-handle');
  drawSelection();
  refreshSelectionPanel();
}

/**
 * The block's size, its counts, and which of the three actions can be run.
 *
 * Past `COUNT_LIMIT` the counts are unknown rather than zero, and the buttons
 * stay lit: the action is legal, only the number is missing, and darkening a
 * working button because counting was inconvenient would be a lie.
 */
function refreshSelectionPanel() {
  const sel = state.selection;
  $('selection-block').classList.toggle('hidden', !sel);
  if (!sel) return;

  const [w, h, d] = extentSize(sel);
  $('selection-size').textContent = w + '×' + h + '×' + d;

  selectionCounts = state.volume
    ? countBlock(state.volume, sel)
    : { solid: 0, empty: 0, cells: extentCells(sel), counted: false };
  $('selection-figures').textContent = selectionCounts.counted
    ? t('edit.boxFigures', { solid: selectionCounts.solid, empty: selectionCounts.empty })
    : '— · —';

  const counted = selectionCounts.counted;
  const busy = state.building;
  /** @type {HTMLButtonElement} */ ($('btn-box-fill')).disabled = busy || (counted && selectionCounts.empty === 0);
  /** @type {HTMLButtonElement} */ ($('btn-box-delete')).disabled = busy || (counted && selectionCounts.solid === 0);
  /** @type {HTMLButtonElement} */ ($('btn-box-paint')).disabled = busy || (counted && selectionCounts.solid === 0);
  /** @type {HTMLButtonElement} */ ($('btn-box-clear')).disabled = busy;

  // One reason at a time under the group, as the panel's own rule demands.
  let note = '';
  if (busy) note = 'edit.boxBuildingNote';
  else if (!counted) note = 'edit.boxTooBig';
  else if (selectionCounts.solid === 0) note = 'edit.boxEmptyNote';
  else if (selectionCounts.empty === 0) note = 'edit.boxFullNote';
  const el = $('selection-note');
  el.classList.toggle('hidden', !note);
  if (note) el.textContent = t(note);
}

/**
 * Do one of the three things to the block, and leave the block where it is:
 * "delete" is nearly always followed by "delete one cell deeper".
 * @param {'fill'|'delete'|'paint'} action
 */
function runSelectionAction(action) {
  const sel = state.selection;
  if (!sel || !state.volume || state.building) return;

  state.history.begin();
  const res = applySelection(state.volume, sel, action, {
    color: state.color,
    symmetryX: /** @type {HTMLInputElement} */ ($('symmetry-x')).checked,
    history: state.history,
  });
  const [w, h, d] = extentSize(sel);
  const moved = action === 'paint' ? res.faces : res.voxels;

  if (moved > 0) {
    state.geometryDirty = true;
    state.dirty = true;
    if (state.history.commit(state.volume)) refreshHistoryButtons();
    scheduleUsage();
    hoverLine = null;
    if (action === 'fill') status('status.boxFilled', { n: res.voxels, w, h, d });
    else if (action === 'delete') status('status.boxDeleted', { n: res.voxels, w, h, d });
    else status('status.boxPainted', { n: res.faces, i: state.color });
  } else {
    state.history.commit(state.volume);
    hoverLine = null;
    status('status.boxNothing', undefined, 'warn');
  }
  refreshSelectionPanel();
  drawSelection();
}

/**
 * The cell grid under the cursor, or nothing when any of its conditions fail.
 * @param {{x: number, y: number, z: number, face: number} | null} hit
 */
function updateCellGrid(hit) {
  const vol = state.volume;
  const on = vol && hit && state.tool !== 'orbit'
    && /** @type {HTMLInputElement} */ ($('bounds-toggle')).checked
    && camera.pixelsPerVoxel >= GRID_MIN_ZOOM;
  if (!on || !vol || !hit) {
    if (renderer.gridVertexCount > 0) {
      renderer.clearGrid();
      state.dirty = true;
    }
    return;
  }
  renderer.setGridLines(cellGrid(hit, [vol.nx, vol.ny, vol.nz], GRID_RADIUS));
  state.dirty = true;
}

/** @param {PointerEvent} e */
function updateBoxDrag(e) {
  if (!boxDrag || !state.volume) return;
  const vol = state.volume;
  const dims = /** @type {[number, number, number]} */ ([vol.nx, vol.ny, vol.nz]);

  if (boxDrag.kind === 'new' && boxDrag.anchor) {
    const corner = boxCornerAt(e, boxDrag.anchor);
    setSelection(dragExtent(boxDrag.anchor, corner, dims));
    updateCellGrid(boxDrag.anchor);
  } else if (boxDrag.start) {
    const [sx, sy] = canvasPoint(e);
    const ray = screenRay(camera, sx, sy, canvas.width, canvas.height);
    const axis = boxDrag.face >> 1;
    const coord = axisPointFromRay(ray.origin, ray.dir, boxFaceCentre(boxDrag.start, boxDrag.face), axis);
    if (coord === null) return;
    const moved = resizeExtent(boxDrag.start, boxDrag.face, coord + boxDrag.offset, dims);
    setSelection(clampExtent(moved, dims));
    const sel = state.selection;
    if (sel) {
      const c = boxFaceCentre(sel, boxDrag.face);
      updateCellGrid({
        x: Math.min(sel.max[0], Math.max(sel.min[0], Math.floor(c[0]))),
        y: Math.min(sel.max[1], Math.max(sel.min[1], Math.floor(c[1]))),
        z: Math.min(sel.max[2], Math.max(sel.min[2], Math.floor(c[2]))),
        face: boxDrag.face,
      });
    }
  }
  reportBlockSize();
}

/** The size of the block, in the status bar, while it is being made. */
function reportBlockSize() {
  const sel = state.selection;
  if (!sel) return;
  const [w, h, d] = extentSize(sel);
  hoverLine = null;
  status('status.boxSize', { w, h, d, n: extentCells(sel) });
}

/**
 * Carry the stroke from where the tool last ran to where the pointer is now.
 *
 * A browser delivers at most one pointermove per frame and throws the
 * positions in between away; `getCoalescedEvents` hands those back, and
 * whatever gap is left between two consecutive positions is filled by
 * resampling the straight line between them. Both halves run inside the stroke
 * that pointerdown opened, so a mended stroke is still one undo step.
 *
 * @param {PointerEvent} e
 */
function continueStroke(e) {
  /** @type {Array<[number, number]>} */
  const points = [];
  const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
  if (coalesced && coalesced.length > 0) {
    for (const c of coalesced) points.push(canvasPoint(c));
  }
  const now = canvasPoint(e);
  const last = points[points.length - 1];
  // Not every engine ends the coalesced list with the event itself; the
  // position the pointer is actually at has to be the one the stroke ends on.
  if (!last || last[0] !== now[0] || last[1] !== now[1]) points.push(now);

  const stepPx = strokeStepPx(camera.pixelsPerVoxel);
  for (const p of points) {
    if (strokeLastPoint) {
      for (const [sx, sy] of strokeSamples(strokeLastPoint[0], strokeLastPoint[1], p[0], p[1], stepPx)) {
        runToolAtPoint(sx, sy);
      }
    } else {
      runToolAtPoint(p[0], p[1]);
    }
    strokeLastPoint = p;
  }
}

/* --------------------------------------------------------- hover preview */

/**
 * What the armed tool promises, drawn before the click that makes it true.
 *
 * Only the box drag showed its reach before this; a brush of up to 729 voxels
 * and a fill of up to 400 000 faces both went in blind. The outline is built
 * from the same coordinates the edit will use - `brushExtent`, `addSeed`,
 * `mirrorX` and `collectFillRegion` are shared with `applyTool`, not copied -
 * so the promise cannot drift away from the deed.
 */

/**
 * How long the cursor has to sit still on one face before a fill region is
 * worked out, and how many faces that walk is allowed.
 *
 * Neither number came from the owner. A fill can reach 400 000 faces, which is
 * not something to compute on every mouse move; 150 ms is short enough to feel
 * immediate and long enough that crossing a surface costs nothing. The 20 000
 * cap is about a tenth of the real limit: past it the outline is drawn from
 * what was counted and the status line says "and more", because promising a
 * number that was never reached would be worse than admitting the limit.
 */
const FILL_PREVIEW_IDLE_MS = 150;
const FILL_PREVIEW_LIMIT = 20000;

/** The voxel face under the cursor, packed, or null. */
let hoverKey = null;
let hoverTimer = 0;
/** The hover line without the tool's tail, so the fill can append to it late. */
let hoverBase = '';

function clearHover() {
  hoverKey = null;
  hoverBase = '';
  clearTimeout(hoverTimer);
  // The block is not a promise the cursor is making, so it stays; only the
  // tool's own outline and the grid go.
  drawSelection();
  updateCellGrid(null);
  state.dirty = true;
  if (hoverLine) {
    hoverLine = null;
    renderStatus();
  }
}

/**
 * @param {string} key i18n key
 * @param {Record<string, string|number>} params
 */
function setHoverLine(key, params) {
  hoverLine = { key, params };
  renderStatus();
}

/**
 * @param {PointerEvent} e
 */
function updateHover(e) {
  const vol = state.volume;
  // The map reads under the cursor in a mode whose tool is Rotate, so it has to
  // come before the guard that sends Rotate away (spec §6.3).
  if (state.mapOn && vol && !boxDrag) {
    updateMapHover(e);
    return;
  }
  if (!vol || state.tool === 'orbit' || boxDrag) {
    clearHover();
    return;
  }
  const [sx, sy] = canvasPoint(e);
  const ray = screenRay(camera, sx, sy, canvas.width, canvas.height);
  const hit = raycastVoxel(vol, ray.origin, ray.dir);

  if (isBoxTool()) {
    // A face of the block under the cursor is armed: it will move, not start a
    // new block, and it says so with two diagonals and a `move` cursor.
    const sel = state.selection;
    const face = sel ? boxFaceUnderRay(sel, ray.origin, ray.dir) : null;
    canvas.classList.toggle('box-handle', face !== null);
    if (face !== armedFace) {
      armedFace = face;
      drawSelection();
    }
  }

  if (!hit) {
    clearHover();
    return;
  }
  updateCellGrid(hit);

  const key = ((hit.x * vol.ny + hit.y) * vol.nz + hit.z) * 6 + hit.face;
  // Everything below costs a raycast or worse, and a hand crossing a face
  // sends dozens of events over it. Nothing changes until the face does.
  if (key === hoverKey) return;
  hoverKey = key;
  clearTimeout(hoverTimer);

  drawHover(hit);
}

/** @param {{x: number, y: number, z: number, face: number}} hit */
function drawHover(hit) {
  const vol = state.volume;
  if (!vol) return;
  const dims = /** @type {[number, number, number]} */ ([vol.nx, vol.ny, vol.nz]);
  const slot = vol.getFace(hit.x, hit.y, hit.z, hit.face);

  // Coordinates, face, colour and slot first: what is under the cursor comes
  // before what the tool would do with it, and it has to fit in the first
  // forty characters (`docs/DESIGN.md`, section 6).
  const baseParams = {
    x: hit.x, y: hit.y, z: hit.z,
    face: FACE_NAMES[hit.face],
    hex: state.palette.hex(slot),
    i: slot,
  };
  hoverBase = t('status.hover', baseParams);

  // The box tool draws its block, not a brush cube: what is on screen is the
  // block that exists, and nothing is promised until a button is pressed.
  if (isBoxTool()) {
    drawSelection();
    setHoverLine('status.hover', baseParams);
    return;
  }

  const mirror = /** @type {HTMLInputElement} */ ($('symmetry-x')).checked;
  // Mirrored edits are invisible until they happen unless the promise is made
  // twice, once on each side.
  const hits = mirror && state.tool !== 'pick' ? [hit, mirrorX(vol, hit)] : [hit];

  if (state.tool === 'fill') {
    // The region is not walked yet; the outline waits for the hand to settle.
    renderer.clearPreview();
    state.dirty = true;
    setHoverLine('status.hover', baseParams);
    hoverTimer = setTimeout(() => previewFill(hits, dims), FILL_PREVIEW_IDLE_MS);
    return;
  }

  const parts = hits.map((h) => toolOutline(h, dims));
  renderer.setPreviewLines(joinLines(parts));
  state.dirty = true;

  if (state.tool === 'pick') {
    setHoverLine('status.hover', baseParams);
  } else {
    const side = brushRadius() * 2 + 1;
    const faceOnly = /** @type {HTMLInputElement} */ ($('face-only')).checked;
    const n = state.tool === 'paint' && faceOnly && brushRadius() === 0 ? 1 : side * side * side;
    setHoverLine('status.hoverBrush', { base: hoverBase, n });
  }
}

/**
 * The outline of one application of the armed tool.
 * @param {{x: number, y: number, z: number, face: number}} hit
 * @param {[number, number, number]} dims
 * @returns {Float32Array}
 */
function toolOutline(hit, dims) {
  const r = brushRadius();
  if (state.tool === 'pick') return boxEdges([hit.x, hit.y, hit.z], [hit.x, hit.y, hit.z]);

  const faceOnly = /** @type {HTMLInputElement} */ ($('face-only')).checked;
  if (state.tool === 'paint' && faceOnly && r === 0) {
    return faceEdges(hit.x, hit.y, hit.z, hit.face);
  }

  // Add lays its cube one voxel out along the normal - showing it on the face
  // itself would point at the wrong voxel every time.
  const centre = state.tool === 'add' ? addSeed(hit) : hit;
  const extent = brushExtent(centre, r, dims);
  return boxEdges(extent.min, extent.max);
}

/**
 * Outline the faces a fill would reach, and say how many there are.
 * @param {Array<{x: number, y: number, z: number, face: number}>} hits
 * @param {[number, number, number]} dims
 */
function previewFill(hits, dims) {
  const vol = state.volume;
  if (!vol) return;
  /** @type {Float32Array[]} */
  const parts = [];
  let count = 0;
  let capped = false;
  for (const h of hits) {
    const region = collectFillRegion(vol, h, FILL_PREVIEW_LIMIT);
    parts.push(regionOutline(region.cells, h.face, dims));
    count += region.cells.length;
    capped = capped || region.capped;
  }
  renderer.setPreviewLines(joinLines(parts));
  state.dirty = true;
  setHoverLine(capped ? 'status.hoverFillMore' : 'status.hoverFill', { base: hoverBase, n: count });
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
      const [sx, sy] = canvasPoint(e);
      const ray = screenRay(camera, sx, sy, canvas.width, canvas.height);
      const sel = state.selection;
      const face = sel ? boxFaceUnderRay(sel, ray.origin, ray.dir) : null;
      if (sel && face !== null) {
        // Pulling a face of the block, including along the normal of the face
        // the block was drawn on - that is where the third dimension comes
        // from now. The grab offset keeps the face from jumping to the cursor.
        const axis = face >> 1;
        const coord = axisPointFromRay(ray.origin, ray.dir, boxFaceCentre(sel, face), axis);
        const plane = face % 2 === 0 ? sel.max[axis] + 1 : sel.min[axis];
        armedFace = face;
        boxDrag = { kind: 'face', face, start: sel, offset: coord === null ? 0 : plane - coord };
        drawSelection();
      } else {
        const hit = state.volume ? raycastVoxel(state.volume, ray.origin, ray.dir) : null;
        if (hit) {
          // A press on the model outside the block starts a new one; the old
          // block goes without a question, because no geometry was touched.
          armedFace = null;
          boxDrag = { kind: 'new', anchor: hit, face: hit.face, start: null, offset: 0 };
          updateBoxDrag(e);
        } else {
          mode = null;
        }
      }
    } else if (mode === 'tool') {
      state.history.begin();
      strokeLastHit = null;
      strokeCount = 0;
      strokeCapped = false;
      strokeLastPoint = canvasPoint(e);
      runToolAtPoint(strokeLastPoint[0], strokeLastPoint[1]);
    } else {
      // Turning or panning moves the model out from under the outline, so the
      // promise is withdrawn until the hand stops.
      clearHover();
      canvas.classList.add('dragging');
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!mode) {
      updateHover(e);
      return;
    }
    if (mode === 'tool') {
      if (boxDrag) updateBoxDrag(e);
      else continueStroke(e);
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
      // The drag only shapes the block. Applying it is a separate command -
      // that is the whole change: mark, look, then act.
      boxDrag = null;
      refreshSelectionPanel();
      drawSelection();
      reportBlockSize();
    } else if (mode === 'tool' && state.volume) {
      // One undo step per stroke, not per voxel.
      if (state.history.commit(state.volume)) refreshHistoryButtons();
      reportStroke();
      scheduleUsage();
    }
    mode = null;
    strokeLastPoint = null;
    strokeLastHit = null;
    canvas.classList.remove('dragging');
    try {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    } catch { /* not fatal */ }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  // Off the canvas there is nothing under the cursor to promise anything
  // about, and the status bar goes back to the last real message.
  canvas.addEventListener('pointerleave', clearHover);

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
    const { frames, meta } = withModelColours(
      () => renderTurnaround(renderer, state.volume, exportCamera, opts));
    if (opts.shaded) for (const f of frames) snapToPalette(f, state.palette);
    const { image } = packSheet(frames, meta.frameW, meta.frameH);
    downloadBlob(await imageDataToPng(image), 'pixhull-sheet-' + meta.count + 'dir.png');
    status('status.exportedSheet', { n: meta.count, w: meta.frameW, h: meta.frameH });
  } catch (err) {
    status('status.badImage', { err: String(err instanceof Error ? err.message : err) }, 'error');
  }
}

/**
 * The model back out as one sheet of six drawings - the other half of the
 * round trip that `Slice a sheet` starts.
 *
 * Deliberately an ordinary PNG with no metadata beside it: it comes back in
 * through the same slicer a stranger's sheet does, so there is one way in to
 * keep honest. What it carries is the silhouette and the colours a view can
 * see; the hint under the button says so, because a face no view looks at and
 * the edit history do not survive the trip, and finding that out afterwards
 * would be finding it out too late.
 */
async function exportViewSheet() {
  if (!state.volume) return;
  try {
    const { image, cells } = packViewSheet(state.volume, state.palette);
    const png = await imageDataToPng(new ImageData(image.data, image.width, image.height));
    downloadBlob(png, 'pixhull-views-' + image.width + 'x' + image.height + '.png');
    status('status.exportedViews', { n: cells.length, w: image.width, h: image.height });
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
    const { frames, meta } = withModelColours(
      () => renderTurnaround(renderer, state.volume, exportCamera, opts));
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
      // Live slots only: a merged palette has holes, and a hole reads as
      // #000000 - a colour that was never in the art.
      palette: state.palette.slots().map((i) => state.palette.hex(i)),
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

/**
 * Grey out the .vox button when the model is too big for the format.
 *
 * MagicaVoxel stores a model's size in one byte per axis, so 256 is the hard
 * ceiling - ours to report, not ours to lift. Now that the grid goes to 512
 * that stopped being a corner case, and finding out by pressing the button and
 * reading an error is the wrong way round. The measurement is the model's own
 * bounding box, not the grid: a small model on a 512 grid exports fine.
 */
function refreshVoxAvailability() {
  const note = $('vox-note');
  const button = /** @type {HTMLButtonElement} */ ($('btn-export-vox'));
  const box = state.volume?.bounds();
  const span = box
    ? Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) + 1
    : 0;
  const tooBig = span > VOX_MAX_SIZE;
  button.disabled = tooBig;
  note.classList.toggle('hidden', !tooBig);
  if (tooBig) note.textContent = t('model.voxTooBig', { span, max: VOX_MAX_SIZE });
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
    // Both branches below replace the model - the saved-voxels one clears the
    // history too, because its entries point at coordinates of a volume that is
    // about to be gone. So the question belongs here, before anything is lost.
    // The file brings its own six drawings, so whatever is painted here goes.
    if (!mayDiscardEdits(true)) return;
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
    // The file's drawings and the file's model came out of the same save, so
    // nothing is ahead of anything.
    state.editedViews.clear();
    refreshViewsAhead();
    refreshSlots();

    if (data.volume && data.palette) {
      // Restore the saved voxels rather than re-carving, so hand edits survive.
      // A build may still be running - the tab answers during one now, so the
      // Load button is reachable mid-build - and it would land on top of the
      // file the user just opened, history and all. The file wins: the user
      // asked for it, and asked for it after refusing to lose the edits.
      dropBuild();
      state.palette = Palette.deserialize(data.palette);
      state.volume = deserializeVolume(data.volume);
      state.lastStats = { solid: state.volume.solidCount, painted: 0, inferred: 0, mirrored: [], ms: 0 };
      // A saved project carries voxels, not drawings, so there is nothing to
      // disagree: the checkbox goes dark and says to build again (spec §6.4).
      dropMap();
      state.history.clear();
      refreshHistoryButtons();
      uploadPalette();
      refreshPalette();
      const faces = renderer.setVolume(state.volume);
      const box = state.volume.bounds();
      if (box) camera.fit(box, canvas.width || 800, canvas.height || 600);
      refreshEmptyViewport();
      markModeChips();
      refreshView2dEmpty();
      refreshView2dReadout();
      drawView2d();
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
  // While a drawing is on screen `#gl` is `display: none`, so its clientWidth
  // is zero: resizing it now would shrink the drawing buffer to 1x1 and a
  // build landing in this mode would fit the camera to a one-pixel viewport.
  // Nothing about the model changes here, so the loop simply steps over it.
  if (state.mode === '2d') {
    if (view2dNeedsResize()) drawView2d();
    requestAnimationFrame(frame);
    return;
  }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (renderer.resize(dpr)) state.dirty = true;
  if (state.geometryDirty && state.volume) {
    // Dragging a brush can touch the model dozens of times per frame; rebuild
    // once instead of once per event.
    // Undo and redo still work in map mode, so the map's own instances can go
    // stale there too; they are rebuilt from the same walk.
    if (state.mapOn && state.map) mapFaces = mapInstances(state.volume, state.map);
    const faces = renderer.setVolume(state.volume, state.mapOn ? mapFaces ?? undefined : undefined);
    // The voxel buffer is rebuilt either way so the face count stays honest and
    // the grid wireframe stays in step; the smooth mesh is extra on top.
    renderer.useSmooth = state.mapOn ? false : smoothPreviewOn();
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
  guardRebuild(() => {
    const demo = buildDemoViews();
    state.views.clear();
    setView('front', demo.front);
    setView('right', demo.right);
    setView('top', demo.top);
    autoGrid();
    refreshSlots();
    build();
  }, undefined, true);
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
  // The scale's six colours come out of the stylesheet too, and they are on the
  // GPU as a texture rather than as CSS: a theme switch has to re-upload them.
  if (state.mapOn) applyViewColours();
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
  buildModeChips();
  buildAngleChips();
  buildToolBar();
  refreshSlots();
  // The swatch tooltips and the line under the box are built by hand from a
  // colour and a phrase, so data-i18n cannot reach them.
  refreshPalette();
  refreshToolControls();
  refreshLanguageButton();
  // Carries numbers, so it is written by hand rather than by data-i18n and has
  // to be asked to rewrite itself.
  refreshVoxAvailability();
  refreshSelectionPanel();
  refreshMapPanel();
  // Every one of these writes a translated string by hand: view names inside a
  // list, a size against a grid, a price in seconds.
  refreshViewsAhead();
  refreshView2dEmpty();
  refreshView2dReadout();
  updateZoomLabel();
  renderStatus();
  updateStats(state.lastStats, renderer.instanceCount);
  updateFramePreview();
  // Both lines under the bake buttons carry numbers in words, so a language
  // change has to write them again - in the new language, and without paying
  // for a count that nobody has asked for yet.
  if (bakeStale) invalidateBakeOffers();
  else refreshBakeOffers();
}

function init() {
  setTheme(detectTheme());
  applyThemeToRenderer();
  refreshThemeButton();
  setLang(getLang());

  buildSlots();
  buildModeChips();
  buildAngleChips();
  buildToolBar();
  buildPitchPresets();
  wirePitchPresets();
  setupPointer();
  setupPointer2d();
  // A `view` entry names a slot, not an image: the slot's drawing is replaced
  // whole by a projection, a blank sheet or a dropped file, and the stack must
  // never write into a picture nobody is looking at.
  state.history.viewSource = (name) => /** @type {any} */ (state.views.get(name)?.image ?? null);
  applyTranslations();
  refreshLanguageButton();

  const brush = /** @type {HTMLInputElement} */ ($('brush-size'));
  brush.addEventListener('input', () => {
    state.brush = +brush.value;
    refreshToolControls();
    // The outline promises a cube of the old size until it is told otherwise.
    clearHover();
  });

  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);

  // The three things a block can be used for, plus dropping it. Each says in
  // the status bar what it is about to do while the pointer is over it, and
  // puts the previous message back when the pointer leaves.
  /** @type {Array<['fill'|'delete'|'paint', string, string]>} */
  const blockActions = [
    ['fill', 'btn-box-fill', 'edit.boxFillTitle'],
    ['delete', 'btn-box-delete', 'edit.boxDeleteTitle'],
    ['paint', 'btn-box-paint', 'edit.boxPaintTitle'],
  ];
  for (const [action, id, key] of blockActions) {
    const b = $(id);
    b.addEventListener('click', () => runSelectionAction(action));
    b.addEventListener('pointerenter', () => {
      const sel = state.selection;
      if (!sel || !selectionCounts.counted) return;
      const [w, h, d] = extentSize(sel);
      const n = action === 'fill' ? selectionCounts.empty : selectionCounts.solid;
      setHoverLine(key, { w, h, d, n });
    });
    b.addEventListener('pointerleave', () => {
      if (!hoverLine) return;
      hoverLine = null;
      renderStatus();
    });
  }
  $('btn-box-clear').addEventListener('click', () => {
    clearSelection();
    renderStatus();
  });

  const box = $('palette-box');
  box.addEventListener('click', (e) => {
    const i = swatchSlot(e);
    if (i) selectSwatch(i);
  });
  box.addEventListener('dblclick', (e) => {
    const i = swatchSlot(e);
    if (i) openRecolour(i);
  });
  box.addEventListener('keydown', (e) => {
    const order = paletteOrder(state.palette);
    if (order.length === 0) return;
    const cur = order.indexOf(state.color);
    let next = -1;
    // Up and down step by one rather than by a row: how many swatches fit in a
    // row depends on the panel's actual width, and a key whose meaning changed
    // with the window would be worse than one that always moves by one.
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(order.length - 1, cur + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, cur - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = order.length - 1;
    else if (e.key === 'F2') {
      e.preventDefault();
      if (state.color) openRecolour(state.color);
      return;
    } else {
      return;
    }
    e.preventDefault();
    const slot = order[Math.max(0, next)];
    selectSwatch(slot);
    focusSwatch(slot);
  });

  // The new pair is one radio group too: one tab stop, arrows inside it
  // (`docs/DESIGN.md` section 6, rule 6).
  $('mode-chips').addEventListener('keydown', (e) => {
    const k = /** @type {KeyboardEvent} */ (e).key;
    let want = null;
    if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'End') want = '2d';
    else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'Home') want = '3d';
    else return;
    e.preventDefault();
    setMode(/** @type {any} */ (want));
    /** @type {HTMLElement|null} */
    ($('mode-chips').querySelector('[data-mode="' + state.mode + '"]'))?.focus();
  });

  // ... and so is the row beside it - the five angles, or the six drawings.
  // Clicking is what a chip does; the keys only choose which chip that is, so
  // there is one description of what each chip means, not two.
  $('angle-chips').addEventListener('keydown', (e) => {
    const buttons = /** @type {NodeListOf<HTMLButtonElement>} */
      ($('angle-chips').querySelectorAll('button'));
    if (buttons.length === 0) return;
    const k = /** @type {KeyboardEvent} */ (e).key;
    let cur = [...buttons].findIndex((b) => b.tabIndex === 0);
    if (cur < 0) cur = 0;
    let next;
    if (k === 'ArrowRight' || k === 'ArrowDown') next = Math.min(buttons.length - 1, cur + 1);
    else if (k === 'ArrowLeft' || k === 'ArrowUp') next = Math.max(0, cur - 1);
    else if (k === 'Home') next = 0;
    else if (k === 'End') next = buttons.length - 1;
    else return;
    e.preventDefault();
    buttons[next].click();
    buttons[next].focus();
  });

  // The toolbar is one radio group, so the arrows move the choice inside it.
  $('tool-bar').addEventListener('keydown', (e) => {
    const ids = TOOL_BUTTONS.map((b) => b.id);
    const cur = ids.indexOf(state.tool);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(ids.length - 1, cur + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, cur - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    else return;
    e.preventDefault();
    setTool(/** @type {any} */ (ids[Math.max(0, next)]));
    /** @type {HTMLElement|null} */
    ($('tool-bar').querySelector('[data-tool="' + state.tool + '"]'))?.focus();
  });

  const editColor = /** @type {HTMLInputElement} */ ($('edit-color'));
  editColor.addEventListener('input', applyRecolour);
  // `change` ends the drag: everything between the first `input` and here is
  // one undo step. `blur` is the belt and braces for a picker dismissed
  // without committing, so the next edit can never join the previous step.
  editColor.addEventListener('change', () => {
    applyRecolour();
    state.history.endPalette();
    recolourSlot = 0;
    // A new colour can belong in another band; re-sorting is deferred to here
    // so it never happens under the cursor mid-drag.
    refreshPalette();
  });
  editColor.addEventListener('blur', () => {
    state.history.endPalette();
    recolourSlot = 0;
  });

  $('btn-merge-colors').addEventListener('click', mergeColors);

  $('btn-bake-outline').addEventListener('click', () => bake('outline'));
  $('btn-bake-light').addEventListener('click', () => bake('light'));
  $('outline-thickness').addEventListener('input', (e) => {
    $('outline-thickness-label').textContent = /** @type {HTMLInputElement} */ (e.target).value;
    // Thickness changes what the outline would cost, so the promise under the
    // button is recomputed rather than left describing the previous setting.
    scheduleBakeOffers();
  });
  $('outline-use-color').addEventListener('change', scheduleBakeOffers);

  // Reaching for the section is what buys the counts. Pointer and keyboard both
  // arrive here, and both arrive *before* the press: the heading spans the
  // panel, so a pointer coming down the panel crosses it, and a Tab lands on
  // the first control. `countBakeOffers` costs nothing when nothing changed.
  for (const id of ['bake-heading', 'outline-thickness', 'outline-use-color',
    'btn-bake-outline', 'bake-outline-note', 'btn-bake-light', 'bake-light-note']) {
    const el = $(id);
    el.addEventListener('pointerenter', countBakeOffers);
    el.addEventListener('focus', countBakeOffers);
  }

  $('btn-add-color').addEventListener('click', () => {
    const hex = /** @type {HTMLInputElement} */ ($('new-color')).value;
    const n = parseInt(hex.slice(1), 16);
    // "Full" is now a question about free slots, not about length: a merge can
    // leave holes inside a palette that is still 256 entries long.
    const wasFull = state.palette.full;
    const idx = state.palette.add((n >> 16) & 255, (n >> 8) & 255, n & 255);
    state.color = idx;
    uploadPalette();
    refreshPalette();
    scheduleUsage();
    state.dirty = true;
    if (wasFull) status('status.paletteFull', undefined, 'warn');
    else status('status.colorAdded', { n: state.palette.live });
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

  $('mirror-toggle').addEventListener('change', (e) => {
    const box = /** @type {HTMLInputElement} */ (e.target);
    guardRebuild(build, () => { box.checked = !box.checked; });
  });

  $('btn-view-take').addEventListener('click', takeDrawingFromModel);
  $('btn-view-blank').addEventListener('click', makeBlankDrawing);

  $('btn-demo').addEventListener('click', loadDemo);
  $('btn-demo-2').addEventListener('click', loadDemo);
  $('btn-clear').addEventListener('click', () => {
    guardRebuild(() => {
      state.views.clear();
      refreshSlots();
      build();
    }, undefined, true);
  });
  $('btn-build').addEventListener('click', () => guardRebuild(build));
  $('btn-autofit').addEventListener('click', () => {
    guardRebuild(() => {
      autoGrid();
      build();
    });
  });

  $('grid-size').addEventListener('change', (e) => {
    const select = /** @type {HTMLSelectElement} */ (e.target);
    const previous = String(state.gridSize);
    guardRebuild(() => {
      state.gridSize = +select.value;
      // Both the blank sheet's size and the price of a projection are read off
      // the grid, so the invitation has to be told.
      refreshView2dEmpty();
      refreshView2dReadout();
      build();
    }, () => { select.value = previous; });
  });

  $('shade-toggle').addEventListener('change', (e) => {
    // Shading stays off while the map is on - it would shift a band's colour
    // further than the gap to the next band. The checkbox keeps its value and
    // takes effect again the moment the map goes.
    if (!state.mapOn) renderer.shade = /** @type {HTMLInputElement} */ (e.target).checked ? 1 : 0;
    state.dirty = true;
  });
  $('map-toggle').addEventListener('change', (e) => {
    setMapMode(/** @type {HTMLInputElement} */ (e.target).checked);
  });
  // The one checkbox draws the cell grid in both modes.
  $('bounds-toggle').addEventListener('change', () => {
    state.dirty = true;
    drawView2d();
  });

  $('zoom-in').addEventListener('click', () => zoomBy(1));
  $('zoom-out').addEventListener('click', () => zoomBy(-1));

  for (const id of ['dir-count', 'angle-mode', 'export-scale', 'export-pad']) {
    $(id).addEventListener('input', updateFramePreview);
    $(id).addEventListener('change', updateFramePreview);
  }
  $('pitch-preset').addEventListener('change', updateFramePreview);

  $('btn-export-sheet').addEventListener('click', exportSheet);
  $('btn-export-views').addEventListener('click', exportViewSheet);
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
    // Switching the smooth mesh on with the slider at zero shows a shell that
    // is still every bit a staircase, which reads as the rounding not working
    // rather than as not having been asked for yet. Start it somewhere it can
    // be seen; dragging it back to zero still gives the unrounded shell.
    if (smoothToggle.checked && relaxRange.value === '0') {
      relaxRange.value = '3';
      $('relax-label').textContent = relaxRange.value;
    }
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
    // `e.target` is the window itself for a synthetic event, and `matches` is
    // not a method of a window; without the guard the block's keys could not
    // be measured at all, only tried by hand.
    const target = /** @type {HTMLElement|null} */ (e.target);
    if (target && typeof target.matches === 'function' && target.matches('input, select, textarea')) return;

    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
      return;
    }

    // The block's own keys come before everything else: Delete must not reach
    // the browser, and Esc has to work whatever tool is armed.
    if (e.key === 'Escape') {
      if (state.selection) {
        clearSelection();
        renderStatus();
      }
      return;
    }
    if (state.selection && isBoxTool() && !state.building) {
      if (e.key === 'Enter') { e.preventDefault(); runSelectionAction('fill'); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        runSelectionAction('delete');
        return;
      }
    }

    // P for picture. Free; M was left alone because it asks to mean "mirror".
    if (e.key === 'p' || e.key === 'P') {
      setMode(state.mode === '2d' ? '3d' : '2d');
      return;
    }

    // The same row of chips, the same digits: five camera angles while the
    // model is on screen, the six drawings while one of them is (spec 8).
    if (state.mode === '2d') {
      const v = '123456'.indexOf(e.key);
      if (v >= 0) {
        showView2d(VIEW_NAMES[v]);
        return;
      }
    } else {
      const idx = '12345'.indexOf(e.key);
      if (idx >= 0) {
        camera.yaw = ANGLE_CHIPS[idx].yaw * DEG;
        state.dirty = true;
        markActiveChip();
        return;
      }
    }

    if (e.key === '[' || e.key === ']') {
      const brush = /** @type {HTMLInputElement} */ ($('brush-size'));
      if (brush.disabled) return;
      const step = e.key === ']' ? 1 : -1;
      state.brush = Math.max(+brush.min, Math.min(+brush.max, state.brush + step));
      brush.value = String(state.brush);
      refreshToolControls();
      clearHover();
      return;
    }

    // D for disagreement. Free: the tools have taken v b g e a i r.
    if (e.key === 'd' || e.key === 'D') {
      if (state.mapOn || mapDisabledReason() === null) setMapMode(!state.mapOn);
      return;
    }

    // Alt is the picker on loan: hold it, take a colour, let go and the tool
    // you were using is back, without a trip to the toolbar.
    if (state.mapOn) return;
    if (e.key === 'Alt' && altBorrowedFrom === null && state.tool !== 'pick') {
      altBorrowedFrom = state.tool;
      setTool('pick');
      return;
    }

    const tool = TOOL_BUTTONS.find((b) => b.hotkey === e.key.toLowerCase());
    if (tool) setTool(/** @type {any} */ (tool.id));
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === 'Alt' && altBorrowedFrom !== null) {
      const back = altBorrowedFrom;
      altBorrowedFrom = null;
      setTool(back);
    }
  });

  refreshToolControls();
  refreshMapPanel();
  refreshViewsAhead();
  // Dark buttons with an empty line under them would say nothing about why;
  // this writes the reason before the first model exists.
  invalidateBakeOffers();
  // The grid's threshold is written under its checkbox from the first frame,
  // not only once a model has been built.
  updateZoomLabel();
  updateFramePreview();
  loadDemo();
  requestAnimationFrame(frame);

  // Handy from the browser console, and how the smoke tests reach in:
  //   const { renderTurnaround } = await import('/src/export/sprite.js')
  /** @type {any} */ (window).pixhull = { state, camera, renderer, build, loadDemo };
}

init();
