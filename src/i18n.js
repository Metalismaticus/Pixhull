// @ts-check
/**
 * Two-language UI (English / Russian).
 *
 * Markup carries `data-i18n` (text), `data-i18n-title` or `data-i18n-aria`;
 * everything generated from JavaScript goes through `t()`. Strings interpolate
 * `{name}` placeholders, and numbers are formatted for the active locale, so
 * "1 438" in Russian and "1,438" in English.
 */

const STORAGE_KEY = 'pixhull.lang';

/** @type {Record<string, Record<string, string>>} */
const STRINGS = {
  en: {
    'app.tagline': 'front / side / top → voxels → sprites',
    'app.loadDemo': 'Load demo',
    'app.clear': 'Clear',
    'app.source': 'Source',
    'app.theme': 'Light / dark theme',
    'app.language': 'Switch language',

    'views.heading': 'Source views',
    'views.hint': 'Drop a PNG on any slot. Any size — each view is placed on the grid independently, so views do not have to match.',
    'views.empty': 'empty',
    'views.flipH': 'Flip horizontally',
    'views.flipV': 'Flip vertically',
    'views.remove': 'Remove',
    'views.front': 'front',
    'views.back': 'back',
    'views.right': 'right',
    'views.left': 'left',
    'views.top': 'top',
    'views.bottom': 'bottom',
    'views.mirrored': 'mirrored',

    'grid.label': 'Grid',
    'grid.fit': 'Fit to art',
    'grid.build': 'Build model',

    'viewport.emptyTitle': 'Nothing built yet.',
    'viewport.emptyHintBefore': 'Drop art into a view slot, or ',
    'viewport.emptyHintLink': 'load the demo',
    'viewport.emptyHintAfter': '.',
    'viewport.zoomIn': 'Zoom in',
    'viewport.zoomOut': 'Zoom out',

    'angle.front': 'Front',
    'angle.right': 'Right',
    'angle.back': 'Back',
    'angle.left': 'Left',
    'angle.iso': 'Iso',

    'view.heading': 'View',
    'view.elevation': 'Elevation',
    'view.shading': 'Face shading (viewport only)',
    'view.bounds': 'Show grid bounds',
    'view.mirror': 'Mirror views that are missing',
    'view.mirrorHint': 'Fills the faces pointing away from you with the opposite view’s art instead of guessing. Geometry is unaffected.',

    'pitch.iso21': '2:1 dimetric (pixel-clean)',
    'pitch.isoTrue': 'True isometric 35.26°',
    'pitch.deg30': '30° (RPG Maker-ish)',
    'pitch.deg45': '45°',
    'pitch.deg60': '60°',
    'pitch.top': '90° top-down',
    'pitch.side': '0° side-on',

    'export.heading': 'Sprite export',
    'export.directions': 'Directions',
    'export.angles': 'Angles',
    'export.anglesClean': 'Pixel-clean slopes',
    'export.anglesUniform': 'Uniform 360/n',
    'export.scale': 'Scale',
    'export.scaleUnit': 'px / voxel',
    'export.padding': 'Padding',
    'export.paddingUnit': 'px',
    'export.shaded': 'Shaded, snapped back to palette',
    'export.sheet': 'Export sprite sheet',
    'export.frames': 'Export frames + JSON',
    'export.framePreview': 'frame {fw}×{fh} px · sheet {sw}×{sh} px · same canvas every frame',

    'model.heading': 'Model',
    'model.smooth': 'Smooth mesh, not cubes (view and export)',
    'model.relax': 'Rounding',
    'model.smoothHint': 'Shows and exports a rounded low-poly shell over the same voxels (surface nets), keeping every face colour. Grid resolution still sets how much detail there is.',
    'model.obj': 'Export OBJ + MTL',
    'model.vox': 'Export .vox (MagicaVoxel)',
    'model.save': 'Save project',
    'model.load': 'Load project',

    'stats.none': 'no model',
    'stats.voxels': 'voxels',
    'stats.faces': 'faces',
    'stats.extent': 'extent',
    'stats.palette': 'palette',
    'stats.inferred': 'inferred faces',
    'stats.mirrored': 'mirrored views',

    'status.ready': 'ready',
    'status.built': 'Built {n} voxels in {ms} ms',
    'status.builtMirrored': 'Built {n} voxels in {ms} ms · mirrored: {views}',
    'status.emptyCarve': 'Carved nothing — the views may not overlap. Try flipping a view, or check the alpha channel.',
    'status.paletteOverflow': 'Built in {ms} ms — art has more than 255 colours, extras were snapped to the nearest.',
    'status.badImage': 'Could not read that image: {err}',
    'status.rendering': 'rendering…',
    'status.meshing': 'meshing…',
    'status.exportedSheet': 'Exported {n} frames at {w}×{h} px',
    'status.exportedFrames': 'Exported {n} frames + metadata',
    'status.exportedObj': 'OBJ: {quads} quads ({saved}% merged), {verts} verts',
    'status.exportedObjSmooth': 'OBJ (smooth): {quads} quads, {verts} verts',
    'status.exportedVox': '.vox: {n} voxels, {c} colours, {w}×{h}×{d}',
    'status.projectSaved': 'Project saved',
    'status.projectLoaded': 'Project loaded',
    'status.projectFailed': 'Could not load project: {err}',

    'edit.heading': 'Edit',
    'edit.brush': 'Brush',
    'edit.faceOnly': 'Paint one face, not the whole voxel',
    'edit.symmetryX': 'Mirror edits across X',
    'edit.newColor': 'Pick a colour to add to the palette',
    'edit.addColor': 'Add colour',
    'edit.undo': 'Undo',
    'edit.redo': 'Redo',
    'edit.hint': 'Left-drag applies the tool; hold Shift to orbit, Ctrl to pan. Ctrl+Z undoes a whole stroke.',
    'edit.rebuildWarning': 'Rebuilding replaces hand edits. Undo history was cleared.',
    'tool.orbit': 'Orbit',
    'tool.paint': 'Paint',
    'tool.fill': 'Fill',
    'tool.erase': 'Erase',
    'tool.add': 'Add',
    'tool.pick': 'Pick colour',
    'tool.box': 'Box',
    'tool.boxErase': 'Box cut',
    'edit.boxHint': 'Drag a rectangle on a face: it extrudes along that face by the brush depth. Box adds outward, Box cut removes inward.',
    'status.edited': 'Edited {n} voxels · {tool}',
    'status.boxApplied': 'Box: {n} voxels {w}×{h}×{d}',
    'status.undone': 'Undone',
    'status.redone': 'Redone',
    'status.nothingToUndo': 'Nothing to undo',
    'status.colorAdded': 'Palette now has {n} colours',
    'status.paletteFull': 'Palette is full at 255 colours',

    'error.webgl': 'WebGL2 required',
  },

  ru: {
    'app.tagline': 'спереди / сбоку / сверху → воксели → спрайты',
    'app.loadDemo': 'Демо',
    'app.clear': 'Очистить',
    'app.source': 'Исходники',
    'app.theme': 'Светлая / тёмная тема',
    'app.language': 'Переключить язык',

    'views.heading': 'Исходные виды',
    'views.hint': 'Перетащите PNG на любой слот. Размер любой — каждый вид размещается на сетке независимо, так что виды не обязаны совпадать.',
    'views.empty': 'пусто',
    'views.flipH': 'Отразить по горизонтали',
    'views.flipV': 'Отразить по вертикали',
    'views.remove': 'Убрать',
    'views.front': 'спереди',
    'views.back': 'сзади',
    'views.right': 'справа',
    'views.left': 'слева',
    'views.top': 'сверху',
    'views.bottom': 'снизу',
    'views.mirrored': 'зеркало',

    'grid.label': 'Сетка',
    'grid.fit': 'Подогнать',
    'grid.build': 'Собрать модель',

    'viewport.emptyTitle': 'Модели пока нет.',
    'viewport.emptyHintBefore': 'Перетащите арт в слот, или ',
    'viewport.emptyHintLink': 'загрузите демо',
    'viewport.emptyHintAfter': '.',
    'viewport.zoomIn': 'Приблизить',
    'viewport.zoomOut': 'Отдалить',

    'angle.front': 'Спереди',
    'angle.right': 'Справа',
    'angle.back': 'Сзади',
    'angle.left': 'Слева',
    'angle.iso': 'Изо',

    'view.heading': 'Просмотр',
    'view.elevation': 'Возвышение',
    'view.shading': 'Затенение граней (только в окне)',
    'view.bounds': 'Показывать границы сетки',
    'view.mirror': 'Зеркалить недостающие виды',
    'view.mirrorHint': 'Заливает грани, смотрящие от вас, артом противоположного вида вместо угадывания. Геометрию не меняет.',

    'pitch.iso21': 'Диметрия 2:1 (pixel-clean)',
    'pitch.isoTrue': 'Истинная изометрия 35.26°',
    'pitch.deg30': '30° (как в RPG Maker)',
    'pitch.deg45': '45°',
    'pitch.deg60': '60°',
    'pitch.top': '90° сверху',
    'pitch.side': '0° сбоку',

    'export.heading': 'Экспорт спрайтов',
    'export.directions': 'Направлений',
    'export.angles': 'Углы',
    'export.anglesClean': 'Чистые по пикселям',
    'export.anglesUniform': 'Равномерно 360/n',
    'export.scale': 'Масштаб',
    'export.scaleUnit': 'пкс / воксель',
    'export.padding': 'Отступ',
    'export.paddingUnit': 'пкс',
    'export.shaded': 'С затенением, примагниченным к палитре',
    'export.sheet': 'Экспорт спрайт-листа',
    'export.frames': 'Экспорт кадров + JSON',
    'export.framePreview': 'кадр {fw}×{fh} пкс · лист {sw}×{sh} пкс · один холст на все кадры',

    'model.heading': 'Модель',
    'model.smooth': 'Гладкий меш вместо кубиков (вид и экспорт)',
    'model.relax': 'Скругление',
    'model.smoothHint': 'Показывает и экспортирует округлённую low-poly оболочку по тем же вокселям (surface nets), сохраняя цвет каждой грани. Количество деталей по-прежнему задаёт сетка.',
    'model.obj': 'Экспорт OBJ + MTL',
    'model.vox': 'Экспорт .vox (MagicaVoxel)',
    'model.save': 'Сохранить проект',
    'model.load': 'Загрузить проект',

    'stats.none': 'модели нет',
    'stats.voxels': 'воксели',
    'stats.faces': 'грани',
    'stats.extent': 'габарит',
    'stats.palette': 'палитра',
    'stats.inferred': 'достроенных граней',
    'stats.mirrored': 'зеркальных видов',

    'status.ready': 'готов',
    'status.built': 'Собрано {n} вокселей за {ms} мс',
    'status.builtMirrored': 'Собрано {n} вокселей за {ms} мс · отзеркалено: {views}',
    'status.emptyCarve': 'Ничего не вырезалось — виды могут не пересекаться. Попробуйте отразить вид или проверьте альфа-канал.',
    'status.paletteOverflow': 'Собрано за {ms} мс — в арте больше 255 цветов, лишние примагничены к ближайшим.',
    'status.badImage': 'Не удалось прочитать изображение: {err}',
    'status.rendering': 'рендерим…',
    'status.meshing': 'строим меш…',
    'status.exportedSheet': 'Экспортировано {n} кадров по {w}×{h} пкс',
    'status.exportedFrames': 'Экспортировано {n} кадров + метаданные',
    'status.exportedObj': 'OBJ: {quads} квадов ({saved}% склеено), {verts} вершин',
    'status.exportedObjSmooth': 'OBJ (гладкий): {quads} квадов, {verts} вершин',
    'status.exportedVox': '.vox: {n} вокселей, цветов {c}, {w}×{h}×{d}',
    'status.projectSaved': 'Проект сохранён',
    'status.projectLoaded': 'Проект загружен',
    'status.projectFailed': 'Не удалось загрузить проект: {err}',

    'edit.heading': 'Редактор',
    'edit.brush': 'Кисть',
    'edit.faceOnly': 'Красить одну грань, а не весь воксель',
    'edit.symmetryX': 'Зеркалить правки по X',
    'edit.newColor': 'Выберите цвет для палитры',
    'edit.addColor': 'Добавить цвет',
    'edit.undo': 'Отменить',
    'edit.redo': 'Вернуть',
    'edit.hint': 'Левая кнопка применяет инструмент; Shift — вращение, Ctrl — панорама. Ctrl+Z отменяет весь мазок целиком.',
    'edit.rebuildWarning': 'Пересборка заменяет ручные правки. История отмен очищена.',
    'tool.orbit': 'Вращение',
    'tool.paint': 'Кисть',
    'tool.fill': 'Заливка',
    'tool.erase': 'Стирка',
    'tool.add': 'Добавить',
    'tool.pick': 'Пипетка',
    'tool.box': 'Бокс',
    'tool.boxErase': 'Бокс вырез',
    'edit.boxHint': 'Тяните рамку по грани — она выдавливается вдоль этой грани на глубину кисти. «Бокс» добавляет наружу, «Бокс вырез» убирает вглубь.',
    'status.edited': 'Изменено вокселей: {n} · {tool}',
    'status.boxApplied': 'Бокс: вокселей {n}, {w}×{h}×{d}',
    'status.undone': 'Отменено',
    'status.redone': 'Возвращено',
    'status.nothingToUndo': 'Отменять нечего',
    'status.colorAdded': 'В палитре теперь цветов: {n}',
    'status.paletteFull': 'Палитра заполнена: 255 цветов',

    'error.webgl': 'Требуется WebGL2',
  },
};

export const LANGUAGES = /** @type {const} */ (['en', 'ru']);

let current = detect();

/** @returns {'en'|'ru'} */
function detect() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'ru') return saved;
  } catch {
    // Private mode, blocked storage: fall through to the browser's own setting.
  }
  return /^ru\b/i.test(navigator.language || '') ? 'ru' : 'en';
}

/** @returns {'en'|'ru'} */
export function getLang() {
  return current;
}

/** @param {'en'|'ru'} lang */
export function setLang(lang) {
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Not being able to remember the choice is not a reason to refuse it.
  }
  document.documentElement.lang = lang;
}

/**
 * Placeholder values are resolved at render time, not at call time, so a
 * message composed in one language still reads correctly after a switch:
 * numbers pick up the locale's separators, and an array is treated as a list
 * of i18n keys to translate and join.
 *
 * @param {string} key
 * @param {Record<string, string|number|string[]>} [params]
 * @returns {string}
 */
export function t(key, params) {
  const table = STRINGS[current] ?? STRINGS.en;
  let s = table[key] ?? STRINGS.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      let value;
      if (Array.isArray(v)) value = v.map((item) => t(item)).join(', ');
      else if (typeof v === 'number') value = num(v);
      else value = String(v);
      s = s.split('{' + k + '}').join(value);
    }
  }
  return s;
}

/** Locale-aware thousands separators. @param {number} n */
export function num(n) {
  return n.toLocaleString(current === 'ru' ? 'ru-RU' : 'en-US');
}

/**
 * Re-render every translatable node. Cheap enough to run on every switch.
 * @param {ParentNode} [root]
 */
export function applyTranslations(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = /** @type {HTMLElement} */ (el).dataset.i18n;
    if (key) el.textContent = t(key);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const key = /** @type {HTMLElement} */ (el).dataset.i18nTitle;
    if (key) el.setAttribute('title', t(key));
  }
  for (const el of root.querySelectorAll('[data-i18n-aria]')) {
    const key = /** @type {HTMLElement} */ (el).dataset.i18nAria;
    if (key) el.setAttribute('aria-label', t(key));
  }
}
