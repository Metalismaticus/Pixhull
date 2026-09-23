# Pixhull MCP server

Lets an assistant carve a voxel model from pixel-art views, **look at it**, and
export it — over files on your own disk, with no hosting and no account.

It runs the same modules as the web app. A model carved here and a model carved
in the browser are the same model; there is no second implementation to drift.
The smoke test asserts it: both produce 1,438 voxels and 25×20 frames from the
same three PNGs.

## Requirements

Node 18 or newer. Nothing else — no `npm install`, no dependencies.

## Register it

The server takes one argument: **the directory it is allowed to touch**. It
refuses any path that escapes it, which matters for a tool an assistant drives
on its own. Point it at your art folder, not at your home directory.

**Claude Code**

```bash
claude mcp add pixhull -- node /path/to/Pixhull/mcp/server.js /path/to/your/art
```

**Claude Desktop** — in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pixhull": {
      "command": "node",
      "args": ["/path/to/Pixhull/mcp/server.js", "/path/to/your/art"]
    }
  }
}
```

On Windows the paths need doubled backslashes:
`"C:\\Users\\you\\Pixhull\\mcp\\server.js"`.

Other MCP clients take the same shape: a command, its arguments, stdio
transport.

## Tools

| Tool | What it does |
|------|--------------|
| `carve_views` | Takes PNG paths for any of front, back, left, right, top, bottom and carves a model. Views may be any size and need not match each other. Returns a `model_id`. |
| `render_preview` | Renders the model and returns it **as an image**, so the assistant can see what it made and say "the roof is a row too tall" instead of guessing from a voxel count. |
| `export_model` | Writes `glb` (glTF — one material with vertex colours, the easiest to drop into an engine), `obj` (+ MTL), `vox` (MagicaVoxel), or `sprites` (a pixel-perfect turnaround sheet plus JSON with per-frame pivots). `glb` and `obj` can be a smooth mesh instead of cubes. |

A typical exchange:

```
carve_views   { front: "hero-front.png", right: "hero-side.png", top: "hero-top.png" }
              -> model_id: model-1, 1438 voxels, extent 12x10x22
render_preview { model_id: "model-1", directions: 4 }
              -> [image]
export_model  { model_id: "model-1", format: "vox", name: "hero" }
              -> wrote hero.vox
```

## Rendering without a GPU

There is no WebGL in Node, so previews are drawn on the CPU — one ray per pixel
through the same grid walk the editor uses for picking. The camera is
orthographic and the geometry is a grid, so this gives exactly what the GPU
would, with no triangle setup and no chance of the preview disagreeing with what
a click in the editor would hit. A 64×64 frame is 4,096 short rays, which is
nothing.

## Check it

```bash
node tools/mcp-smoke.mjs
```

Drives the server over stdio the way a client would — handshake, tool listing,
every tool, plus the refusals — and verifies what comes back, including that the
sprite sheet matches its own metadata. It stands in for a real client, so it
catches protocol mistakes and broken tools, not a particular client's quirks.

## Limits worth knowing

- Interlaced (Adam7) PNGs are rejected with a clear message. Save without
  interlacing.
- The model store is in memory, so a `model_id` lasts as long as the server
  process does.
- Editing tools — paint, box, erase — are not exposed yet. The assistant can
  carve and export, but reshaping still happens in the browser.
