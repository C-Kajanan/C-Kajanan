# Revit MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server for Autodesk Revit. It lets Claude (or any MCP client) read and edit the Revit model you have open: query elements, read and set parameters, model walls, floors, levels, grids, rooms and families, make sheets, highlight elements, and take screenshots of views.

```
 Claude / MCP client ──stdio──▶ revit-mcp-server (Node) ──HTTP localhost:48884──▶ RevitMcp add-in (inside Revit)
```

There are two parts:

| Folder | What it is |
| --- | --- |
| [`addin/`](addin) | C# Revit add-in. It runs a small HTTP endpoint on `localhost` and executes requests on Revit's main thread through an `ExternalEvent`, which is the supported way to call the Revit API from outside. |
| [`server/`](server) | TypeScript MCP server. Your MCP client starts it over stdio. It defines the tools and forwards each call to the add-in. |

Supported Revit versions: **2023, 2024** (.NET Framework 4.8) and **2025, 2026** (.NET 8).

## Install

You need Windows with Revit, the [.NET 8 SDK](https://dotnet.microsoft.com/download) and [Node.js 18+](https://nodejs.org).

```powershell
git clone https://github.com/C-Kajanan/C-Kajanan.git
cd C-Kajanan/revit-mcp
./install.ps1 -RevitVersion 2025
```

The script builds the add-in, copies it to `%APPDATA%\Autodesk\Revit\Addins\<version>\`, builds the MCP server, and prints the config snippet for your MCP client.

<details>
<summary>Manual install</summary>

```powershell
cd addin
dotnet build -c Release -p:RevitVersion=2025
# copy bin\Release\2025\RevitMcp.addin  ->  %APPDATA%\Autodesk\Revit\Addins\2025\
# copy everything else in bin\Release\2025\  ->  %APPDATA%\Autodesk\Revit\Addins\2025\RevitMcp\

cd ..\server
npm install
npm run build
```
</details>

### Connect your MCP client

Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "revit": {
      "command": "node",
      "args": ["C:/path/to/C-Kajanan/revit-mcp/server/build/index.js"]
    }
  }
}
```

Claude Code:

```powershell
claude mcp add revit -- node C:/path/to/C-Kajanan/revit-mcp/server/build/index.js
```

Start Revit and open a model. The bridge starts with Revit. You can stop and restart it with **Add-Ins → Revit MCP → Start/Stop MCP**. Then ask Claude something like:

- "What's in this model? List the levels and count the doors per level."
- "Draw a 6 m × 4 m room on Level 1 with 200 mm walls, add a floor, and create a room named Office."
- "Find all walls with 'Exterior' in the type name and color them red in the current view."
- "Set the Mark of every selected door to D-01, D-02, …"
- "Show me a picture of the 3D view."

## Tools

All lengths are in **millimetres** and angles in **degrees**, whatever the project's display units are.

| Tool | Description |
| --- | --- |
| `ping` | Check the connection; returns the Revit version |
| `get_document_info` | Title, path, project info, units, active view, element counts |
| `list_levels` | Levels with elevations |
| `list_views` | Views and sheets, optionally by type |
| `get_active_view` | The view that is open now |
| `get_selection` | What the user has selected |
| `query_elements` | Find elements by category, view and parameter value |
| `get_element` | All details and parameters of one element |
| `list_family_types` | Loadable and system types you can place |
| `list_rooms` | Rooms with area, perimeter and volume |
| `export_view_image` | PNG render of a view, returned as an image |
| `set_parameter` | Set an instance or type parameter |
| `create_level` | New level, plus its floor plan |
| `create_grid` | New grid line |
| `create_wall` | One straight wall |
| `create_walls_from_polyline` | A chain or closed loop of walls |
| `create_floor` | Floor from a boundary |
| `place_family_instance` | Furniture, equipment, columns, and doors and windows hosted in walls |
| `create_room` | Room at a point inside walls |
| `move_elements` / `rotate_elements` / `copy_elements` | Transform elements |
| `delete_elements` | Delete elements |
| `select_elements` | Select in the UI and zoom to them |
| `color_elements` | Color overrides in a view, or reset them |
| `create_sheet` | Sheet with a title block, with views placed on it |

Each change runs in its own named transaction (`MCP: Create wall`, etc.), so **Ctrl+Z** in Revit undoes it. Revit warnings such as "walls overlap" are returned to the assistant and don't open a dialog.

## Configuration

Environment variables. Set them for Revit (add-in) and for the MCP server as noted.

| Variable | Used by | Default | Purpose |
| --- | --- | --- | --- |
| `REVIT_MCP_PORT` | both | `48884` | Port of the local bridge |
| `REVIT_MCP_TOKEN` | both | unset | If set, requests must carry this shared secret |
| `REVIT_MCP_AUTOSTART` | add-in | `1` | Set to `0` to start the bridge only from the ribbon |
| `REVIT_MCP_TIMEOUT_S` | add-in | `55` | How long a request waits for Revit to be idle |
| `REVIT_MCP_HOST` | server | `localhost` | Host of the bridge |
| `REVIT_MCP_TIMEOUT_MS` | server | `60000` | HTTP timeout |

## Security

The bridge listens on `localhost` only. It rejects requests that carry an `Origin` header and requests without `Content-Type: application/json`, so web pages in your browser can't drive Revit. Set `REVIT_MCP_TOKEN` if other users or processes on the machine shouldn't be able to reach it.

The assistant can change and delete elements in your model. Work on a copy or keep **Undo** in mind, and review what it plans to do in your MCP client before you approve tool calls.

## Troubleshooting

- **"Could not reach the RevitMcp add-in"**: Revit isn't running, the add-in didn't load (check **Add-Ins → External Tools**), or the bridge is stopped. Click **Start/Stop MCP**.
- **"Revit is busy"**: Revit only runs external requests when it's idle. Close open dialogs, finish the current command (press Esc), and try again. Nothing was changed.
- **Port already in use**: set `REVIT_MCP_PORT` to another port for both Revit and the MCP server.

## Development

```bash
cd server && npm install && npm test     # builds and runs the MCP tests against a mock add-in
cd addin && dotnet build -p:RevitVersion=2026
```

The add-in compiles on any OS against the [Nice3point.Revit.Api](https://github.com/Nice3point/RevitApi) reference packages. Running it needs Revit on Windows.

To add a tool, write a static method `object Name(CommandContext c)` with `[McpCommand("tool_name")]` in `addin/Commands/`, and add a matching entry to `server/src/tools.ts`.

## License

MIT
