import { z } from "zod";

// Every tool maps 1:1 to a method of the same name in the Revit add-in
// (see addin/Commands). Lengths are millimetres, angles are degrees.

const point2d = z.object({ x: z.number(), y: z.number() }).describe("Plan point in millimetres");
const point3d = z
  .object({ x: z.number(), y: z.number(), z: z.number().default(0) })
  .describe("Model point in millimetres");
const elementIds = z.array(z.number().int()).min(1).describe("Revit element ids");

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  input: z.ZodRawShape;
  readOnly?: boolean;
  destructive?: boolean;
  /** Result is { mimeType, base64 } and should be returned as image content. */
  image?: boolean;
}

export const tools: ToolDef[] = [
  {
    name: "ping",
    title: "Ping Revit",
    description: "Check that Revit and the RevitMcp add-in are reachable. Returns the Revit version and whether a document is open.",
    input: {},
    readOnly: true,
  },
  {
    name: "get_document_info",
    title: "Get document info",
    description: "Summary of the active Revit document: title, path, project info, units, phase, active view and element counts per major category.",
    input: {},
    readOnly: true,
  },
  {
    name: "list_levels",
    title: "List levels",
    description: "All levels in the model with id, name and elevation (mm), sorted by elevation.",
    input: {},
    readOnly: true,
  },
  {
    name: "list_views",
    title: "List views",
    description: "Views and sheets in the model (non-template). Optionally filter by view type, e.g. FloorPlan, Section, ThreeD, Sheet, Schedule.",
    input: {
      viewType: z.string().optional().describe("Revit ViewType name to filter by"),
    },
    readOnly: true,
  },
  {
    name: "get_active_view",
    title: "Get active view",
    description: "Name, id, type, scale and associated level of the view currently open in Revit.",
    input: {},
    readOnly: true,
  },
  {
    name: "get_selection",
    title: "Get selection",
    description: "Elements the user currently has selected in Revit, with id, category, family, type and name.",
    input: {},
    readOnly: true,
  },
  {
    name: "query_elements",
    title: "Query elements",
    description:
      "Find elements by category (BuiltInCategory like OST_Walls or a display name like 'Doors'), optionally limited to a view, filtered by a parameter value, and with parameters included.",
    input: {
      category: z.string().describe("e.g. OST_Walls, Walls, Doors, OST_Rooms"),
      viewId: z.number().int().optional().describe("Only elements visible in this view"),
      parameterName: z.string().optional().describe("Filter: parameter name to compare"),
      parameterValue: z.string().optional().describe("Filter: value (case-insensitive substring match on the displayed value)"),
      includeParameters: z.boolean().default(false).describe("Include every instance parameter of each element"),
      limit: z.number().int().min(1).max(5000).default(200),
    },
    readOnly: true,
  },
  {
    name: "get_element",
    title: "Get element",
    description: "Full details for one element: category, family/type, level, location (mm), bounding box and all instance and type parameters.",
    input: { id: z.number().int() },
    readOnly: true,
  },
  {
    name: "list_family_types",
    title: "List family types",
    description: "Loadable family types (FamilySymbol) and system types (wall, floor, roof types) available to place. Filter by category.",
    input: {
      category: z.string().optional().describe("e.g. OST_Doors, Furniture, Walls"),
      nameContains: z.string().optional(),
      limit: z.number().int().min(1).max(2000).default(300),
    },
    readOnly: true,
  },
  {
    name: "list_rooms",
    title: "List rooms",
    description: "Placed rooms with number, name, level, area (m²), perimeter (mm) and volume (m³).",
    input: { levelName: z.string().optional() },
    readOnly: true,
  },
  {
    name: "export_view_image",
    title: "Export view image",
    description: "Render a view (default: active view) to a PNG so you can see the model. Returns an image.",
    input: {
      viewId: z.number().int().optional(),
      pixelWidth: z.number().int().min(256).max(4096).default(1600),
    },
    readOnly: true,
    image: true,
  },
  {
    name: "set_parameter",
    title: "Set parameter",
    description:
      "Set a parameter on an element. String values are parsed in the project's display units (e.g. '3000' for a length in a mm project, '3 m', or text). Numbers set the raw value in Revit internal units (feet, radians).",
    input: {
      id: z.number().int(),
      parameterName: z.string(),
      value: z.union([z.string(), z.number(), z.boolean()]),
      onType: z.boolean().default(false).describe("Set the parameter on the element's type instead of the instance"),
    },
  },
  {
    name: "create_level",
    title: "Create level",
    description: "Create a level at an elevation (mm) and optionally create a matching floor plan view.",
    input: {
      elevation: z.number(),
      name: z.string().optional(),
      createPlanView: z.boolean().default(true),
    },
  },
  {
    name: "create_grid",
    title: "Create grid",
    description: "Create a straight grid line between two plan points (mm).",
    input: { start: point2d, end: point2d, name: z.string().optional() },
  },
  {
    name: "create_wall",
    title: "Create wall",
    description: "Create a straight wall between two plan points (mm) on a level. Uses the default wall type if wallType is omitted.",
    input: {
      start: point2d,
      end: point2d,
      levelName: z.string().optional().describe("Defaults to the lowest level"),
      height: z.number().default(3000).describe("Unconnected height in mm"),
      wallType: z.string().optional().describe("Wall type name"),
      offset: z.number().default(0).describe("Base offset in mm"),
      structural: z.boolean().default(false),
    },
  },
  {
    name: "create_walls_from_polyline",
    title: "Create walls from polyline",
    description: "Create a chain of walls through a list of plan points (mm). Set closed=true to close the loop, e.g. for a room outline.",
    input: {
      points: z.array(point2d).min(2),
      closed: z.boolean().default(true),
      levelName: z.string().optional(),
      height: z.number().default(3000),
      wallType: z.string().optional(),
    },
  },
  {
    name: "create_floor",
    title: "Create floor",
    description: "Create a floor from a closed boundary of plan points (mm) on a level.",
    input: {
      points: z.array(point2d).min(3),
      levelName: z.string().optional(),
      floorType: z.string().optional(),
      offset: z.number().default(0).describe("Height offset from level in mm"),
    },
  },
  {
    name: "place_family_instance",
    title: "Place family instance",
    description:
      "Place a family instance (furniture, equipment, columns, doors/windows in a host wall, etc.). For doors and windows, pass hostWallId and a point on that wall.",
    input: {
      familyType: z.string().describe("'Family Name: Type Name' or just a type name"),
      location: point3d,
      levelName: z.string().optional(),
      rotation: z.number().default(0).describe("Rotation about Z in degrees"),
      hostWallId: z.number().int().optional(),
    },
  },
  {
    name: "create_room",
    title: "Create room",
    description: "Place a room at a plan point (mm) inside bounding walls on a level, with optional name and number.",
    input: {
      point: point2d,
      levelName: z.string().optional(),
      name: z.string().optional(),
      number: z.string().optional(),
    },
  },
  {
    name: "move_elements",
    title: "Move elements",
    description: "Translate elements by a vector in mm.",
    input: { ids: elementIds, vector: point3d },
  },
  {
    name: "rotate_elements",
    title: "Rotate elements",
    description: "Rotate elements about a vertical axis through a plan point (mm) by an angle in degrees.",
    input: { ids: elementIds, center: point2d, angle: z.number() },
  },
  {
    name: "copy_elements",
    title: "Copy elements",
    description: "Copy elements offset by a vector in mm. Returns the new element ids.",
    input: { ids: elementIds, vector: point3d },
  },
  {
    name: "delete_elements",
    title: "Delete elements",
    description: "Delete elements (and anything that depends on them). Returns all ids that were removed.",
    input: { ids: elementIds },
    destructive: true,
  },
  {
    name: "select_elements",
    title: "Select elements",
    description: "Set the selection in the Revit UI and optionally zoom the active view to it.",
    input: { ids: z.array(z.number().int()), zoom: z.boolean().default(true) },
  },
  {
    name: "color_elements",
    title: "Color elements",
    description: "Override element colors in a view (default: active view) to highlight them. Pass reset=true to clear overrides.",
    input: {
      ids: elementIds,
      color: z.object({ r: z.number().int().min(0).max(255), g: z.number().int().min(0).max(255), b: z.number().int().min(0).max(255) }).default({ r: 255, g: 0, b: 0 }),
      viewId: z.number().int().optional(),
      reset: z.boolean().default(false),
    },
  },
  {
    name: "create_sheet",
    title: "Create sheet",
    description: "Create a sheet with a title block and optionally place views on it.",
    input: {
      number: z.string(),
      name: z.string(),
      titleBlock: z.string().optional().describe("Title block type name; defaults to the first one loaded"),
      viewIds: z.array(z.number().int()).optional(),
    },
  },
];
