using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMcp
{
    internal static class Ids
    {
#if REVIT2024_OR_GREATER
        public static long Of(ElementId id) => id.Value;
        public static ElementId From(long value) => new ElementId(value);
#else
        public static long Of(ElementId id) => id.IntegerValue;
        public static ElementId From(long value) => new ElementId((int)value);
#endif
    }

    /// <summary>The MCP side speaks millimetres and degrees; Revit stores feet and radians.</summary>
    internal static class Units
    {
        public static double FromMm(double mm) => UnitUtils.ConvertToInternalUnits(mm, UnitTypeId.Millimeters);
        public static double ToMm(double feet) => Math.Round(UnitUtils.ConvertFromInternalUnits(feet, UnitTypeId.Millimeters), 2);
        public static double ToM2(double sqft) => Math.Round(UnitUtils.ConvertFromInternalUnits(sqft, UnitTypeId.SquareMeters), 3);
        public static double ToM3(double cuft) => Math.Round(UnitUtils.ConvertFromInternalUnits(cuft, UnitTypeId.CubicMeters), 3);
        public static double Radians(double degrees) => degrees * Math.PI / 180.0;

        public static XYZ Point(JToken p, double baseZ = 0) => new XYZ(
            FromMm(p.Value<double>("x")),
            FromMm(p.Value<double>("y")),
            baseZ + FromMm(p["z"]?.Value<double>() ?? 0));

        public static object Json(XYZ p) => p == null ? null : new { x = ToMm(p.X), y = ToMm(p.Y), z = ToMm(p.Z) };
    }

    internal static class Lookup
    {
        public static Category Category(Document doc, string name)
        {
            var bicName = name.StartsWith("OST_", StringComparison.OrdinalIgnoreCase) ? name : "OST_" + name.Replace(" ", "");
            if (Enum.TryParse(bicName, true, out BuiltInCategory bic))
            {
                var category = Autodesk.Revit.DB.Category.GetCategory(doc, bic);
                if (category != null) return category;
            }
            foreach (Category category in doc.Settings.Categories)
                if (string.Equals(category.Name, name, StringComparison.OrdinalIgnoreCase)) return category;
            throw new McpException($"Unknown category '{name}'. Use a BuiltInCategory like OST_Walls or a display name like 'Walls'.");
        }

        public static List<Level> Levels(Document doc) =>
            new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => l.Elevation).ToList();

        /// <summary>Level by name, or the lowest level when no name is given.</summary>
        public static Level Level(Document doc, string name)
        {
            var levels = Levels(doc);
            if (levels.Count == 0) throw new McpException("The model has no levels.");
            if (string.IsNullOrEmpty(name)) return levels[0];
            return levels.FirstOrDefault(l => string.Equals(l.Name, name, StringComparison.OrdinalIgnoreCase))
                   ?? throw new McpException($"No level named '{name}'. Levels: {string.Join(", ", levels.Select(l => l.Name))}");
        }

        public static T Type<T>(Document doc, string name, ElementTypeGroup defaultGroup) where T : ElementType
        {
            if (string.IsNullOrEmpty(name))
            {
                var id = doc.GetDefaultElementTypeId(defaultGroup);
                return doc.GetElement(id) as T
                       ?? new FilteredElementCollector(doc).OfClass(typeof(T)).Cast<T>().FirstOrDefault()
                       ?? throw new McpException($"No {typeof(T).Name} is available in the model.");
            }
            var all = new FilteredElementCollector(doc).OfClass(typeof(T)).Cast<T>().ToList();
            return all.FirstOrDefault(t => string.Equals(t.Name, name, StringComparison.OrdinalIgnoreCase))
                   ?? throw new McpException($"No {typeof(T).Name} named '{name}'. Available: {string.Join(", ", all.Select(t => t.Name).Take(40))}");
        }

        /// <summary>Accepts "Family: Type" or a bare type name.</summary>
        public static FamilySymbol Symbol(Document doc, string name, BuiltInCategory? category = null)
        {
            var collector = new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol));
            if (category.HasValue) collector = collector.OfCategory(category.Value);
            var symbols = collector.Cast<FamilySymbol>().ToList();

            string family = null, type = name;
            var colon = name.IndexOf(':');
            if (colon > 0)
            {
                family = name.Substring(0, colon).Trim();
                type = name.Substring(colon + 1).Trim();
            }

            var matches = symbols.Where(s =>
                string.Equals(s.Name, type, StringComparison.OrdinalIgnoreCase) &&
                (family == null || string.Equals(s.FamilyName, family, StringComparison.OrdinalIgnoreCase))).ToList();
            if (matches.Count == 1) return matches[0];
            if (matches.Count > 1)
                throw new McpException($"'{name}' is ambiguous: {string.Join(", ", matches.Select(m => m.FamilyName + ": " + m.Name))}. Use 'Family: Type'.");
            throw new McpException($"No family type '{name}' is loaded. Use list_family_types to see what is available.");
        }

        public static View View(CommandContext ctx, string param = "viewId")
        {
            var id = ctx.Get<long?>(param);
            if (id == null) return ctx.Doc.ActiveView ?? throw new McpException("There is no active view.");
            return ctx.Doc.GetElement(Ids.From(id.Value)) as View ?? throw new McpException($"Element {id} is not a view.");
        }
    }

    internal static class Describe
    {
        public static object Element(Element e)
        {
            var doc = e.Document;
            var type = doc.GetElement(e.GetTypeId()) as ElementType;
            var level = e.LevelId != ElementId.InvalidElementId ? doc.GetElement(e.LevelId) as Level : null;
            return new
            {
                id = Ids.Of(e.Id),
                name = SafeName(e),
                category = e.Category?.Name,
                family = type?.FamilyName,
                type = type?.Name,
                level = level?.Name,
            };
        }

        public static object Location(Element e)
        {
            switch (e.Location)
            {
                case LocationPoint lp:
                    double? rotation = null;
                    try { rotation = Math.Round(lp.Rotation * 180 / Math.PI, 3); } catch { }
                    return new { point = Units.Json(lp.Point), rotationDegrees = rotation };
                case LocationCurve lc:
                    return new
                    {
                        start = Units.Json(lc.Curve.GetEndPoint(0)),
                        end = Units.Json(lc.Curve.GetEndPoint(1)),
                        length = Units.ToMm(lc.Curve.Length),
                    };
                default:
                    return null;
            }
        }

        public static object BoundingBox(Element e)
        {
            var box = e.get_BoundingBox(null);
            return box == null ? null : new { min = Units.Json(box.Min), max = Units.Json(box.Max) };
        }

        public static SortedDictionary<string, object> Parameters(Element e)
        {
            var result = new SortedDictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            if (e == null) return result;
            foreach (Parameter p in e.Parameters)
            {
                var name = p.Definition?.Name;
                if (string.IsNullOrEmpty(name) || result.ContainsKey(name)) continue;
                result[name] = Value(p);
            }
            return result;
        }

        public static object Value(Parameter p)
        {
            if (p == null || !p.HasValue) return null;
            switch (p.StorageType)
            {
                case StorageType.String:
                    return p.AsString();
                case StorageType.Integer:
                    return p.AsValueString() ?? (object)p.AsInteger();
                case StorageType.Double:
                    return p.AsValueString() ?? (object)p.AsDouble();
                case StorageType.ElementId:
                    var display = p.AsValueString();
                    return string.IsNullOrEmpty(display) ? (object)Ids.Of(p.AsElementId()) : display;
                default:
                    return null;
            }
        }

        public static string SafeName(Element e)
        {
            try { return e.Name; } catch { return null; }
        }
    }
}
