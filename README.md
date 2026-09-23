# Pixhull

Turn front / side / top pixel art into a 3D voxel model, then export
pixel-perfect sprite turnarounds and OBJ models.

**[Open it &rarr;](https://metalismaticus.github.io/Pixhull/)** &nbsp;·&nbsp;
[Инструкция на русском](README.ru.md)

Runs entirely in the browser. No install, no account, no server, no build step.
Free and open source.

---

## What it does

Drop in up to six orthographic images — front, back, left, right, top, bottom —
and Pixhull intersects their silhouettes into a voxel model, transfers each
view's pixels onto the faces that view can see, and renders the result with an
orthographic camera locked to the pixel grid.

```
front.png ─┐
side.png  ─┼─►  visual hull  ─►  per-face colour  ─►  ┬─► sprite sheet + JSON
top.png   ─┘                                          └─► OBJ + MTL
```

### Six colours per voxel, not one

A voxel stores an independent palette index for each of its six faces. Seen
from the front you get the front view's pixel; seen from the side you get the
side view's. That is why the result reads as the original art rather than as a
blocky approximation of it — and it is why `.vox` is not the native format here
(MagicaVoxel voxels carry a single colour).

### Angles that land on the pixel grid

Stepping a turnaround by `360/n` degrees gives angles whose projected edges have
irrational slopes. A cube edge at 22.5° cannot sit on a pixel grid, so every
frame needs anti-aliasing — and anti-aliasing is what stops it reading as pixel
art.

Pixhull generates angles from the Stern-Brocot tree instead, so every edge is a
repeating pixel staircase:

| directions | uniform `360/n`           | pixel-clean                       |
|-----------:|---------------------------|-----------------------------------|
| 8          | 0, 45, 90, 135, …         | 0, 45, 90, 135, … (already clean) |
| 16         | 0, **22.5**, 45, **67.5** | 0, **26.565** (1:2), 45, **63.435** (2:1) |
| 12         | 0, 30, 60, 90, …          | 0, 30.964 (3:5), 59.036 (5:3), 90, … |

Any frame count from 1 to 64 works. Counts that are not `4·2^k` get uniform
angles snapped onto the nearest clean slope.

### Exports that do not drift

Every frame of a turnaround uses **one canvas size and a recorded pivot**. The
frame size is computed once as the largest projection across all angles, and
the model is centred on a whole-pixel offset, so nothing shimmers as it turns
and nothing lands a pixel off once it is in the engine. There is no per-frame
auto-crop, ever.

`sprites.json` ships next to the sheet with frame size, per-frame yaw, sheet
offsets, pivots, and the palette.

### On-palette by construction

Colours are interned into a 255-entry indexed palette at import. The model
cannot contain a colour that was not in the source art, rendering runs with
antialiasing off, and shaded exports are snapped back to the palette. A flat
export is verifiably exact: zero off-palette pixels, zero partial alpha.

### Mirrored fill for the views you did not draw

Draw three views and three facings have no source at all — the back, the left
and the underside. Guessing a colour for them from neighbouring faces leaves
half the model looking flat and wrong, and a face with no colour at all is
*discarded by the shader*, which is a hole you can see straight through.

So a missing view is synthesised by mirroring its opposite. This cannot change
the shape: the back silhouette of an opaque object is the mirrored front
silhouette, so the mirrored view contributes colour only. Anything still
uncovered falls back to the model's dominant colour, and the invariant is that
no exposed face is ever left uncoloured.

### Light and dark, English and Russian

Both themes follow the system preference on first load and are remembered after
that. The UI switches between English and Russian from the top bar, including
numbers, which pick up the locale's separators.

### Editing, because the method needs it

A visual hull cannot represent a concavity no silhouette reveals, so hand
editing is not a convenience bolted on afterwards - it is the other half of the
method. Paint a face or a whole voxel, bucket-fill across a surface (following
staircases, not stopping at the edge of a plane), erase, add, and pick a colour
off the model. Brush up to 9³, optional mirroring across X, and undo/redo where
**one stroke is one step** rather than one voxel.

Every operation that can expose a new face colours it, because an uncoloured
face is discarded by the shader and becomes a hole.

Projects save the voxels, not just the source views - re-carving from the same
PNGs could never reproduce something carved by hand. Two run-length streams get
the demo from 94 KiB raw to 5.8 KiB, and the round-trip is bit-exact.

### Exporting to a one-colour-per-voxel world

`.vox` gives a voxel a single colour, and Pixhull gives it six. The export
resolves that with a vote among the faces you can actually see: a tyre whose
visible faces are all black stays black, and buried faces get no say, because
letting hidden geometry decide how a model looks is how exports end up muddy.
The 256-entry palette matches Pixhull's exactly, so colours make the trip with
no requantisation.

### Any image size

Views do not have to be square, do not have to match each other, and do not
have to be a power of two. Each view is trimmed to its content and placed on
the grid independently. The demo deliberately uses 12×12, 24×12 and 12×24.

---

## Run it locally

ES modules will not load over `file://`, so use the bundled dev server:

```bash
node tools/serve.mjs
```

Then open <http://localhost:5173>. No `npm install` — there are no dependencies.

## Deploy

Push to `main`. The included workflow mirrors it to `gh-pages`, which is what
Pages serves; there is nothing to build, so the repository root is the site.

---

## How it works

| File | What lives there |
|------|------------------|
| [`src/core/volume.js`](src/core/volume.js) | Sparse 16³-chunked voxel storage, occupancy bitset + 6 palette bytes per voxel |
| [`src/core/carve.js`](src/core/carve.js) | Silhouette intersection and per-face colour transfer |
| [`src/core/views.js`](src/core/views.js) | Source images, trimming, placement, the view↔axis convention |
| [`src/gfx/camera.js`](src/gfx/camera.js) | Orthographic camera and the pixel-clean angle maths |
| [`src/gfx/renderer.js`](src/gfx/renderer.js) | Instanced face renderer — one draw call for the whole model |
| [`src/export/sprite.js`](src/export/sprite.js) | Turnaround rendering, sheet packing, palette snapping |
| [`src/export/obj.js`](src/export/obj.js) | OBJ + MTL with greedy face merging (~90% fewer quads on the demo) |
| [`src/export/vox.js`](src/export/vox.js) | MagicaVoxel `.vox`, resolving six face colours to the one a voxel gets |
| [`src/edit/pick.js`](src/edit/pick.js) | Screen ray and grid walk — a click to a voxel and a face |
| [`src/edit/tools.js`](src/edit/tools.js) | Paint, fill, erase, add, symmetry, and face healing |
| [`src/edit/history.js`](src/edit/history.js) | Undo/redo, one step per stroke, storing only touched voxels |
| [`src/core/serialize.js`](src/core/serialize.js) | Run-length project format so hand edits survive a save |

### Known limits of the approach

A visual hull cannot represent a concavity that no silhouette reveals — the
inside of a hood, a dimple, a blind hole. Those come out filled. Two unrelated
shapes in different views also generate phantom volume where their projections
cross. Both are inherent to shape-from-silhouette, not bugs, and both are why
the editor exists rather than being optional.

---

## Roadmap

- [x] Voxel painting, filling, adding and erasing in the 3D view, with undo/redo
- [x] Mirror editing across X
- [ ] Selections, layers and separate parts
- [ ] Rebuild only the chunks an edit dirtied, instead of the whole instance buffer
- [ ] Per-view depth map input, to recover concavities the hull cannot
- [ ] Animation: parts with pivots, wheel spin, sprite sheets per animation
- [x] `.vox` export (MagicaVoxel)
- [ ] PNG slice export (sprite stacking)
- [ ] glTF export
- [ ] Engine metadata presets (Godot, Unity, GameMaker, RPG Maker)
- [ ] Desktop build via Tauri
- [ ] An MCP server over the same core, so an assistant can hand it views and get a model back

## Licence

MIT — see [LICENSE](LICENSE).
