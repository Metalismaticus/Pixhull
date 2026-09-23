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

/**
 * Exported so `tests/i18n/parity.mjs` can count the keys of each language.
 * A key added to one language and forgotten in the other is a defect, and
 * counting it is the only way to catch it before a reader does.
 * @type {Record<string, Record<string, string>>}
 */
export const STRINGS = {
  en: {
    'app.tagline': 'front / side / top → voxels → sprites',
    'app.loadDemo': 'Load demo',
    'app.clear': 'Clear',
    'app.source': 'Source',
    'app.getLocal': 'Local app',
    'app.theme': 'Light / dark theme',
    'app.language': 'Switch language',

    'views.heading': 'Source views',
    'sheet.open': 'Slice a sheet…',
    'sheet.heading': 'Slice a reference sheet',
    'sheet.hint': 'Drop in one image with several views on it. Drawings separated by transparent space are found automatically; check what went where and fix anything wrong.',
    'sheet.gap': 'Gutter',
    'sheet.summary': 'Found {n} drawings in a {w}×{h} sheet',
    'sheet.summaryGuessed': 'Found {n} drawings in a {w}×{h} sheet · sizes identify front, right and top',
    'sheet.ignore': '— skip —',
    'sheet.cancel': 'Cancel',
    'sheet.apply': 'Use these views',
    'sheet.none': 'No separate drawings found. Try a wider gutter, or the views may be touching.',
    'views.hint': 'Drop a PNG on any slot. Any size — each view is placed on the grid independently, so views do not have to match.',
    'views.empty': 'empty',
    'views.rotate': 'Turn a quarter clockwise',
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
    'grid.hint': 'The grid is how many voxels the model is allowed to be across. Above the size of your art it only makes the voxels smaller than a pixel; below it, detail is thrown away. 384 and 512 are for art larger than 256 px a side and cost seconds, not milliseconds.',
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
    'model.smoothHint': 'Shows and exports a rounded low-poly shell over the same voxels, keeping every face colour. Rounding reads the surface direction from a blurred copy of the model, so a staircase melts into the slope it was standing in for while a real edge - the corner of a box body - stays an edge. Grid resolution still sets how much detail there is.',
    'model.obj': 'Export OBJ + MTL',
    'model.glb': 'Export .glb (glTF)',
    'model.voxTooBig': 'Not available: this model is {span} voxels across and MagicaVoxel stores a size in one byte per axis, so {max} is its hard ceiling. OBJ and glTF have no such limit. To get a .vox, rebuild at {max} or smaller.',
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
    'stats.reduction': 'art reduced',

    'status.ready': 'ready',
    'status.built': 'Built {n} voxels in {ms} ms',
    'status.lookalikeViews': 'The {a} and {b} drawings are {pct}% the same shape, but they should be looking at different sides. One of them is in the wrong slot — skip it, or move it.',
    'status.viewsDisagree': 'Built {n} voxels — the {view} drawing had to be squashed {amount}× against itself to fit what the others say. Its proportions disagree with theirs, so the shape is approximate.',
    'axis.x': 'width',
    'axis.y': 'height',
    'axis.z': 'length',
    'status.spikePlaced': 'Built {n} voxels — the drawings disagree about how far a thin part stands proud in {axis}: one separates it from the body, another draws the body that wide. The part was put where the other drawings place it along the model, instead of being stretched down its whole length.',
    'status.spikeTrimmed': 'Built {n} voxels — the drawings disagree about how far a thin part stands proud in {axis}: one separates it from the body, another draws the body that wide. The body was believed and {pct}% trimmed off each side, rather than smeared down the length of the model.',
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
    'status.exportedGlb': 'glTF: {tris} triangles, {verts} vertices, one material with vertex colours',
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
    'edit.recolour': 'double-click to change this colour',
    'edit.undo': 'Undo',
    'edit.redo': 'Redo',
    'edit.hint': 'Left-drag applies the tool; hold Shift to orbit, Ctrl to pan. Ctrl+Z undoes a whole stroke.',
    'edit.rebuildWarning': 'Rebuilding replaces your hand edits, and the undo history goes with them.',
    'edit.rebuildConfirm': 'Rebuild anyway?',
    'edit.rebuildKept': 'Hand edits kept — nothing was rebuilt.',
    'tool.orbit': 'Orbit',
    'tool.paint': 'Paint',
    'tool.fill': 'Fill',
    'tool.erase': 'Erase',
    'tool.add': 'Add',
    'tool.pick': 'Pick colour',
    'tool.box': 'Box',
    'tool.boxErase': 'Box cut',
    'edit.boxHint': 'Drag a rectangle on a face: it extrudes along that face by the brush depth. Box adds outward, Box cut removes inward.',
    'edit.paletteHeading': 'Palette',
    'tool.orbit.hint': 'Drag to turn the model. No edit is made.',
    'tool.paint.hint': 'Paints the face under the cursor, or the whole brush cube.',
    'tool.fill.hint': 'Spreads across faces of the same colour, following staircases. Stops at 400 000 faces.',
    'tool.erase.hint': 'Removes the brush cube and recolours the faces it lays bare.',
    'tool.add.hint': 'Adds the brush cube outward from the face under the cursor.',
    'tool.pick.hint': 'Takes the colour of the face under the cursor into the palette selection. Alt does the same without switching tools.',
    'edit.brushOff': 'Fill and Pick work on one face — brush size changes nothing here.',
    'edit.faceOnlyOff': 'Only Paint can limit itself to one face.',
    'edit.nothingYet': 'Nothing to undo yet — no edits have been made.',
    'edit.paletteEmpty': 'No palette yet — build the model, or add a colour below.',
    'edit.paletteFullHint': 'The palette holds 255 colours — a new one will snap to the nearest instead.',
    'edit.swatchInfo': 'slot {i} · {hex} · {n} faces',
    'edit.swatchUnused': 'slot {i} · {hex} · 0 faces — unused',
    'edit.swatchUncounted': 'slot {i} · {hex} · faces not counted',
    'status.hover': '{x},{y},{z} · {face} · {hex} · slot {i}',
    'status.hoverBrush': '{base} · brush {n}',
    'status.hoverFill': '{base} · fill {n}',
    'status.hoverFillMore': '{base} · fill ≈ {n} and more',
    'status.filled': 'Fill: {n} faces',
    'status.filledCapped': 'Fill stopped at {n} faces — the surface is larger than one fill can take.',
    'status.picked': 'Picked slot {i} · {hex}',
    'status.editedNothing': 'Nothing changed — that face already wears this colour.',
    'status.edited': 'Edited {n} voxels · {tool}',
    'status.boxApplied': 'Box: {n} voxels {w}×{h}×{d}',
    'status.undone': 'Undone',
    'status.redone': 'Redone',
    'status.nothingToUndo': 'Nothing to undo',
    'status.colorAdded': 'Palette now has {n} colours',
    'status.paletteFull': 'Palette is full at 255 colours',
    'status.colorReplaced': 'Colour {n} is now {hex}',

    'dl.tagline': "run it locally, let an assistant drive it",
    'dl.backToApp': "Back to the app",
    'dl.heading': "Pixhull on your own machine",
    'dl.lede': "The same tool, plus an MCP server so an assistant can carve models for you over files on your own disk. No hosting, no account, nothing uploaded anywhere.",
    'dl.download': "Download (ZIP)",
    'dl.requirements': "Node 18 or newer. Nothing else.",
    'dl.noInstall': "There is no install step and no npm install — the repository has no dependencies at all. Unpack it and point your assistant at it.",
    'dl.copy': "Copy",
    'dl.copied': "Copied",
    'dl.copyFailed': "Copy blocked",
    'dl.whatHeading': "What you get",
    'dl.whatBody': "An assistant that can carve a voxel model from your pixel-art views, look at what it made, and write out OBJ, .vox or a pixel-perfect sprite sheet — all by reading and writing files in one folder you nominate.",
    'dl.sameCore': "It runs the same modules as this page rather than a reimplementation, so the two cannot drift: from the same three PNGs both produce 1,438 voxels, 25×20 frames and a byte-identical .vox.",
    'dl.setupHeading': "Setting it up",
    'dl.rootWarning': "The server takes one argument: the folder it is allowed to touch. It refuses any path that escapes it, which matters for a tool an assistant drives on its own. Point it at your art folder, not at your home directory.",
    'dl.claudeCode': "Claude Code",
    'dl.claudeDesktop': "Claude Desktop",
    'dl.desktopWhere': "Add this to claude_desktop_config.json:",
    'dl.windowsPaths': "On Windows the backslashes need doubling: \"C:\\\\Users\\\\you\\\\Pixhull\\\\mcp\\\\server.js\".",
    'dl.otherClients': "Other clients",
    'dl.otherClientsBody': "Anything that speaks MCP over stdio takes the same shape: a command, its arguments, and no network configuration.",
    'dl.toolsHeading': "The tools it offers",
    'dl.toolCarve': "Carves a model from PNG paths for any of the six views. They may be any size and need not match each other. Returns a model id.",
    'dl.toolPreview': "Renders the model and returns it as an image. This is the one that matters: without it the assistant reads back a voxel count and has no way to tell that the roof is a row too tall.",
    'dl.toolExport': "Writes .glb (glTF — one material with vertex colours, the easiest to drop into an engine), OBJ, .vox for MagicaVoxel, or a turnaround sheet with per-frame pivots in JSON. The mesh can be smooth instead of cubes.",
    'dl.exampleIntro': "A typical exchange looks like this:",
    'dl.checkHeading': "Checking it works",
    'dl.checkBody': "This drives the server over stdio the way a client would — handshake, tool listing, every tool, and the refusals — and verifies what comes back.",
    'dl.webHeading': "Running the web app offline",
    'dl.webBody': "The same folder serves this page locally. Browsers will not load ES modules over file://, so use the bundled server and open localhost:5173.",
    'dl.limitsHeading': "Worth knowing",
    'dl.limitInterlace': "Interlaced (Adam7) PNGs are rejected with a clear message. Save without interlacing.",
    'dl.limitMemory': "Models live in memory, so a model id lasts as long as the server process does.",
    'dl.limitEditing': "Painting, the box tool and erasing are not exposed over MCP yet. The assistant can carve and export; reshaping still happens in the browser.",
    'dl.limitUntested': "The protocol is implemented to spec and tested against a harness here, but not against every client in the wild. If yours will not connect, that is worth reporting.",
    'dl.moreDetail': "Fuller detail in",

    'error.webgl': 'WebGL2 required',
  },

  ru: {
    'app.tagline': 'спереди / сбоку / сверху → воксели → спрайты',
    'app.loadDemo': 'Демо',
    'app.clear': 'Очистить',
    'app.source': 'Исходники',
    'app.getLocal': 'Локально',
    'app.theme': 'Светлая / тёмная тема',
    'app.language': 'Переключить язык',

    'views.heading': 'Исходные виды',
    'sheet.open': 'Нарезать лист…',
    'sheet.heading': 'Нарезка листа',
    'sheet.hint': 'Загрузите одну картинку, на которой несколько видов. Рисунки, разделённые прозрачным промежутком, находятся сами — проверьте, что куда попало, и поправьте неверное.',
    'sheet.gap': 'Промежуток',
    'sheet.summary': 'Найдено рисунков: {n}, лист {w}×{h}',
    'sheet.summaryGuessed': 'Найдено рисунков: {n}, лист {w}×{h} · размеры сами задают виды спереди, справа и сверху',
    'sheet.ignore': '— пропустить —',
    'sheet.cancel': 'Отмена',
    'sheet.apply': 'Взять эти виды',
    'sheet.none': 'Отдельных рисунков не нашлось. Попробуйте шире промежуток — возможно, виды соприкасаются.',
    'views.hint': 'Перетащите PNG на любой слот. Размер любой — каждый вид размещается на сетке независимо, так что виды не обязаны совпадать.',
    'views.empty': 'пусто',
    'views.rotate': 'Повернуть на четверть по часовой',
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
    'grid.hint': 'Сетка — во сколько вокселей укладывается модель. Выше размера вашего арта она только дробит пиксель, ниже — выбрасывает детали. 384 и 512 нужны для арта крупнее 256 пикселей по стороне и стоят секунд, а не миллисекунд.',
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
    'model.smoothHint': 'Показывает и экспортирует округлённую low-poly оболочку по тем же вокселям, сохраняя цвет каждой грани. Скругление берёт направление поверхности из размытой копии модели, поэтому лесенка расплывается в тот наклон, который она изображала, а настоящее ребро — угол кузова — остаётся ребром. Количество деталей по-прежнему задаёт сетка.',
    'model.obj': 'Экспорт OBJ + MTL',
    'model.glb': 'Экспорт .glb (glTF)',
    'model.voxTooBig': 'Недоступно: модель {span} вокселей по стороне, а MagicaVoxel хранит размер в одном байте на ось — его жёсткий предел {max}. У OBJ и glTF такого ограничения нет. Нужен .vox — соберите на {max} или меньше.',
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
    'stats.reduction': 'арт уменьшен',

    'status.ready': 'готов',
    'status.built': 'Собрано {n} вокселей за {ms} мс',
    'status.lookalikeViews': 'Рисунки «{a}» и «{b}» совпадают по форме на {pct}%, хотя должны смотреть с разных сторон. Один из них не в том слоте — пропустите его или переставьте.',
    'status.viewsDisagree': 'Собрано {n} вокселей — рисунок «{view}» пришлось сжать в {amount}× относительно самого себя. Его пропорции расходятся с остальными, так что форма приблизительная.',
    'axis.x': 'ширине',
    'axis.y': 'высоте',
    'axis.z': 'длине',
    'status.spikePlaced': 'Собрано {n} вокселей — рисунки расходятся в том, насколько тонкая деталь выступает по {axis}: один вид отделяет её от корпуса, другой рисует корпус такой же ширины. Деталь поставлена туда, куда её помещают остальные виды, вместо того чтобы тянуться наростом вдоль всей модели.',
    'status.spikeTrimmed': 'Собрано {n} вокселей — рисунки расходятся в том, насколько тонкая деталь выступает по {axis}: один вид отделяет её от корпуса, другой рисует корпус такой же ширины. Поверили корпусу и срезали по {pct}% с каждой стороны — иначе выступ протянулся бы наростом вдоль всей модели.',
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
    'status.exportedGlb': 'glTF: треугольников {tris}, вершин {verts}, один материал с вершинными цветами',
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
    'edit.recolour': 'двойной щелчок — сменить цвет',
    'edit.undo': 'Отменить',
    'edit.redo': 'Вернуть',
    'edit.hint': 'Левая кнопка применяет инструмент; Shift — вращение, Ctrl — панорама. Ctrl+Z отменяет весь мазок целиком.',
    'edit.rebuildWarning': 'Пересборка заменит ручные правки, а вместе с ними и историю отмен.',
    'edit.rebuildConfirm': 'Всё равно пересобрать?',
    'edit.rebuildKept': 'Ручные правки сохранены — пересборки не было.',
    'tool.orbit': 'Вращение',
    'tool.paint': 'Кисть',
    'tool.fill': 'Заливка',
    'tool.erase': 'Стирка',
    'tool.add': 'Добавить',
    'tool.pick': 'Пипетка',
    'tool.box': 'Бокс',
    'tool.boxErase': 'Бокс вырез',
    'edit.boxHint': 'Тяните рамку по грани — она выдавливается вдоль этой грани на глубину кисти. «Бокс» добавляет наружу, «Бокс вырез» убирает вглубь.',
    'edit.paletteHeading': 'Палитра',
    'tool.orbit.hint': 'Тяните, чтобы повернуть модель. Ничего не правится.',
    'tool.paint.hint': 'Красит грань под курсором или весь куб кисти.',
    'tool.fill.hint': 'Растекается по граням того же цвета, идёт по ступенькам. Останавливается на 400 000 граней.',
    'tool.erase.hint': 'Убирает куб кисти и закрашивает открывшиеся грани.',
    'tool.add.hint': 'Добавляет куб кисти наружу от грани под курсором.',
    'tool.pick.hint': 'Берёт цвет грани под курсором в выбор палитры. Alt делает то же, не переключая инструмент.',
    'edit.brushOff': 'Заливка и пипетка работают по одной грани — размер кисти на них не влияет.',
    'edit.faceOnlyOff': 'Одну грань умеет красить только кисть.',
    'edit.nothingYet': 'Пока нечего отменять — правок ещё не было.',
    'edit.paletteEmpty': 'Палитры пока нет — соберите модель или добавьте цвет ниже.',
    'edit.paletteFullHint': 'В палитре 255 цветов — больше не помещается; новый цвет примагнитится к ближайшему.',
    'edit.swatchInfo': 'слот {i} · {hex} · граней {n}',
    'edit.swatchUnused': 'слот {i} · {hex} · граней 0 — не используется',
    'edit.swatchUncounted': 'слот {i} · {hex} · граней: не сочтены',
    'status.hover': '{x},{y},{z} · {face} · {hex} · слот {i}',
    'status.hoverBrush': '{base} · кисть {n}',
    'status.hoverFill': '{base} · заливка {n}',
    'status.hoverFillMore': '{base} · заливка ≈ {n} и больше',
    'status.filled': 'Заливка: граней {n}',
    'status.filledCapped': 'Заливка остановилась на {n} гранях — поверхность больше, чем берёт одна заливка.',
    'status.picked': 'Взят слот {i} · {hex}',
    'status.editedNothing': 'Ничего не изменилось — грань уже этого цвета.',
    'status.edited': 'Изменено вокселей: {n} · {tool}',
    'status.boxApplied': 'Бокс: вокселей {n}, {w}×{h}×{d}',
    'status.undone': 'Отменено',
    'status.redone': 'Возвращено',
    'status.nothingToUndo': 'Отменять нечего',
    'status.colorAdded': 'В палитре теперь цветов: {n}',
    'status.paletteFull': 'Палитра заполнена: 255 цветов',
    'status.colorReplaced': 'Цвет {n} теперь {hex}',

    'dl.tagline': "запустить локально и отдать ассистенту",
    'dl.backToApp': "Назад в приложение",
    'dl.heading': "Pixhull на вашей машине",
    'dl.lede': "Тот же инструмент плюс MCP-сервер, чтобы ассистент собирал модели за вас — через файлы на вашем диске. Без хостинга, без аккаунта, никуда ничего не загружается.",
    'dl.download': "Скачать (ZIP)",
    'dl.requirements': "Нужен Node 18 или новее. Больше ничего.",
    'dl.noInstall': "Установки нет и npm install нет — в репозитории вообще нет зависимостей. Распакуйте и укажите путь ассистенту.",
    'dl.copy': "Копировать",
    'dl.copied': "Скопировано",
    'dl.copyFailed': "Копирование заблокировано",
    'dl.whatHeading': "Что вы получаете",
    'dl.whatBody': "Ассистента, который соберёт воксельную модель из ваших видов, посмотрит на то, что вышло, и выгрузит OBJ, .vox или pixel-perfect спрайт-лист — читая и записывая файлы в одной папке, которую вы сами укажете.",
    'dl.sameCore': "Он гоняет те же модули, что и эта страница, а не их переписанную копию, поэтому разойтись они не могут: из одних и тех же трёх PNG оба дают 1438 вокселей, кадры 25×20 и побайтово одинаковый .vox.",
    'dl.setupHeading': "Подключение",
    'dl.rootWarning': "Сервер принимает один аргумент — папку, за пределы которой он не выйдет. Любой путь наружу отклоняется, и для инструмента, которым рулит ассистент, это важно. Указывайте папку с артом, а не домашний каталог.",
    'dl.claudeCode': "Claude Code",
    'dl.claudeDesktop': "Claude Desktop",
    'dl.desktopWhere': "Добавьте это в claude_desktop_config.json:",
    'dl.windowsPaths': "В Windows обратные слэши надо удваивать: \"C:\\\\Users\\\\you\\\\Pixhull\\\\mcp\\\\server.js\".",
    'dl.otherClients': "Другие клиенты",
    'dl.otherClientsBody': "Всё, что говорит по MCP через stdio, настраивается так же: команда, её аргументы и никакой сетевой настройки.",
    'dl.toolsHeading': "Какие инструменты он даёт",
    'dl.toolCarve': "Собирает модель по путям к PNG для любых из шести видов. Размер произвольный, совпадать они не обязаны. Возвращает идентификатор модели.",
    'dl.toolPreview': "Рендерит модель и возвращает её картинкой. Вот это и есть главное: без превью ассистент читает число вокселей и никак не может понять, что крыша на ряд выше, чем надо.",
    'dl.toolExport': "Пишет .glb (glTF — один материал с вершинными цветами, проще всего закинуть в движок), OBJ, .vox для MagicaVoxel или лист оборота с пивотами каждого кадра в JSON. Меш может быть гладким вместо кубиков.",
    'dl.exampleIntro': "Типичный обмен выглядит так:",
    'dl.checkHeading': "Проверка",
    'dl.checkBody': "Прогоняет сервер по stdio так же, как это делает клиент: рукопожатие, список инструментов, все инструменты и отказы — и проверяет, что вернулось.",
    'dl.webHeading': "Веб-версия офлайн",
    'dl.webBody': "Та же папка отдаёт и эту страницу. ES-модули браузер не грузит по file://, поэтому запустите приложенный сервер и откройте localhost:5173.",
    'dl.limitsHeading': "Что стоит знать",
    'dl.limitInterlace': "Чересстрочные (Adam7) PNG отклоняются с понятным сообщением. Сохраняйте без чересстрочности.",
    'dl.limitMemory': "Модели живут в памяти, так что идентификатор действует, пока работает процесс сервера.",
    'dl.limitEditing': "Кисть, бокс и стирка пока не вынесены в MCP. Ассистент собирает и экспортирует, а форму правят в браузере.",
    'dl.limitUntested': "Протокол реализован по спецификации и проверен здешним стендом, но не против каждого клиента в дикой природе. Если ваш не подключится — об этом стоит сообщить.",
    'dl.moreDetail': "Подробнее в",

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
  // Guarded so the table is readable headless too, for tests and tooling.
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
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
