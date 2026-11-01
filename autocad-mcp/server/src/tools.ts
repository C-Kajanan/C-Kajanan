import { z } from "zod";

// Every tool maps 1:1 to a method of the same name in the AutoCAD plug-in
// (see plugin/Commands). Coordinates are WCS in drawing units, angles are
// degrees, and entities are identified by their handle (a hex string such
// as "2A3F"), which stays the same when the drawing is saved and reopened.

const point = z
  .object({ x: z.number(), y: z.number(), z: z.number().default(0) })
  .describe("WCS point in drawing units");
const handle = z.string().regex(/^[0-9A-Fa-f]+$/).describe("Entity handle, e.g. '2A3F'");
const handles = z.array(handle).min(1).describe("Entity handles");
const color = z
  .union([z.number().int().min(0).max(256), z.string()])
  .describe("ACI index 1-255, a name (red, yellow, green, cyan, blue, magenta, white), 'ByLayer', 'ByBlock', '#RRGGBB' or 'r,g,b'");

/** Properties every draw tool accepts. */
const style = {
  layer: z.string().optional().describe("Layer name (created if missing). Defaults to the current layer."),
  color: color.optional(),
  linetype: z.string().optional().describe("Linetype name, e.g. DASHED. Must be loaded in the drawing."),
};

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
  // ---------------------------------------------------------------- query
  {
    name: "ping",
    title: "Ping AutoCAD",
    description: "Check that AutoCAD and the AutoCadMcp plug-in are reachable. Returns the AutoCAD version and the active drawing.",
    input: {},
    readOnly: true,
  },
  {
    name: "list_drawings",
    title: "List open drawings",
    description: "Drawings open in AutoCAD, with name, path, whether each is active, read-only or has unsaved changes.",
    input: {},
    readOnly: true,
  },
  {
    name: "get_drawing_info",
    title: "Get drawing info",
    description:
      "Summary of the active drawing: name, path, insertion units, extents, current layer/layout/space, layer and block counts, and entity counts per type in model space.",
    input: {},
    readOnly: true,
  },
  {
    name: "list_layers",
    title: "List layers",
    description: "Layers with on/frozen/locked state, color, linetype, lineweight, plot flag and how many model-space entities each holds.",
    input: {},
    readOnly: true,
  },
  {
    name: "list_blocks",
    title: "List blocks",
    description: "Block definitions (excluding layouts and anonymous blocks) with entity count, attribute tags, insert count and whether they are xrefs.",
    input: { nameContains: z.string().optional() },
    readOnly: true,
  },
  {
    name: "list_layouts",
    title: "List layouts",
    description: "Model and paper-space layouts in tab order, with the current one marked.",
    input: {},
    readOnly: true,
  },
  {
    name: "list_styles",
    title: "List styles",
    description: "Text styles, dimension styles and loaded linetypes, with the current ones marked.",
    input: {},
    readOnly: true,
  },
  {
    name: "query_entities",
    title: "Query entities",
    description:
      "Find entities in model space (or a layout) by DXF type (LINE, LWPOLYLINE, CIRCLE, ARC, TEXT, MTEXT, INSERT, HATCH, DIMENSION...), layer, block name, text content and/or a bounding window. Returns geometry summaries.",
    input: {
      types: z.array(z.string()).optional().describe("DXF type names, e.g. ['LINE','LWPOLYLINE']"),
      layer: z.string().optional().describe("Layer name (exact, case-insensitive; * and ? wildcards allowed)"),
      blockName: z.string().optional().describe("Only block references (INSERT) of this block"),
      textContains: z.string().optional().describe("Only TEXT/MTEXT/attributes containing this text (case-insensitive)"),
      window: z.object({ min: point, max: point }).optional().describe("Only entities whose extents overlap this box"),
      space: z.string().default("model").describe("'model', 'current', or a paper-space layout name"),
      includeDetails: z.boolean().default(false).describe("Include full geometry (vertices, attributes, etc.)"),
      limit: z.number().int().min(1).max(10000).default(500),
    },
    readOnly: true,
  },
  {
    name: "get_entity",
    title: "Get entity",
    description: "Full details of one entity: type, layer, color, linetype, extents and type-specific geometry (vertices, length, area, text, attributes, ...).",
    input: { handle },
    readOnly: true,
  },
  {
    name: "get_selection",
    title: "Get selection",
    description: "Entities the user currently has selected (grip-selected) in AutoCAD.",
    input: { includeDetails: z.boolean().default(false) },
    readOnly: true,
  },
  {
    name: "export_view_image",
    title: "Export view image",
    description: "Capture the current AutoCAD view as a PNG so you can see the drawing. Use zoom first to frame what you want to look at. Returns an image.",
    input: {
      width: z.number().int().min(128).max(4096).default(1600),
      height: z.number().int().min(128).max(4096).default(1000),
    },
    readOnly: true,
    image: true,
  },

  // ----------------------------------------------------------------- draw
  {
    name: "draw_line",
    title: "Draw line",
    description: "Draw a line between two points in the current space.",
    input: { start: point, end: point, ...style },
  },
  {
    name: "draw_polyline",
    title: "Draw polyline",
    description:
      "Draw a 2D polyline (LWPOLYLINE) through points. Set closed=true for outlines. Optional bulges (one per vertex, tan(angle/4)) make arc segments.",
    input: {
      points: z.array(point).min(2),
      closed: z.boolean().default(false),
      bulges: z.array(z.number()).optional(),
      width: z.number().min(0).default(0).describe("Constant width"),
      ...style,
    },
  },
  {
    name: "draw_rectangle",
    title: "Draw rectangle",
    description: "Draw a closed rectangular polyline from two opposite corners.",
    input: { corner1: point, corner2: point, ...style },
  },
  {
    name: "draw_circle",
    title: "Draw circle",
    description: "Draw a circle.",
    input: { center: point, radius: z.number().positive(), ...style },
  },
  {
    name: "draw_arc",
    title: "Draw arc",
    description: "Draw an arc counter-clockwise from startAngle to endAngle (degrees, 0 = +X).",
    input: { center: point, radius: z.number().positive(), startAngle: z.number(), endAngle: z.number(), ...style },
  },
  {
    name: "draw_text",
    title: "Draw text",
    description: "Place single-line TEXT. Use draw_mtext for multi-line text.",
    input: {
      position: point,
      text: z.string().min(1),
      height: z.number().positive().default(2.5),
      rotation: z.number().default(0),
      justify: z
        .enum(["Left", "Center", "Right", "Middle", "TopLeft", "TopCenter", "TopRight", "MiddleLeft", "MiddleCenter", "MiddleRight", "BottomLeft", "BottomCenter", "BottomRight"])
        .default("Left"),
      textStyle: z.string().optional(),
      ...style,
    },
  },
  {
    name: "draw_mtext",
    title: "Draw multiline text",
    description: "Place MTEXT. Use \\P in the text for a new paragraph, or real line breaks.",
    input: {
      position: point.describe("Top-left insertion point"),
      text: z.string().min(1),
      height: z.number().positive().default(2.5),
      width: z.number().min(0).default(0).describe("Column width; 0 = no wrapping"),
      rotation: z.number().default(0),
      textStyle: z.string().optional(),
      ...style,
    },
  },
  {
    name: "draw_hatch",
    title: "Draw hatch",
    description: "Fill a closed area with a hatch pattern (SOLID, ANSI31, AR-CONC, ...). The boundary is either closed entities (by handle) or a list of points.",
    input: {
      boundaryHandles: z.array(handle).optional().describe("Closed polylines, circles, etc. The first is the outer boundary, the rest are islands (holes)"),
      points: z.array(point).min(3).optional().describe("Boundary points, used when boundaryHandles is omitted"),
      pattern: z.string().default("SOLID"),
      scale: z.number().positive().default(1),
      angle: z.number().default(0),
      ...style,
    },
  },
  {
    name: "add_dimension",
    title: "Add dimension",
    description:
      "Add a dimension between two points. 'aligned' measures the true distance; 'linear' measures along a direction given by rotation (0 = horizontal, 90 = vertical). dimLinePoint places the dimension line.",
    input: {
      kind: z.enum(["aligned", "linear"]).default("aligned"),
      point1: point,
      point2: point,
      dimLinePoint: point,
      rotation: z.number().default(0).describe("For linear dimensions"),
      textOverride: z.string().optional().describe("Replace the measured text; use <> to include the measurement"),
      dimStyle: z.string().optional(),
      ...style,
    },
  },
  {
    name: "insert_block",
    title: "Insert block",
    description:
      "Insert a block reference. The block must exist in the drawing, or give sourceFile (a .dwg path) to import it first: if the file contains a block with that name it is copied, otherwise the whole file is inserted as a block.",
    input: {
      name: z.string(),
      position: point,
      scale: z.number().default(1),
      rotation: z.number().default(0),
      attributes: z.record(z.string(), z.string()).optional().describe("Attribute values by tag"),
      sourceFile: z.string().optional(),
      ...style,
    },
  },
  {
    name: "create_block",
    title: "Create block",
    description: "Define a new block from existing entities around a base point. By default the originals are replaced with a reference to the new block.",
    input: {
      name: z.string(),
      handles,
      basePoint: point,
      keepOriginals: z.boolean().default(false).describe("Leave the source entities as they are instead of replacing them"),
    },
  },

  // ----------------------------------------------------------------- edit
  {
    name: "set_entity_properties",
    title: "Set entity properties",
    description: "Change layer, color, linetype, linetype scale or lineweight of entities. For TEXT/MTEXT, 'text' replaces the content.",
    input: {
      handles,
      layer: z.string().optional(),
      color: color.optional(),
      linetype: z.string().optional(),
      linetypeScale: z.number().positive().optional(),
      lineweight: z.number().int().optional().describe("Hundredths of a mm (e.g. 25 = 0.25 mm), -1 ByLayer, -2 ByBlock, -3 Default"),
      text: z.string().optional(),
    },
  },
  {
    name: "set_block_attributes",
    title: "Set block attributes",
    description: "Set attribute values on a block reference by tag.",
    input: { handle, attributes: z.record(z.string(), z.string()) },
  },
  {
    name: "move_entities",
    title: "Move entities",
    description: "Move entities by a displacement vector.",
    input: { handles, displacement: point },
  },
  {
    name: "copy_entities",
    title: "Copy entities",
    description: "Copy entities by a displacement. With count > 1 the copies form a linear array (displacement, 2×displacement, ...). Returns the new handles.",
    input: { handles, displacement: point, count: z.number().int().min(1).max(1000).default(1) },
  },
  {
    name: "rotate_entities",
    title: "Rotate entities",
    description: "Rotate entities about a base point in the XY plane (degrees, counter-clockwise).",
    input: { handles, basePoint: point, angle: z.number() },
  },
  {
    name: "scale_entities",
    title: "Scale entities",
    description: "Scale entities uniformly about a base point.",
    input: { handles, basePoint: point, factor: z.number().positive() },
  },
  {
    name: "mirror_entities",
    title: "Mirror entities",
    description: "Mirror entities about the line through two points. Set keepOriginals=false to mirror in place.",
    input: { handles, point1: point, point2: point, keepOriginals: z.boolean().default(true) },
  },
  {
    name: "offset_entity",
    title: "Offset entity",
    description: "Offset a curve (line, arc, circle, polyline) by a distance. Positive and negative distances go to opposite sides. Returns the new handles.",
    input: { handle, distance: z.number().refine((d) => d !== 0, "distance must not be 0") },
  },
  {
    name: "erase_entities",
    title: "Erase entities",
    description: "Delete entities from the drawing.",
    input: { handles },
    destructive: true,
  },
  {
    name: "create_layer",
    title: "Create layer",
    description: "Create a layer (or update it if it exists) and optionally make it current.",
    input: {
      name: z.string(),
      color: color.optional(),
      linetype: z.string().optional(),
      lineweight: z.number().int().optional().describe("Hundredths of a mm, e.g. 35"),
      description: z.string().optional(),
      plottable: z.boolean().optional(),
      makeCurrent: z.boolean().default(false),
    },
  },
  {
    name: "set_layer",
    title: "Set layer state",
    description: "Turn a layer on/off, freeze/thaw, lock/unlock, change its color, rename it, or make it current.",
    input: {
      name: z.string(),
      on: z.boolean().optional(),
      frozen: z.boolean().optional(),
      locked: z.boolean().optional(),
      color: color.optional(),
      newName: z.string().optional(),
      makeCurrent: z.boolean().optional(),
    },
  },
  {
    name: "load_linetype",
    title: "Load linetype",
    description: "Load a linetype (e.g. DASHED, CENTER, HIDDEN) from acad.lin / acadiso.lin or a given .lin file.",
    input: { name: z.string(), file: z.string().optional() },
  },
  {
    name: "select_entities",
    title: "Select entities",
    description: "Grip-select entities in AutoCAD so the user can see them, and optionally zoom to them.",
    input: { handles, zoom: z.boolean().default(true) },
    readOnly: true,
  },
  {
    name: "zoom",
    title: "Zoom",
    description: "Zoom the current view to the drawing extents (default), to a window, or to entities.",
    input: {
      window: z.object({ min: point, max: point }).optional(),
      handles: z.array(handle).optional(),
      margin: z.number().min(0).max(1).default(0.05).describe("Extra space around the target, as a fraction"),
    },
    readOnly: true,
  },

  // ------------------------------------------------------------- document
  {
    name: "open_drawing",
    title: "Open drawing",
    description: "Open a .dwg/.dxf file in AutoCAD and make it the active drawing.",
    input: { path: z.string(), readOnly: z.boolean().default(false) },
  },
  {
    name: "new_drawing",
    title: "New drawing",
    description: "Create a new drawing from a template (default acadiso.dwt or acad.dwt) and make it active.",
    input: { template: z.string().optional() },
  },
  {
    name: "save_drawing",
    title: "Save drawing",
    description:
      "Save the active drawing. Without path it saves in place (fails for unnamed drawings). With path it writes a copy; format 'dxf' writes DXF.",
    input: { path: z.string().optional(), format: z.enum(["dwg", "dxf"]).default("dwg") },
  },
  {
    name: "run_command",
    title: "Run AutoCAD command",
    description:
      "Send a command line to AutoCAD exactly as typed, e.g. '_.PURGE _A * _N' or '_.UNDO 1'. It runs asynchronously after this call returns, so check the result with another tool. Use for anything the other tools don't cover.",
    input: { command: z.string().min(1) },
    destructive: true,
  },
];
