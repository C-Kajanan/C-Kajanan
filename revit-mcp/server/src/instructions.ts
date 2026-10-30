// Sent to the client at initialize. A condensed version of skills/revit/SKILL.md,
// so clients without the skill (e.g. the .mcpb bundle) still get the guidance.
export const instructions = `Tools for the Autodesk Revit model the user has open. Every call runs inside their live model.

Units: all lengths are millimetres, angles degrees, areas m², volumes m³, whatever the project's display units are. Convert what the user says (feet, metres) before calling, and report back in their units. X/Y are plan coordinates from the project origin; Z is relative to the level passed as levelName.

Workflow:
1. Call ping first. If it fails, the user must open Revit with a model and start the bridge (Add-Ins > Revit MCP > Start/Stop MCP).
2. Orient before changing anything: get_document_info, list_levels, and get_selection when the user says "these" or "selected".
3. Look up exact names, never guess: list_levels for levelName, list_family_types for wallType/floorType, and its placeAs value for place_family_instance. Families must already be loaded in the project.
4. Before delete_elements, or edits to more than about 10 elements, tell the user what will change and wait for confirmation.
5. Batch work: use create_walls_from_polyline for outlines. Create walls before create_room (check enclosed: true). Place doors and windows with hostWallId and a point on that wall's line.
6. Verify: re-query, or export_view_image to see the result; select_elements zooms the user's view to it.

Write results may return { result, warnings }: tell the user about the warnings that matter. Each write is one undo step in Revit (Ctrl+Z). query_elements with includeParameters is large: use it only when you need values, and report totals for big result sets. set_parameter takes strings in display units; onType: true changes every instance of that type, so say so.

Errors: "Revit is busy" means close dialogs or press Esc, then retry once (nothing changed). "Unknown category", "No level named" and similar errors list the valid names; pick from those.`;
