# Revit MCP recipes

All values are in millimetres. Tool names are the `revit` MCP server's.

## A room from scratch

The user asks for "a 6 × 4 m office on Level 1 with a door on the south wall".

1. `list_levels` to confirm "Level 1" exists. `list_family_types` with `category: "Walls"`, then with `category: "Doors"`, to pick types.
2. Walls. Start at the origin, or next to existing work if the model has any:
   ```json
   create_walls_from_polyline { "points": [{"x":0,"y":0},{"x":6000,"y":0},{"x":6000,"y":4000},{"x":0,"y":4000}],
                                "closed": true, "levelName": "Level 1", "height": 3000 }
   ```
   The first wall id returned is the south wall, from (0,0) to (6000,0).
3. Floor: `create_floor` with the same four points and `levelName: "Level 1"`.
4. Door, centred on the south wall:
   ```json
   place_family_instance { "familyType": "Single-Flush: 0915 x 2134mm", "hostWallId": <south wall id>,
                           "location": {"x":3000,"y":0}, "levelName": "Level 1" }
   ```
5. Room: `create_room` with `point: {"x":3000,"y":2000}`, `name: "Office"`, and `number: "101"`. Check that `enclosed` is true.
6. `select_elements` with the new ids, then `export_view_image` to show the result.

## Renumber doors

The user asks to "number the doors on Level 1 D-101, D-102, … from west to east".

1. `query_elements` with `category: "Doors"`, `parameterName: "Level"` and `parameterValue: "Level 1"`. Each element's `location.point` gives its position.
2. Sort by `x`, then `y`, and show the user the proposed mapping (id → new Mark) if there are more than about 10 doors.
3. Call `set_parameter` for each door with `parameterName: "Mark"` and `value: "D-101"`, and so on.
4. Report how many were renumbered, plus any warnings. Duplicate Mark values are a common warning.

## Parameter audit

The user asks to "find walls with no Fire Rating".

1. Call `query_elements` with `category: "Walls"` and `includeParameters: true`. Walls usually carry Fire Rating as a type parameter, so also call `get_element` on one wall and look at `typeParameters`.
2. Group the walls by type, and report the types whose Fire Rating is empty, with instance counts.
3. Offer to fill them in. Use `set_parameter` with `onType: true` on one instance per type, and say that it changes every wall of that type.
4. Optional: `color_elements` on the offending walls in the active view, so the user can see them.

## Color-code by type

1. `query_elements` with `category: "Walls"`, and group the elements by `summary.type`.
2. Give each group a distinct color, for example `{r:230,g:57,b:70}`, `{r:29,g:53,b:87}`, `{r:42,g:157,b:143}` or `{r:244,g:162,b:97}`, and call `color_elements` once per group.
3. Tell the user which color means which type. To clear the colors later, call `color_elements` with the same ids and `reset: true`.

## Sheet set for every floor plan

1. `list_views` with `viewType: "FloorPlan"`.
2. For each plan, call `create_sheet` with `number: "A10" + n`, `name: <level name> + " Plan"` and `viewIds: [<plan id>]`.
3. Report the sheets you created. Any entries in `skipped` are views that are already on a sheet.

## Model summary for a meeting

1. Call `get_document_info`, `list_levels` and `list_rooms`.
2. Summarize: the project, the levels and their elevations, element counts, total room area per level, and any unenclosed rooms (`enclosed: false`), which need fixing.
3. Include `export_view_image` of the default 3D view (find it with `list_views` and `viewType: "ThreeD"`).
