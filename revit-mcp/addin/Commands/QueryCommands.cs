using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;

namespace RevitMcp.Commands
{
    internal static class QueryCommands
    {
        [McpCommand("ping")]
        public static object Ping(CommandContext c)
        {
            var app = c.App.Application;
            var doc = c.UiDoc?.Document;
            return new
            {
                revitVersion = app.VersionNumber,
                revitBuild = app.VersionBuild,
                addinVersion = typeof(QueryCommands).Assembly.GetName().Version.ToString(),
                documentOpen = doc != null,
                documentTitle = doc?.Title,
            };
        }

        [McpCommand("get_document_info")]
        public static object DocumentInfo(CommandContext c)
        {
            var doc = c.Doc;
            var info = doc.ProjectInformation;
            var counts = new SortedDictionary<string, int>();
            foreach (var bic in new[]
            {
                BuiltInCategory.OST_Walls, BuiltInCategory.OST_Doors, BuiltInCategory.OST_Windows,
                BuiltInCategory.OST_Floors, BuiltInCategory.OST_Roofs, BuiltInCategory.OST_Ceilings,
                BuiltInCategory.OST_Rooms, BuiltInCategory.OST_Furniture, BuiltInCategory.OST_StructuralColumns,
                BuiltInCategory.OST_StructuralFraming, BuiltInCategory.OST_Stairs, BuiltInCategory.OST_Levels,
                BuiltInCategory.OST_Grids, BuiltInCategory.OST_Sheets,
            })
            {
                var category = Category.GetCategory(doc, bic);
                if (category == null) continue;
                counts[category.Name] = new FilteredElementCollector(doc).OfCategory(bic).WhereElementIsNotElementType().GetElementCount();
            }

            return new
            {
                title = doc.Title,
                path = doc.PathName,
                isFamilyDocument = doc.IsFamilyDocument,
                isWorkshared = doc.IsWorkshared,
                project = info == null ? null : new { name = info.Name, number = info.Number, client = info.ClientName, address = info.Address, status = info.Status },
                lengthUnit = doc.GetUnits().GetFormatOptions(SpecTypeId.Length).GetUnitTypeId().TypeId,
                activeView = doc.ActiveView == null ? null : new { id = Ids.Of(doc.ActiveView.Id), name = doc.ActiveView.Name, type = doc.ActiveView.ViewType.ToString() },
                counts,
                note = "All lengths exchanged with the MCP server are in millimetres.",
            };
        }

        [McpCommand("list_levels")]
        public static object ListLevels(CommandContext c) =>
            Lookup.Levels(c.Doc).Select(l => new { id = Ids.Of(l.Id), name = l.Name, elevation = Units.ToMm(l.Elevation) });

        [McpCommand("list_views")]
        public static object ListViews(CommandContext c)
        {
            var filter = c.Get<string>("viewType");
            return new FilteredElementCollector(c.Doc).OfClass(typeof(View)).Cast<View>()
                .Where(v => !v.IsTemplate)
                .Where(v => filter == null || string.Equals(v.ViewType.ToString(), filter, StringComparison.OrdinalIgnoreCase))
                .OrderBy(v => v.ViewType.ToString()).ThenBy(v => v.Name)
                .Select(ViewInfo)
                .ToList();
        }

        [McpCommand("get_active_view")]
        public static object ActiveView(CommandContext c) =>
            ViewInfo(c.Doc.ActiveView ?? throw new McpException("There is no active view."));

        private static object ViewInfo(View v)
        {
            int? scale = null;
            try { if (v.ViewType != ViewType.Schedule && v.ViewType != ViewType.DrawingSheet) scale = v.Scale; } catch { }
            return new
            {
                id = Ids.Of(v.Id),
                name = v.Name,
                viewType = v.ViewType.ToString(),
                level = v.GenLevel?.Name,
                scale,
                sheetNumber = (v as ViewSheet)?.SheetNumber,
            };
        }

        [McpCommand("get_selection")]
        public static object Selection(CommandContext c)
        {
            var doc = c.Doc;
            return c.UiDoc.Selection.GetElementIds().Select(id => doc.GetElement(id)).Where(e => e != null).Select(Describe.Element).ToList();
        }

        [McpCommand("query_elements")]
        public static object QueryElements(CommandContext c)
        {
            var doc = c.Doc;
            var category = Lookup.Category(doc, c.Require<string>("category"));
            var viewId = c.Get<long?>("viewId");
            var parameterName = c.Get<string>("parameterName");
            var parameterValue = c.Get<string>("parameterValue");
            var includeParameters = c.Get("includeParameters", false);
            var limit = c.Get("limit", 200);

            var collector = viewId.HasValue ? new FilteredElementCollector(doc, Ids.From(viewId.Value)) : new FilteredElementCollector(doc);
            IEnumerable<Element> elements = collector.OfCategoryId(category.Id).WhereElementIsNotElementType();

            if (!string.IsNullOrEmpty(parameterName))
            {
                elements = elements.Where(e =>
                {
                    var p = e.LookupParameter(parameterName);
                    if (p == null) return false;
                    if (parameterValue == null) return true;
                    var value = Describe.Value(p)?.ToString() ?? "";
                    return value.IndexOf(parameterValue, StringComparison.OrdinalIgnoreCase) >= 0;
                });
            }

            var matched = elements.ToList();
            return new
            {
                category = category.Name,
                total = matched.Count,
                returned = Math.Min(limit, matched.Count),
                elements = matched.Take(limit).Select(e => includeParameters
                    ? (object)new { summary = Describe.Element(e), location = Describe.Location(e), parameters = Describe.Parameters(e) }
                    : new { summary = Describe.Element(e), location = Describe.Location(e) }).ToList(),
            };
        }

        [McpCommand("get_element")]
        public static object GetElement(CommandContext c)
        {
            var doc = c.Doc;
            var id = c.Require<long>("id");
            var element = doc.GetElement(Ids.From(id)) ?? throw new McpException($"Element {id} does not exist.");
            var type = doc.GetElement(element.GetTypeId());
            return new
            {
                summary = Describe.Element(element),
                uniqueId = element.UniqueId,
                location = Describe.Location(element),
                boundingBox = Describe.BoundingBox(element),
                host = (element as FamilyInstance)?.Host == null ? null : Describe.Element(((FamilyInstance)element).Host),
                parameters = Describe.Parameters(element),
                typeId = type == null ? (long?)null : Ids.Of(type.Id),
                typeParameters = Describe.Parameters(type),
            };
        }

        [McpCommand("list_family_types")]
        public static object ListFamilyTypes(CommandContext c)
        {
            var doc = c.Doc;
            var categoryName = c.Get<string>("category");
            var contains = c.Get<string>("nameContains");
            var limit = c.Get("limit", 300);

            var collector = new FilteredElementCollector(doc).WhereElementIsElementType();
            if (!string.IsNullOrEmpty(categoryName)) collector = collector.OfCategoryId(Lookup.Category(doc, categoryName).Id);

            var types = collector.Cast<ElementType>()
                .Where(t => t.Category != null && (t is FamilySymbol || t is HostObjAttributes))
                .Where(t => contains == null ||
                            (t.FamilyName + ": " + t.Name).IndexOf(contains, StringComparison.OrdinalIgnoreCase) >= 0)
                .OrderBy(t => t.Category.Name).ThenBy(t => t.FamilyName).ThenBy(t => t.Name)
                .ToList();

            return new
            {
                total = types.Count,
                types = types.Take(limit).Select(t => new
                {
                    id = Ids.Of(t.Id),
                    category = t.Category.Name,
                    family = t.FamilyName,
                    name = t.Name,
                    placeAs = t is FamilySymbol ? t.FamilyName + ": " + t.Name : t.Name,
                    kind = t is FamilySymbol ? "loadable" : "system",
                }).ToList(),
            };
        }

        [McpCommand("list_rooms")]
        public static object ListRooms(CommandContext c)
        {
            var levelName = c.Get<string>("levelName");
            return new FilteredElementCollector(c.Doc).OfCategory(BuiltInCategory.OST_Rooms).WhereElementIsNotElementType()
                .Cast<Room>()
                .Where(r => levelName == null || string.Equals(r.Level?.Name, levelName, StringComparison.OrdinalIgnoreCase))
                .OrderBy(r => r.Level?.Elevation ?? 0).ThenBy(r => r.Number)
                .Select(r => new
                {
                    id = Ids.Of(r.Id),
                    number = r.Number,
                    name = r.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString(),
                    level = r.Level?.Name,
                    placed = r.Location != null,
                    enclosed = r.Area > 0,
                    areaM2 = Units.ToM2(r.Area),
                    perimeterMm = Units.ToMm(r.Perimeter),
                    volumeM3 = Units.ToM3(r.Volume),
                })
                .ToList();
        }

        [McpCommand("export_view_image")]
        public static object ExportViewImage(CommandContext c)
        {
            var doc = c.Doc;
            var view = Lookup.View(c);
            if (!view.CanBePrinted) throw new McpException($"View '{view.Name}' cannot be exported as an image.");

            var folder = Path.Combine(Path.GetTempPath(), "revit-mcp", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(folder);
            try
            {
                var options = new ImageExportOptions
                {
                    ExportRange = ExportRange.SetOfViews,
                    FilePath = Path.Combine(folder, "view"),
                    HLRandWFViewsFileType = ImageFileType.PNG,
                    ShadowViewsFileType = ImageFileType.PNG,
                    ImageResolution = ImageResolution.DPI_150,
                    ZoomType = ZoomFitType.FitToPage,
                    FitDirection = FitDirectionType.Horizontal,
                    PixelSize = c.Get("pixelWidth", 1600),
                };
                options.SetViewsAndSheets(new List<ElementId> { view.Id });
                doc.ExportImage(options);

                var file = Directory.GetFiles(folder, "*.png").FirstOrDefault()
                           ?? throw new McpException("Revit did not produce an image for this view.");
                return new
                {
                    mimeType = "image/png",
                    base64 = Convert.ToBase64String(File.ReadAllBytes(file)),
                    viewId = Ids.Of(view.Id),
                    viewName = view.Name,
                };
            }
            finally
            {
                try { Directory.Delete(folder, true); } catch { }
            }
        }
    }
}
