# AutoCAD MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server for Autodesk AutoCAD. It lets Claude (or any MCP client) read and edit the drawing you have open: list layers, blocks and layouts, find entities by type, layer, text or area, draw lines, polylines, circles, arcs, text, hatches and dimensions, insert and create blocks, move, copy, rotate, scale, mirror, offset and erase entities, manage layers, open and save drawings, and take a picture of the current view.

```
 Claude / MCP client ──stdio──▶ autocad-mcp-server (Node) ──HTTP localhost:48885──▶ AutoCadMcp plug-in (inside AutoCAD)
```

| Folder | What it is |
| --- | --- |
| [`plugin/`](plugin) | C# AutoCAD .NET plug-in. It runs a small HTTP endpoint on `localhost` and executes each request on AutoCAD's main thread, in the application context, with the document locked, and only while no command is running. |
| [`server/`](server) | TypeScript MCP server. Your MCP client starts it over stdio. It defines the tools and forwards each call to the plug-in. |
| [`skill/autocad/`](skill/autocad) | The same tools packaged as one [Agent Skill](https://code.claude.com/docs/en/skills) for Claude Code: instructions, a full tool reference and a dependency-free script that talks to the plug-in directly. Use it instead of, or alongside, the MCP server. |

Supported AutoCAD versions: **2021–2024** (.NET Framework 4.8) and **2025–2026** (.NET 8). AutoCAD-based products such as AutoCAD Architecture, Mechanical, MEP, Electrical, Map 3D and Civil 3D load it too. A build for **2027** (.NET 10) is set up but untested. AutoCAD LT has no .NET API and isn't supported.

## Install

You need Windows with AutoCAD, the [.NET SDK](https://dotnet.microsoft.com/download) (8, or 10 for AutoCAD 2027) and [Node.js 18+](https://nodejs.org).

```powershell
git clone https://github.com/C-Kajanan/C-Kajanan.git
cd C-Kajanan/autocad-mcp
./install.ps1 -AcadVersion 2025
```

The script builds the plug-in, installs it as an autoloader bundle in `%APPDATA%\Autodesk\ApplicationPlugins\AutoCadMcp.bundle`, builds the MCP server and prints the config snippet for your MCP client. Use `-AllUsers` (as administrator) to install to `%ProgramData%` instead, which AutoCAD trusts by default.

The first time AutoCAD starts after installing, it may ask whether to load `AutoCadMcp.dll`. Choose **Always Load**.

<details>
<summary>Manual install</summary>

```powershell
cd plugin
dotnet build -c Release -p:AcadVersion=2025
# create  %APPDATA%\Autodesk\ApplicationPlugins\AutoCadMcp.bundle\
# copy    PackageContents.xml        ->  AutoCadMcp.bundle\
# copy    bin\Release\R25\*          ->  AutoCadMcp.bundle\Contents\R25\
#         (R24 for AutoCAD 2021-2024, R25 for 2025-2026, R26 for 2027)

cd ..\server
npm install
npm run build
```

Or skip the bundle and load `bin\Release\R25\AutoCadMcp.dll` with the `NETLOAD` command each session.
</details>

### Connect your MCP client

Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "autocad": {
      "command": "node",
      "args": ["C:/path/to/C-Kajanan/autocad-mcp/server/build/index.js"]
    }
  }
}
```

Claude Code:

```powershell
claude mcp add autocad -- node C:/path/to/C-Kajanan/autocad-mcp/server/build/index.js
```

### Or use it as a skill

The [`skill/autocad`](skill/autocad) folder is a self-contained Claude Code skill. It needs the plug-in, but not the MCP server or any MCP config. Install it with the plug-in:

```powershell
./install.ps1 -AcadVersion 2025 -Skill
```

or copy `skill/autocad` to `%USERPROFILE%\.claude\skills\autocad` (all projects) or `<project>\.claude\skills\autocad` (one project). Claude Code loads it whenever you ask about the open AutoCAD drawing, and runs `node scripts/acad.mjs <tool> '<json>'` for each operation. The skill asks before erasing or running raw commands; its script refuses `erase_entities` and `run_command` without `--confirm`.

The skill has to run on the same computer as AutoCAD, because the plug-in only listens on `localhost`. That rules out claude.ai and other cloud sandboxes.

Start AutoCAD and open a drawing. The bridge starts with AutoCAD and prints `AutoCAD MCP: listening on http://localhost:48885/` on the command line. Type `MCPSTOP`, `MCPSTART` or `MCPSTATUS` to control it. Then ask Claude something like:

- "What's in this drawing? List the layers and how many entities are on each."
- "Draw a 6000 × 4000 room outline on layer A-WALL, offset it 200 inwards, and hatch the wall between the two lines with ANSI31."
- "Find every TEXT that says 'TBD' and change it to 'REV A'."
- "Insert the block DOOR at (1200, 0) rotated 90°, and set its TAG attribute to D-01."
- "Freeze all layers that start with X-, then show me a picture of the drawing."
- "Put dimensions along the bottom and left edges of the rectangle."

## Tools

Coordinates are WCS in **drawing units** (check `insertionUnits` in `get_drawing_info`), angles are **degrees** counter-clockwise from +X, and entities are identified by their **handle** (a hex string like `"2A3F"`), which stays the same when the drawing is saved and reopened. Every draw tool also accepts optional `layer` (created if missing), `color` and `linetype`.

| Tool | Description |
| --- | --- |
| `ping` | Check the connection; returns the AutoCAD version |
| `list_drawings` | Open drawings |
| `get_drawing_info` | Name, path, units, extents, current layer/layout, entity counts per type |
| `list_layers` | Layers with state, color, linetype, lineweight and entity counts |
| `list_blocks` | Block definitions with attribute tags and insert counts |
| `list_layouts` | Model and paper-space layouts |
| `list_styles` | Text styles, dimension styles and linetypes |
| `query_entities` | Find entities by type, layer (wildcards), block name, text and/or window |
| `get_entity` | Full details of one entity: geometry, length, area, text, attributes |
| `get_selection` | What the user has selected |
| `export_view_image` | PNG of the current view, returned as an image |
| `draw_line` / `draw_polyline` / `draw_rectangle` | Lines and 2D polylines (with optional arc bulges and width) |
| `draw_circle` / `draw_arc` | Circles and arcs |
| `draw_text` / `draw_mtext` | Single-line and multiline text |
| `draw_hatch` | Hatch inside closed entities or a point boundary |
| `add_dimension` | Aligned or linear (rotated) dimensions |
| `insert_block` | Insert a block with attribute values, importing it from a .dwg if needed |
| `create_block` | Make a block from existing entities |
| `set_entity_properties` | Layer, color, linetype, lineweight, text content |
| `set_block_attributes` | Attribute values of a block reference |
| `move_entities` / `copy_entities` / `rotate_entities` / `scale_entities` / `mirror_entities` | Transform entities (copy supports linear arrays) |
| `offset_entity` | Offset a line, arc, circle or polyline |
| `erase_entities` | Delete entities |
| `create_layer` / `set_layer` / `load_linetype` | Layer management |
| `select_entities` / `zoom` | Highlight entities and frame the view |
| `open_drawing` / `new_drawing` / `save_drawing` | Open, create, save, save a copy, export DXF |
| `run_command` | Send any command line to AutoCAD, for anything the other tools don't cover |

Changes are written straight to the drawing database. AutoCAD normally records them in its undo history, so `U` steps back, but save a copy before letting the assistant make large edits. `run_command` is queued and runs after the tool call returns, so the assistant checks its effect with a follow-up query.

## Configuration

Environment variables. Set them for AutoCAD (plug-in) and for the MCP server as noted.

| Variable | Used by | Default | Purpose |
| --- | --- | --- | --- |
| `AUTOCAD_MCP_PORT` | both | `48885` | Port of the local bridge |
| `AUTOCAD_MCP_TOKEN` | both | unset | If set, requests must carry this shared secret |
| `AUTOCAD_MCP_AUTOSTART` | plug-in | `1` | Set to `0` to start the bridge only with `MCPSTART` |
| `AUTOCAD_MCP_TIMEOUT_S` | plug-in | `55` | How long a request waits for AutoCAD to be idle |
| `AUTOCAD_MCP_HOST` | server | `localhost` | Host of the bridge |
| `AUTOCAD_MCP_TIMEOUT_MS` | server | `60000` | HTTP timeout |

The default port differs from the [Revit MCP](../revit-mcp) (48884), so both can run on the same machine.

## Security

The bridge listens on `localhost` only. It rejects requests that carry an `Origin` header and requests without `Content-Type: application/json`, so web pages in your browser can't drive AutoCAD. Set `AUTOCAD_MCP_TOKEN` if other users or processes on the machine shouldn't be able to reach it.

The assistant can change and erase entities, save over files and run arbitrary AutoCAD commands with `run_command`. Work on a copy, and review what it plans to do in your MCP client before you approve tool calls.

## Troubleshooting

- **"Could not reach the AutoCadMcp plug-in"**: AutoCAD isn't running, the plug-in didn't load (type `MCPSTATUS`; if the command is unknown, check the bundle folder or `NETLOAD` the DLL), or the bridge is stopped. Type `MCPSTART`.
- **"AutoCAD is busy"**: the plug-in only runs requests when no command is active. Press Esc, close open dialogs and try again. Nothing was changed.
- **"The entity is on a locked layer"**: unlock it with `set_layer` (`locked: false`).
- **Port already in use**: set `AUTOCAD_MCP_PORT` to another port for both AutoCAD and the MCP server.

## Development

```bash
cd server && npm install && npm test        # builds, checks the skill reference, runs MCP and skill tests against a mock plug-in
cd plugin && dotnet build -p:AcadVersion=2025
```

The plug-in compiles on any OS against Autodesk's [AutoCAD.NET](https://www.nuget.org/packages/AutoCAD.NET) reference packages. Running it needs AutoCAD on Windows.

To add a tool, write a static method `object Name(CommandContext c)` with `[McpCommand("tool_name")]` in `plugin/Commands/`, add a matching entry to `server/src/tools.ts`, and run `npm run gen-skill` in `server/` to regenerate the skill's `reference.md` and `scripts/tools.json`. `npm test` fails if they are out of date.

## License

MIT
