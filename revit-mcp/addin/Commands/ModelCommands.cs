using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using Newtonsoft.Json.Linq;

namespace RevitMcp.Commands
{
    /// <summary>Commands that add new elements to the model.</summary>
    internal static class ModelCommands
    {
        [McpCommand("create_level")]
        public static object CreateLevel(CommandContext c)
        {
            var doc = c.Doc;
            var elevation = c.Require<double>("elevation");
            var name = c.Get<string>("name");
            var createPlan = c.Get("createPlanView", true);

            return c.Write("Create level", () =>
            {
                var level = Level.Create(doc, Units.FromMm(elevation));
                if (!string.IsNullOrEmpty(name)) level.Name = name;

                long? planId = null;
                if (createPlan)
                {
                    var planType = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>()
                        .FirstOrDefault(t => t.ViewFamily == ViewFamily.FloorPlan);
                    if (planType != null) planId = Ids.Of(ViewPlan.Create(doc, planType.Id, level.Id).Id);
                }
                return new { id = Ids.Of(level.Id), name = level.Name, elevation, floorPlanViewId = planId };
            });
        }

        [McpCommand("create_grid")]
        public static object CreateGrid(CommandContext c)
        {
            var doc = c.Doc;
            var start = Units.Point(c.Require<JObject>("start"));
            var end = Units.Point(c.Require<JObject>("end"));
            var name = c.Get<string>("name");

            return c.Write("Create grid", () =>
            {
                var grid = Grid.Create(doc, Line.CreateBound(start, end));
                if (!string.IsNullOrEmpty(name)) grid.Name = name;
                return new { id = Ids.Of(grid.Id), name = grid.Name };
            });
        }

        [McpCommand("create_wall")]
        public static object CreateWall(CommandContext c)
        {
            var doc = c.Doc;
            var level = Lookup.Level(doc, c.Get<string>("levelName"));
            var wallType = Lookup.Type<WallType>(doc, c.Get<string>("wallType"), ElementTypeGroup.WallType);
            var start = Units.Point(c.Require<JObject>("start"), level.Elevation);
            var end = Units.Point(c.Require<JObject>("end"), level.Elevation);
            var height = Units.FromMm(c.Get("height", 3000.0));
            var offset = Units.FromMm(c.Get("offset", 0.0));
            var structural = c.Get("structural", false);

            return c.Write("Create wall", () =>
            {
                var wall = Wall.Create(doc, Line.CreateBound(start, end), wallType.Id, level.Id, height, offset, false, structural);
                return Describe.Element(wall);
            });
        }

        [McpCommand("create_walls_from_polyline")]
        public static object CreateWallsFromPolyline(CommandContext c)
        {
            var doc = c.Doc;
            var level = Lookup.Level(doc, c.Get<string>("levelName"));
            var wallType = Lookup.Type<WallType>(doc, c.Get<string>("wallType"), ElementTypeGroup.WallType);
            var points = c.Require<JArray>("points").Select(p => Units.Point(p, level.Elevation)).ToList();
            var height = Units.FromMm(c.Get("height", 3000.0));
            if (c.Get("closed", true) && points.Count > 2) points.Add(points[0]);

            return c.Write("Create walls", () =>
            {
                var ids = new List<long>();
                for (var i = 0; i < points.Count - 1; i++)
                {
                    if (points[i].IsAlmostEqualTo(points[i + 1])) continue;
                    var wall = Wall.Create(doc, Line.CreateBound(points[i], points[i + 1]), wallType.Id, level.Id, height, 0, false, false);
                    ids.Add(Ids.Of(wall.Id));
                }
                return new { wallIds = ids, wallType = wallType.Name, level = level.Name };
            });
        }

        [McpCommand("create_floor")]
        public static object CreateFloor(CommandContext c)
        {
            var doc = c.Doc;
            var level = Lookup.Level(doc, c.Get<string>("levelName"));
            var floorType = Lookup.Type<FloorType>(doc, c.Get<string>("floorType"), ElementTypeGroup.FloorType);
            var points = c.Require<JArray>("points").Select(p => Units.Point(p, level.Elevation)).ToList();
            var offset = c.Get("offset", 0.0);

            var loop = new CurveLoop();
            for (var i = 0; i < points.Count; i++)
                loop.Append(Line.CreateBound(points[i], points[(i + 1) % points.Count]));

            return c.Write("Create floor", () =>
            {
                var floor = Floor.Create(doc, new List<CurveLoop> { loop }, floorType.Id, level.Id);
                if (Math.Abs(offset) > 1e-9)
                    floor.get_Parameter(BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM)?.Set(Units.FromMm(offset));
                return Describe.Element(floor);
            });
        }

        [McpCommand("place_family_instance")]
        public static object PlaceFamilyInstance(CommandContext c)
        {
            var doc = c.Doc;
            var symbol = Lookup.Symbol(doc, c.Require<string>("familyType"));
            var level = Lookup.Level(doc, c.Get<string>("levelName"));
            var point = Units.Point(c.Require<JObject>("location"), level.Elevation);
            var rotation = c.Get("rotation", 0.0);
            var hostId = c.Get<long?>("hostWallId");

            var structuralType = symbol.Category?.Id == Category.GetCategory(doc, BuiltInCategory.OST_StructuralColumns)?.Id
                ? StructuralType.Column
                : StructuralType.NonStructural;

            return c.Write("Place family instance", () =>
            {
                if (!symbol.IsActive)
                {
                    symbol.Activate();
                    doc.Regenerate();
                }

                FamilyInstance instance;
                if (hostId.HasValue)
                {
                    var host = doc.GetElement(Ids.From(hostId.Value)) ?? throw new McpException($"Host element {hostId} does not exist.");
                    instance = doc.Create.NewFamilyInstance(point, symbol, host, level, structuralType);
                }
                else if (symbol.Family.FamilyPlacementType == FamilyPlacementType.OneLevelBased ||
                         symbol.Family.FamilyPlacementType == FamilyPlacementType.TwoLevelsBased)
                {
                    instance = doc.Create.NewFamilyInstance(point, symbol, level, structuralType);
                }
                else
                {
                    instance = doc.Create.NewFamilyInstance(point, symbol, structuralType);
                }

                if (Math.Abs(rotation) > 1e-9)
                {
                    var axis = Line.CreateBound(point, point + XYZ.BasisZ);
                    ElementTransformUtils.RotateElement(doc, instance.Id, axis, Units.Radians(rotation));
                }
                return Describe.Element(instance);
            });
        }

        [McpCommand("create_room")]
        public static object CreateRoom(CommandContext c)
        {
            var doc = c.Doc;
            var level = Lookup.Level(doc, c.Get<string>("levelName"));
            var p = c.Require<JObject>("point");
            var name = c.Get<string>("name");
            var number = c.Get<string>("number");

            return c.Write("Create room", () =>
            {
                var room = doc.Create.NewRoom(level, new UV(Units.FromMm(p.Value<double>("x")), Units.FromMm(p.Value<double>("y"))));
                if (!string.IsNullOrEmpty(name)) room.Name = name;
                if (!string.IsNullOrEmpty(number)) room.Number = number;
                doc.Regenerate();
                return new
                {
                    id = Ids.Of(room.Id),
                    number = room.Number,
                    name = room.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString(),
                    level = level.Name,
                    areaM2 = Units.ToM2(room.Area),
                    enclosed = room.Area > 0,
                };
            });
        }

        [McpCommand("create_sheet")]
        public static object CreateSheet(CommandContext c)
        {
            var doc = c.Doc;
            var number = c.Require<string>("number");
            var name = c.Require<string>("name");
            var titleBlockName = c.Get<string>("titleBlock");
            var viewIds = c.Get<List<long>>("viewIds") ?? new List<long>();

            var titleBlock = string.IsNullOrEmpty(titleBlockName)
                ? new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_TitleBlocks).OfClass(typeof(FamilySymbol)).FirstElementId()
                : Lookup.Symbol(doc, titleBlockName, BuiltInCategory.OST_TitleBlocks).Id;

            return c.Write("Create sheet", () =>
            {
                var sheet = ViewSheet.Create(doc, titleBlock ?? ElementId.InvalidElementId);
                sheet.SheetNumber = number;
                sheet.Name = name;
                doc.Regenerate();

                var outline = sheet.Outline;
                var width = outline.Max.U - outline.Min.U;
                var placed = new List<long>();
                var skipped = new List<object>();
                for (var i = 0; i < viewIds.Count; i++)
                {
                    var viewId = Ids.From(viewIds[i]);
                    if (!Viewport.CanAddViewToSheet(doc, sheet.Id, viewId))
                    {
                        skipped.Add(new { viewId = viewIds[i], reason = "View cannot be placed (already on a sheet, or not placeable)." });
                        continue;
                    }
                    var u = outline.Min.U + width * (i + 1) / (viewIds.Count + 1);
                    var v = (outline.Min.V + outline.Max.V) / 2;
                    placed.Add(Ids.Of(Viewport.Create(doc, sheet.Id, viewId, new XYZ(u, v, 0)).Id));
                }
                return new { id = Ids.Of(sheet.Id), number = sheet.SheetNumber, name = sheet.Name, viewportIds = placed, skipped };
            });
        }
    }
}
