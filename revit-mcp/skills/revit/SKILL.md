---
name: revit
description: Read, query and edit the Autodesk Revit model the user has open through the Revit MCP tools (ping, query_elements, create_wall, set_parameter, export_view_image, ...). Use when the user asks about or wants changes to their Revit/BIM model, such as counting or listing elements, auditing or bulk-editing parameters, drawing walls, floors, rooms, levels or grids, placing doors, windows or furniture, highlighting elements, making sheets, or showing a view. Triggers include "in Revit", "my model", "this project", "BIM", "Revit families", "walls on Level 1", "room areas", "door schedule", "renumber", "color the walls".
---

# Working with Revit through MCP

The `revit` MCP server drives a live Revit session through the RevitMcp add-in. Every tool call runs on Revit's main thread inside the user's open model. Changes are real, so work the way a careful BIM coordinator would.

## Ground rules

- **Units:** every length you send or receive is in **millimetres**, angles are in **degrees**, areas in m² and volumes in m³, whatever the project's display units are. Convert what the user says ("12 ft", "3.5 m") before calling a tool, and give results back in the user's units.
- **Coordinates:** X and Y are plan coordinates in mm from the project's internal origin. Z is measured from the level you pass (`levelName`). If you don't know where things are, read existing elements first (`query_elements` returns locations, `get_element` returns bounding boxes) and place new work relative to them.
- **Ids:** element ids are integers. Get them from tool results; never guess one.
- **Undo:** each write tool is one named transaction (`MCP: Create wall`, ...), so the user can press Ctrl+Z in Revit to undo it. Mention this after a batch of changes.
- **Warnings:** a write result may come back as `{ result, warnings }`. Read the warnings, such as overlapping walls or a room that isn't enclosed, and tell the user about the ones that matter.

## Workflow

1. **Connect.** Call `ping` first in a session. If it fails, follow *Troubleshooting* below before trying anything else.
2. **Orient.** Before you change anything, call `get_document_info` and `list_levels`. They give you the project name, units, active view and element counts. Use `get_selection` when the user says "these" or "the selected ...".
3. **Look up before you create.** Get exact type names from `list_family_types` (filter by `category`) and exact level names from `list_levels`. Use the `placeAs` value from `list_family_types` as `familyType` for `place_family_instance`. Don't invent type names: Revit only accepts types that are loaded in the project.
4. **Confirm before broad or destructive changes.** Before `delete_elements`, or before editing more than about 10 elements, tell the user what you will change (count, category, example ids) and wait for a yes. Small additive requests like "draw a wall here" don't need confirmation.
5. **Make the change**, batching sensibly. For example, use `create_walls_from_polyline` for an outline, not one `create_wall` call per side.
6. **Verify.** Re-query what you changed, or call `export_view_image` to see it. When you've placed or highlighted something, `select_elements` zooms the user's view to it.

## Choosing tools

| Goal | Tools |
| --- | --- |
| Count, list or find elements | `query_elements` with `category` (`OST_Walls`, `Doors`, `Rooms`, ...). Add `viewId` to limit it to what a view shows, `parameterName` + `parameterValue` to filter, and `includeParameters: true` only when you need the values (it makes results large) |
| Everything about one element | `get_element`: parameters, type parameters, location, host, bounding box |
| Room data | `list_rooms` gives area, perimeter, volume and placed/enclosed flags |
| Edit data | `set_parameter`. Send strings in display units (`"2100"`, `"Fire rated"`). Use `onType: true` to change a type parameter, which affects every instance of that type, so say so |
| Layout | `create_level`, `create_grid`, `create_wall`, `create_walls_from_polyline`, `create_floor`, `create_room`, `place_family_instance` |
| Doors and windows | `place_family_instance` with `hostWallId` and a `location` on that wall's line (take it from the wall's `location.start`/`end`) |
| Rearrange | `move_elements`, `rotate_elements`, `copy_elements` (returns the new ids) |
| Communicate visually | `color_elements` (call it again with `reset: true` to clear), `select_elements`, `export_view_image` |
| Documentation | `list_views`, `create_sheet` with `viewIds` (a view can only be placed on one sheet) |

[reference/recipes.md](reference/recipes.md) has worked examples: a room from scratch, a door renumbering pass, a parameter audit, color-coding by type, and a sheet set.

## Modeling tips

- **Rooms need enclosure.** Create the walls first, then call `create_room` with a point inside them. If the result says `enclosed: false`, the walls don't close the loop. Check the wall endpoints.
- **Floors:** pass the boundary in order (clockwise or counterclockwise) without repeating the first point. Usually it matches the wall outline.
- **Wall height** defaults to 3000 mm and is unconnected. Ask the user, or match the floor-to-floor height between levels.
- **Placement failures** like "No family type ... is loaded" mean the family isn't in the project. Tell the user to load it (Insert → Load Family). You can't load families yourself.
- **Large models:** keep the default `limit`. Report totals (`total` in the result), not every row, unless the user asks for the list.

## Troubleshooting

| Error says | What to do |
| --- | --- |
| "Could not reach the RevitMcp add-in" | Revit isn't open, the add-in isn't installed, or the bridge is stopped. Ask the user to open Revit with a model and click **Add-Ins → Revit MCP → Start/Stop MCP**. The install steps are in the repo README: https://github.com/C-Kajanan/C-Kajanan/tree/main/revit-mcp |
| "Revit is busy" | Revit runs requests only when it's idle. Ask the user to close dialogs or press Esc to end the current command, then retry once. Nothing was changed. |
| "No Revit document is open" | Ask the user to open a project. |
| "Unknown category" / "No level named" / "No ... named" | The error lists the valid names. Pick from them, or ask the user. |
| "rolled back" | Revit refused the change, for example because of an invalid geometry or a constraint. Explain the reason it gives and suggest a fix. |
