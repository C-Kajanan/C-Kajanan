---
name: autocad
description: Read and edit the drawing open in Autodesk AutoCAD on this computer. Lists layers, blocks and layouts; finds entities by type, layer, text or area; draws lines, polylines, circles, arcs, text, hatches and dimensions; inserts and creates blocks; moves, copies, rotates, scales, mirrors, offsets and erases entities; manages layers; opens and saves DWG/DXF; captures the view as an image. Use whenever the user asks about or wants to change an AutoCAD drawing, DWG, layers, blocks or CAD geometry in a running AutoCAD.
---

# AutoCAD

You drive the AutoCAD session on this machine through the **AutoCadMcp plug-in**, which runs inside AutoCAD and listens on `http://localhost:48885/`. Every operation is one call of the bundled script:

```bash
node scripts/acad.mjs <tool> '<json params>'
```

`scripts/` is relative to this skill's folder. The script prints the JSON result, or an error on stderr with a non-zero exit code. All tools and their parameters are in [reference.md](reference.md); read it before calling a tool you haven't used yet in this conversation.

If the `autocad` MCP server is connected in this session, its tools have the same names and parameters, so you can call them directly instead of the script.

## Before you start

1. `node scripts/acad.mjs ping`. If it can't connect, tell the user to open AutoCAD and type `MCPSTART` (or `MCPSTATUS`). If AutoCAD doesn't know those commands, the plug-in isn't installed: point them to `install.ps1` in the autocad-mcp folder of https://github.com/C-Kajanan/C-Kajanan.
2. `node scripts/acad.mjs get_drawing_info` to learn the drawing's **insertion units** (e.g. `Millimeters`, `Inches`), extents and current layer. All coordinates are in drawing units, so convert what the user says ("a 6 m wall") into those units.

## How the drawing is addressed

- **Points** are `{"x":..,"y":..,"z":..}` in WCS drawing units; `z` defaults to 0.
- **Angles** are degrees, counter-clockwise from +X.
- **Entities** are identified by their **handle**, a hex string like `"2A3F"`. Draw tools return the new entity's handle; `query_entities` returns handles of existing ones. Handles survive save and reopen.
- **Colors**: ACI index (1 red, 2 yellow, 3 green, 4 cyan, 5 blue, 6 magenta, 7 white/black), a name, `"ByLayer"`, `"#RRGGBB"` or `"r,g,b"`.
- Draw tools accept optional `layer` (created if missing), `color` and `linetype` (load non-standard linetypes first with `load_linetype`).

## Working pattern

1. **Look before you change.** Use `list_layers`, `list_blocks`, `query_entities` (filter by `types`, `layer` with `*` wildcards, `textContains`, `window`) and `get_entity` to understand what's there. `query_entities` returns `matched` and `truncated`; narrow the filter or raise `limit` when truncated.
2. **Make the change** with the most specific tool. Put new geometry on a sensible layer instead of layer 0.
3. **Check the result.** `zoom` to the area, then `export_view_image --out <path>.png` and view the image file to confirm it looks right. Fix anything off before reporting back.
4. **Report** what changed, with handles, and remind the user they can step back with `U` in AutoCAD.

For long parameter lists (many polyline points, many handles), write the JSON to a file and pass `--file params.json` instead of quoting it on the command line. On Windows PowerShell, single-quoted JSON can lose its inner quotes, so prefer `--file`.

## Examples

```bash
node scripts/acad.mjs query_entities '{"types":["TEXT","MTEXT"],"textContains":"TBD"}'
node scripts/acad.mjs draw_rectangle '{"corner1":{"x":0,"y":0},"corner2":{"x":6000,"y":4000},"layer":"A-WALL"}'
node scripts/acad.mjs offset_entity '{"handle":"2A3F","distance":-200}'
node scripts/acad.mjs draw_hatch '{"boundaryHandles":["2A3F","2A40"],"pattern":"ANSI31","scale":10,"layer":"A-WALL-PATT"}'
node scripts/acad.mjs add_dimension '{"kind":"linear","point1":{"x":0,"y":0},"point2":{"x":6000,"y":0},"dimLinePoint":{"x":0,"y":-800}}'
node scripts/acad.mjs insert_block '{"name":"DOOR","position":{"x":1200,"y":0},"rotation":90,"attributes":{"TAG":"D-01"}}'
node scripts/acad.mjs set_layer '{"name":"X-REF","frozen":true}'
node scripts/acad.mjs zoom '{}'
node scripts/acad.mjs export_view_image '{"width":1600,"height":1000}' --out view.png
```

## Safety

- `erase_entities` and `run_command` are destructive. The script refuses them without `--confirm`. Say exactly what you're about to erase or run, get the user's OK, then re-run with `--confirm`.
- `save_drawing` without `path` overwrites the drawing file. Only save when the user asks. To keep the original, save a copy with a `path`.
- `run_command` sends raw AutoCAD command-line input and runs **after** the call returns. Use it only for what the other tools can't do, prefix commands with `_.` (e.g. `_.PURGE _A * _N`), and check the effect with a follow-up query.
- Entities on locked layers can't be changed; unlock with `set_layer` (`"locked": false`) only if the user agrees.

## Errors

| Error | What to do |
| --- | --- |
| Could not reach the AutoCadMcp plug-in | AutoCAD closed, plug-in not loaded, or bridge stopped. Ask the user to type `MCPSTART`. |
| AutoCAD is busy | A command or dialog is active. Ask the user to press Esc, then retry. Nothing was changed. |
| No drawing is open | `open_drawing` or `new_drawing` first. |
| No entity with handle … | The entity was erased or the handle is from another drawing. Query again. |
| …locked layer | See Safety above. |

Set `AUTOCAD_MCP_PORT` / `AUTOCAD_MCP_TOKEN` in the environment if the user configured a different port or a token for the plug-in.
