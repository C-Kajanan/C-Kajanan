# Revit MCP v__VERSION__

Lets Claude read and edit the Autodesk Revit model you have open. You can ask about elements, change parameters, model walls, floors, rooms and families, make sheets, and see views. Works with Revit 2023, 2024, 2025 and 2026.

## Quick install (Windows)

1. Install [Node.js 18 or later](https://nodejs.org) if you don't have it.
2. Extract this zip, then double-click **`Install.cmd`**. The installer:
   - installs the add-in for every Revit 2023–2026 version it finds
   - copies the MCP server to `%LOCALAPPDATA%\RevitMCP`
   - adds the `revit` server to Claude Desktop's config, keeping a `.bak` backup
3. Restart Revit and Claude Desktop, open a model, and ask Claude: **"ping Revit"**.

To install for specific versions only, run `Install.ps1 -RevitVersion 2024,2025`. To leave Claude Desktop's config alone, run `Install.ps1 -SkipClaudeDesktop`. **`Uninstall.cmd`** removes everything the installer added.

## What's in this zip

| Folder | Contents |
| --- | --- |
| `addin/Revit2023` … `addin/Revit2026` | The Revit add-in for each version: the `RevitMcp.addin` manifest and the `RevitMcp/` folder. To install by hand, copy both into `%APPDATA%\Autodesk\Revit\Addins\<version>\` |
| `revit-mcp-__VERSION__.mcpb` | One-click install for Claude Desktop: double-click it, or drag it into Settings → Extensions. You can set the port and token there. You still need the add-in, so run `Install.cmd -SkipClaudeDesktop` |
| `server/revit-mcp.mjs` | The MCP server as one file with no dependencies to install. Run it with `node revit-mcp.mjs` |
| `plugin/` | Claude Code plugin with the MCP server and the `revit` skill. Install it with `claude plugin marketplace add <path-to>/plugin` and then `claude plugin install revit@revit-mcp-local`, or from GitHub with `/plugin install revit --marketplace C-Kajanan/c-kajanan` |
| `skill/revit/` and `skill/revit-skill.zip` | The `revit` skill on its own, which teaches Claude to use the tools well (units, safe edits, recipes). Upload the zip in Claude under Settings → Capabilities → Skills, or copy the folder to `~/.claude/skills/` |
| `source/` | Full source code (C# add-in, TypeScript server, skill) to build or modify |
| `Install.cmd` / `Install.ps1`, `Uninstall.cmd` / `Uninstall.ps1` | Installer and uninstaller |

## Features

26 tools:

- **Read the model:**
  - `get_document_info`, `list_levels`, `list_views`, `get_active_view`, `get_selection`
  - `query_elements` (by category, by view, filtered by parameter value)
  - `get_element` (all parameters, location, host, bounding box)
  - `list_family_types`, `list_rooms` (area, perimeter, volume)
- **Edit data:** `set_parameter` (instance or type, in display units)
- **Model:** `create_level`, `create_grid`, `create_wall`, `create_walls_from_polyline`, `create_floor`, `create_room`, `place_family_instance` (including doors and windows in walls)
- **Change:** `move_elements`, `rotate_elements`, `copy_elements`, `delete_elements`
- **Show and document:** `select_elements` (selects and zooms), `color_elements` (color overrides), `export_view_image` (a PNG Claude can see), `create_sheet`
- `ping`

Every change is one undo step in Revit (Ctrl+Z). Revit warnings go back to Claude instead of opening dialogs. All lengths are in millimetres.

## Security

The add-in only listens on `localhost`, rejects requests from web pages, and accepts an optional shared secret: set the `REVIT_MCP_TOKEN` environment variable for both Revit and the MCP server. Claude can change and delete elements, so work on a copy of important models and review tool calls before you approve them.

## Troubleshooting

- **Can't reach the add-in:** Revit isn't open, or the bridge is stopped. Click Add-Ins → Revit MCP → Start/Stop MCP.
- **Revit is busy:** close open dialogs or press Esc, then try again.
- **The add-in doesn't load:** Windows may have blocked the files. Right-click the zip → Properties → Unblock, then extract it and install again.
- **Port 48884 is in use:** set `REVIT_MCP_PORT` to the same free port for Revit and for the server.

Source and issues: https://github.com/C-Kajanan/C-Kajanan/tree/main/revit-mcp. MIT license.
