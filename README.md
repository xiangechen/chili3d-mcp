# Chili3D MCP

> Let an AI (e.g. Claude Desktop) generate and edit parametric 3D models over MCP — sharing the **same OCCT geometry core** as the browser app, producing an editable `.cd` node tree, not a dead mesh.

## Quick Start

```bash
npm install
npm run build
```

Add to your MCP client config (Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "chili3d": {
      "command": "node",
      "args": ["/absolute/path/to/chili3d/packages/mcp/dist/server.mjs"]
    }
  }
}
```

Restart the client. You can now use **headless tools** — the AI builds models and writes `.stl` / `.step` / `.cd` files.

## Live Mode (real-time browser editing)

Open two terminals:

```bash
npm run bridge   # terminal 1: WebSocket bridge on ws://localhost:8765
npm run dev      # terminal 2: dev server
```

Open **`http://localhost:8080/?live`** in the browser. The AI edits the model you're looking at in real time.

## Two Modes

| Mode | How it works |
|---|---|
| **Headless** | AI builds → writes files (`.stl` / `.step` / `.cd`). You open them yourself. |
| **Live** | AI edits the model in your open `?live` browser tab. 3D view updates instantly. |

Both run the **same interpreter and geometry core** — build headless to self-verify, then push live.

## CAD Program Format

`run_cad_program` / `live_run_cad_program` take an `ops[]` array. Each op references earlier results by `{ "ref": "<id>" }`. All lengths are **mm**, angles are **degrees**.

```json
{ "ops": [
  { "op": "box",     "id": "outer", "dx": 30, "dy": 30, "dz": 30 },
  { "op": "box",     "id": "inner", "dx": 24, "dy": 24, "dz": 40, "at": { "x": 3, "y": 3, "z": 3 } },
  { "op": "boolean", "id": "hollow", "kind": "cut", "a": { "ref": "outer" }, "b": { "ref": "inner" } }
] }
```

### Supported Ops

| Category | Ops |
|---|---|
| Primitives | `box` · `sphere` · `cylinder` · `cone` · `pyramid` |
| Sketches | `rect` · `circle` · `polygon` · `line` · `arc` · `polyline` |
| Solids | `extrude` · `revolve` · `sweep` · `pipe` · `loft` |
| Booleans | `boolean` (`fuse` / `cut` / `common`) |
| Transforms | `move` · `rotate` · `mirror` · `array` |
| Finishing | `shell` · `fillet` · `chamfer` |

### Tool Reference

| Capability | Headless | Live |
|---|---|---|
| Build | `run_cad_program` | `live_run_cad_program` |
| Document | `new_document` · `get_document_state` | `live_new_document` · `live_get_state` |
| Measure | `get_properties` | `live_get_properties` |
| Preview | `render_preview` | `live_render_preview` |
| Export STL | `export_stl` | `live_export_stl` |
| Export STEP | `export_step` | `live_export_step` |
| Save `.cd` | `save_cd` | `live_save_cd` |
