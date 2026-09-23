# Pixhull

Turn front / side / top pixel art into a 3D voxel model, then export
pixel-perfect sprite turnarounds and OBJ models.

**[Open it &rarr;](https://metalismaticus.github.io/Pixhull/)** &nbsp;·&nbsp;
[Run it locally](https://metalismaticus.github.io/Pixhull/download.html) &nbsp;·&nbsp;
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

### Smooth meshes, not only cubes

The carve is a lattice and always will be - that is what shape-from-silhouette
on a grid produces, and the grid size is what sets how much detail exists. But
the exported *mesh* does not have to be cubes. Tick "smooth mesh" and the OBJ is
built with surface nets instead, and **the viewport shows it too**: one vertex
per cell the surface crosses, placed
at the average of the edge crossings, which turns a staircase into a rounded
low-poly shell. A rounding slider adds Laplacian passes on top.

Colour is free in this conversion - the quad for an edge between a solid and an
empty voxel *is* a face Pixhull already painted - so smoothing costs geometry
detail and never costs a colour. The demo comes out as a closed manifold: 1,084
quads, 1,086 vertices, every edge used exactly twice. It is higher-poly than the
greedy-merged blocky export (98 quads), because surface nets does not merge
coplanar faces.

### Driving it from an assistant

An MCP server ships alongside the app in [`mcp/`](mcp/README.md). Point an
assistant at a folder of PNGs and it can carve a model, **look at what it
made**, and export OBJ, `.vox` or a sprite sheet — locally, over files on
disk, with no hosting and no account.

It runs the same modules as the page rather than a port of them, so the two
cannot drift: from the same three PNGs both produce 1,438 voxels and 25×20
frames. Node has no WebGL, so previews are drawn on the CPU by casting one ray
per pixel through the same grid walk the editor uses for picking — the camera
is orthographic and the geometry is a grid, so that gives exactly what the GPU
would.

No dependencies there either: PNG decoding leans on the zlib already in Node,
and the protocol is JSON-RPC over stdio, written directly.
### One sheet in, views out

Artists keep one PNG with the front, the side and the top laid out together,
not three tidy files. Drop that in and Pixhull finds the drawings by their
empty gutters — not by connected components, which would shatter a character
with separated limbs into fragments, but by runs of transparent rows and
columns, which is precisely what a person means by "these are different
drawings".

Then it works out which is which from their sizes, because orthographic views
have to agree on the axes they share: front and right are the same height, top
is as wide as front and as deep as right is wide. Usually exactly one
arrangement satisfies all three, and it says so; otherwise it falls back to
reading order and you fix it in a click. A model carved from a sliced sheet is
voxel-for-voxel the one you get from three separate files.
### glTF, for engines that would rather not read 255 materials

OBJ works everywhere, but it arrives as one material per palette entry, which
is a mess to tidy up. A `.glb` carries colour as a vertex attribute instead, so
the model is one material and one draw call, and Godot, Unity and Unreal all
import it with no plugin.

Vertices are deliberately not shared between faces: a voxel corner belongs to
faces of different colours, and averaging them would smear the palette across
exactly the edges the art depends on. `KHR_materials_unlit` is declared as used
but not required, so a viewer that knows it shows the palette exactly and one
that does not still looks right.
### Art bigger than the grid is reduced, not cropped

A reference sheet drawn at 450 pixels across is not pixel art at voxel scale,
and it has to be brought down to the grid. Each grid cell takes a box of
source pixels: solid when most of that box is, coloured by the box’s most
common colour. Point sampling would be cheaper and wrong twice over — it drops
thin structures like a wing edge, and it picks up anti-aliasing fringes that
belong to neither side of an outline.

Reducing also reconciles the views against each other. Hand-drawn sheets
routinely disagree about an axis two views share — a side view drawn 18%
shorter than the front view says it is. Since an orthographic silhouette spans
the model’s full extent on both its axes by definition, fitting every view to
the agreed extent is the correction rather than a fudge, and the status bar
names whichever view had to be stretched most.

Art that already fits the grid is left strictly alone, at one art pixel per
voxel on whole-cell offsets. Resampling a 12-pixel wing to 13 cells would add
a column the artist never drew. Verified both ways: the demo is unchanged at
1,438 voxels, and consistent art upscaled 8× or 37× then reduced back carves
the identical model.
### Telling you when a sheet cannot work

Shape-from-silhouette fails silently and expensively. Put a drawing in the
front slot that is really a second top view and the carve still runs, still
reports a voxel count, and hands back a solid block of debris. Nothing in the
numbers says why, so the natural conclusion is that the tool is broken.

It is checkable, though. Views spanning different axis pairs should not look
alike — front spans (x, y) and top spans (x, z) — so if their silhouettes
match, the same drawing is in both slots. Opposite views are expected to match
and are exempt. Each silhouette is normalised into a 32×32 stamp of its own
bounding box first, so aspect and placement cannot disguise the match.

On a real sheet whose bottom two drawings were three-quarter beauty shots
rather than projections, top vs front scored 0.79 and top vs back 0.81,
against 0.52 for the genuine side view. The status bar now names the pair.
### A palette chosen by coverage, not by arrival

Colours used to be interned in the order they were met, which is how a white
box lorry came out entirely grey: the anti-aliased body contributed hundreds
of near-identical greys, they filled all 255 slots, and the red cab — met
later — was resolved to the nearest thing already in the table, which was a
grey. Every view is now sampled first, and the palette seeded with the colours
that cover the most of the model, so the real palette lands in the table and
the anti-aliasing fringes fall back onto it.

### Views drawn lying down

Artists lay a top view out lengthways to save sheet space, so its horizontal
axis is the model’s length where the tool expects its width. No amount of
scaling reconciles that — on a box lorry it asked for a 2.07× stretch and was
still wrong. Each view can be turned a quarter at a time, and the fitting step
picks the turns that make the shared axes agree, searching all 64 combinations
because six views is small enough not to need cleverness. That took the lorry
from 2.07× down to 1.26×. A view turned by hand is left alone thereafter.
### Which way round each drawing goes

Matching dimensions is not enough. A top view laid out lengthways fits the
grid equally well turned clockwise or anticlockwise, so a solver that only
compares sizes picks one arbitrarily — and half the time the nose ends up at
the wrong end of the model. The front view then paints the back, and wherever
two drawings disagree about where the cab stops, a face gets painted from the
wrong side: red speckles on a white box, white streaks across a red cab. One
misorientation, both symptoms.

Two kinds of evidence settle it. Views sharing a model axis are looking at the
same object along it, so their occupancy profiles along that axis must line up
— which catches mirroring. That cannot anchor an axis in space, though:
reverse z everywhere at once and every profile still agrees while the model is
built back to front. The anchor is that **the far slice of a view along an
axis should look like the view that stares down that axis**. The nose end of a
side view should be the colour of the front view. On a red-cabbed lorry that
is decisive.

With six views and four orientations each left to settle, the search is
exhaustive. A greedy walk was tried first and failed exactly where you would
expect: it had to commit to a side view before anything spanning that side
view’s long axis had been placed, so it had nothing to compare against.

On the lorry sheet it turns the top view 270° rather than 90° and mirrors both
side views, which is what a person doing it by hand arrives at. Red faces go
from spread evenly along the whole length to 89% of them in the last quarter.
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

To check every module still parses:

```bash
node tools/check.mjs
```

This imports each one rather than running `node --check`, which once accepted a
string literal broken across two lines that the browser rejected outright.

To exercise the MCP server end to end:

```bash
node tools/mcp-smoke.mjs
```

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
| [`src/core/align.js`](src/core/align.js) | Deciding which way round each drawing goes, from profiles and end colours |
| [`src/core/diagnose.js`](src/core/diagnose.js) | Spotting a drawing that is in the wrong slot, by silhouette |
| [`src/core/sheet.js`](src/core/sheet.js) | Slicing one reference sheet into views, and naming them by size |
| [`src/gfx/camera.js`](src/gfx/camera.js) | Orthographic camera and the pixel-clean angle maths |
| [`src/gfx/renderer.js`](src/gfx/renderer.js) | Instanced face renderer — one draw call for the whole model |
| [`src/export/sprite.js`](src/export/sprite.js) | Turnaround rendering, sheet packing, palette snapping |
| [`src/export/obj.js`](src/export/obj.js) | OBJ + MTL with greedy face merging (~90% fewer quads on the demo) |
| [`src/export/gltf.js`](src/export/gltf.js) | glTF 2.0 as a single .glb, one material with vertex colours |
| [`src/export/vox.js`](src/export/vox.js) | MagicaVoxel `.vox`, resolving six face colours to the one a voxel gets |
| [`src/export/surfacenets.js`](src/export/surfacenets.js) | Smooth mesh over the same volume, with per-face colours preserved |
| [`src/edit/pick.js`](src/edit/pick.js) | Screen ray and grid walk — a click to a voxel and a face |
| [`src/edit/tools.js`](src/edit/tools.js) | Paint, fill, erase, add, box, symmetry, and face healing |
| [`src/edit/history.js`](src/edit/history.js) | Undo/redo, one step per stroke, storing only touched voxels |
| [`src/core/serialize.js`](src/core/serialize.js) | Run-length project format so hand edits survive a save |
| [`src/export/turnaround.js`](src/export/turnaround.js) | Frame planning shared by the browser and the MCP server |
| [`mcp/server.js`](mcp/server.js) | The MCP server: JSON-RPC over stdio, no SDK, no dependencies |
| [`mcp/png.js`](mcp/png.js) | PNG decode and encode for Node, on the built-in zlib |
| [`mcp/raster.js`](mcp/raster.js) | CPU rendering, one ray per pixel through the editor's own grid walk |

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
- [x] `.vox` export (MagicaVoxel)
- [x] Smooth mesh export (surface nets)
- [x] A box tool, for reshaping a model faster than one voxel at a time
- [ ] Selections, layers and separate parts
- [x] A local MCP server, so an assistant can drive the pipeline over files on disk
- [x] A CPU renderer, so that server can hand back a preview the assistant can look at
- [ ] Expose the editing tools over MCP, so an assistant can reshape as well as carve
- [x] glTF/GLB export, for engines that prefer it to OBJ
- [ ] PNG slice export (sprite stacking)
- [ ] Per-view depth map input, to recover concavities the hull cannot
- [ ] Animation: parts with pivots, wheel spin, sprite sheets per animation
- [ ] Engine metadata presets (Godot, Unity, GameMaker, RPG Maker)
- [ ] Rebuild only the chunks an edit dirtied, instead of the whole instance buffer
- [ ] An import map, so a deploy can never serve a new page against cached older modules
- [ ] Desktop build via Tauri

## Licence

MIT — see [LICENSE](LICENSE).
