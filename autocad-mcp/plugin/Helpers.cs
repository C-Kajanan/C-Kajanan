using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.Colors;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Geometry;
using Newtonsoft.Json.Linq;

namespace AutoCadMcp
{
    /// <summary>Points are {x, y, z} in WCS drawing units; angles are degrees on the MCP side.</summary>
    internal static class Geo
    {
        public static Point3d Point(JToken p)
        {
            if (p == null || p.Type != JTokenType.Object) throw new McpException("Expected a point {x, y, z}.");
            return new Point3d(p.Value<double?>("x") ?? 0, p.Value<double?>("y") ?? 0, p.Value<double?>("z") ?? 0);
        }

        public static Point3d Point(CommandContext c, string name) =>
            Point(c.Token(name) ?? throw new McpException($"Missing required parameter '{name}'."));

        public static Vector3d Vector(CommandContext c, string name) => Point(c, name) - Point3d.Origin;

        public static List<Point3d> Points(CommandContext c, string name) =>
            (c.Token(name) as JArray ?? throw new McpException($"Missing required parameter '{name}'."))
            .Select(Point).ToList();

        public static double Rad(double degrees) => degrees * Math.PI / 180.0;
        public static double Deg(double radians) => Math.Round(radians * 180.0 / Math.PI, 6);
        public static double R(double v) => Math.Round(v, 6);

        public static object Json(Point3d p) => new { x = R(p.X), y = R(p.Y), z = R(p.Z) };
        public static object Json(Point2d p) => new { x = R(p.X), y = R(p.Y) };
        public static object Json(Vector3d v) => new { x = R(v.X), y = R(v.Y), z = R(v.Z) };
        public static object Json(Extents3d e) => new { min = Json(e.MinPoint), max = Json(e.MaxPoint) };

        public static Extents3d? ExtentsOf(Entity e)
        {
            try
            {
                var ext = e.GeometricExtents;
                return ext;
            }
            catch
            {
                return null;
            }
        }

        public static bool Overlaps(Extents3d a, Extents3d b) =>
            a.MinPoint.X <= b.MaxPoint.X && a.MaxPoint.X >= b.MinPoint.X &&
            a.MinPoint.Y <= b.MaxPoint.Y && a.MaxPoint.Y >= b.MinPoint.Y;

        public static Extents3d Window(JToken window)
        {
            var a = Point(window["min"]);
            var b = Point(window["max"]);
            return new Extents3d(
                new Point3d(Math.Min(a.X, b.X), Math.Min(a.Y, b.Y), Math.Min(a.Z, b.Z)),
                new Point3d(Math.Max(a.X, b.X), Math.Max(a.Y, b.Y), Math.Max(a.Z, b.Z)));
        }
    }

    internal static class Colors
    {
        private static readonly Dictionary<string, short> Names = new Dictionary<string, short>(StringComparer.OrdinalIgnoreCase)
        {
            ["red"] = 1, ["yellow"] = 2, ["green"] = 3, ["cyan"] = 4, ["blue"] = 5, ["magenta"] = 6, ["white"] = 7, ["black"] = 7,
            ["gray"] = 8, ["grey"] = 8, ["lightgray"] = 9, ["lightgrey"] = 9,
        };

        public static Color Parse(JToken token)
        {
            if (token.Type == JTokenType.Integer) return Aci(token.Value<int>());
            var text = token.ToString().Trim();
            if (text.Equals("bylayer", StringComparison.OrdinalIgnoreCase)) return Color.FromColorIndex(ColorMethod.ByLayer, 256);
            if (text.Equals("byblock", StringComparison.OrdinalIgnoreCase)) return Color.FromColorIndex(ColorMethod.ByBlock, 0);
            if (Names.TryGetValue(text, out var named)) return Color.FromColorIndex(ColorMethod.ByAci, named);
            if (int.TryParse(text, out var index)) return Aci(index);
            if (Regex.IsMatch(text, "^#?[0-9A-Fa-f]{6}$"))
            {
                var hex = text.TrimStart('#');
                return Color.FromRgb(
                    byte.Parse(hex.Substring(0, 2), NumberStyles.HexNumber),
                    byte.Parse(hex.Substring(2, 2), NumberStyles.HexNumber),
                    byte.Parse(hex.Substring(4, 2), NumberStyles.HexNumber));
            }
            var parts = text.Split(',');
            if (parts.Length == 3 && parts.All(p => byte.TryParse(p.Trim(), out _)))
                return Color.FromRgb(byte.Parse(parts[0].Trim()), byte.Parse(parts[1].Trim()), byte.Parse(parts[2].Trim()));
            throw new McpException($"Unknown color '{text}'. Use an ACI index 1-255, a name like 'red', 'ByLayer', '#RRGGBB' or 'r,g,b'.");
        }

        private static Color Aci(int index)
        {
            if (index == 256) return Color.FromColorIndex(ColorMethod.ByLayer, 256);
            if (index == 0) return Color.FromColorIndex(ColorMethod.ByBlock, 0);
            if (index < 1 || index > 255) throw new McpException($"ACI color index must be 1-255 (got {index}).");
            return Color.FromColorIndex(ColorMethod.ByAci, (short)index);
        }

        public static object Json(Color c)
        {
            if (c.IsByLayer) return "ByLayer";
            if (c.IsByBlock) return "ByBlock";
            if (c.IsByAci) return (int)c.ColorIndex;
            return $"#{c.Red:X2}{c.Green:X2}{c.Blue:X2}";
        }
    }

    internal static class Symbols
    {
        /// <summary>Layer id by name; creates the layer when it doesn't exist.</summary>
        public static ObjectId Layer(Transaction tr, Database db, string name, bool create = true)
        {
            var table = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
            if (table.Has(name)) return table[name];
            if (!create) throw new McpException($"No layer named '{name}'.");
            Validate(name, "layer");
            table.UpgradeOpen();
            var layer = new LayerTableRecord { Name = name };
            var id = table.Add(layer);
            tr.AddNewlyCreatedDBObject(layer, true);
            return id;
        }

        public static ObjectId Linetype(Transaction tr, Database db, string name)
        {
            var table = (LinetypeTable)tr.GetObject(db.LinetypeTableId, OpenMode.ForRead);
            if (table.Has(name)) return table[name];
            throw new McpException($"Linetype '{name}' is not loaded. Load it with load_linetype first.");
        }

        public static ObjectId TextStyle(Transaction tr, Database db, string name)
        {
            if (string.IsNullOrEmpty(name)) return db.Textstyle;
            var table = (TextStyleTable)tr.GetObject(db.TextStyleTableId, OpenMode.ForRead);
            if (table.Has(name)) return table[name];
            throw new McpException($"No text style named '{name}'. Available: {string.Join(", ", Names(tr, table))}");
        }

        public static ObjectId DimStyle(Transaction tr, Database db, string name)
        {
            if (string.IsNullOrEmpty(name)) return db.Dimstyle;
            var table = (DimStyleTable)tr.GetObject(db.DimStyleTableId, OpenMode.ForRead);
            if (table.Has(name)) return table[name];
            throw new McpException($"No dimension style named '{name}'. Available: {string.Join(", ", Names(tr, table))}");
        }

        public static IEnumerable<string> Names(Transaction tr, SymbolTable table)
        {
            foreach (ObjectId id in table)
                yield return ((SymbolTableRecord)tr.GetObject(id, OpenMode.ForRead)).Name;
        }

        public static void Validate(string name, string what)
        {
            try { SymbolUtilityServices.ValidateSymbolName(name, false); }
            catch { throw new McpException($"'{name}' is not a valid {what} name."); }
        }

        /// <summary>Block table record by name (case-insensitive), or ObjectId.Null.</summary>
        public static ObjectId Block(Transaction tr, Database db, string name)
        {
            var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            return table.Has(name) ? table[name] : ObjectId.Null;
        }
    }

    internal static class Spaces
    {
        public static BlockTableRecord Current(Transaction tr, Database db, OpenMode mode = OpenMode.ForWrite) =>
            (BlockTableRecord)tr.GetObject(db.CurrentSpaceId, mode);

        /// <summary>"model", "current" or a paper-space layout name.</summary>
        public static BlockTableRecord Named(Transaction tr, Database db, string name)
        {
            if (string.IsNullOrEmpty(name) || name.Equals("model", StringComparison.OrdinalIgnoreCase))
            {
                var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                return (BlockTableRecord)tr.GetObject(table[BlockTableRecord.ModelSpace], OpenMode.ForRead);
            }
            if (name.Equals("current", StringComparison.OrdinalIgnoreCase)) return Current(tr, db, OpenMode.ForRead);

            var layouts = (DBDictionary)tr.GetObject(db.LayoutDictionaryId, OpenMode.ForRead);
            foreach (DBDictionaryEntry entry in layouts)
            {
                if (!entry.Key.Equals(name, StringComparison.OrdinalIgnoreCase)) continue;
                var layout = (Layout)tr.GetObject(entry.Value, OpenMode.ForRead);
                return (BlockTableRecord)tr.GetObject(layout.BlockTableRecordId, OpenMode.ForRead);
            }
            throw new McpException($"No layout named '{name}'. Use list_layouts.");
        }

        /// <summary>Adds a new entity to a space with the common style parameters applied.</summary>
        public static Entity Add(CommandContext c, Transaction tr, Entity entity, BlockTableRecord space = null)
        {
            var db = c.Db;
            entity.SetDatabaseDefaults(db);
            Style.Apply(c, tr, entity);
            space = space ?? Current(tr, db);
            if (!space.IsWriteEnabled) space.UpgradeOpen();
            space.AppendEntity(entity);
            tr.AddNewlyCreatedDBObject(entity, true);
            return entity;
        }
    }

    internal static class Style
    {
        /// <summary>Applies the optional layer / color / linetype parameters.</summary>
        public static void Apply(CommandContext c, Transaction tr, Entity entity)
        {
            var layer = c.Get<string>("layer");
            if (!string.IsNullOrEmpty(layer)) entity.LayerId = Symbols.Layer(tr, c.Db, layer);
            var color = c.Token("color");
            if (color != null) entity.Color = Colors.Parse(color);
            var linetype = c.Get<string>("linetype");
            if (!string.IsNullOrEmpty(linetype)) entity.LinetypeId = Symbols.Linetype(tr, c.Db, linetype);
        }
    }

    internal static class Wildcard
    {
        public static bool Match(string value, string pattern)
        {
            if (string.IsNullOrEmpty(pattern)) return true;
            if (pattern.IndexOfAny(new[] { '*', '?' }) < 0) return string.Equals(value, pattern, StringComparison.OrdinalIgnoreCase);
            var regex = "^" + Regex.Escape(pattern).Replace("\\*", ".*").Replace("\\?", ".") + "$";
            return Regex.IsMatch(value ?? "", regex, RegexOptions.IgnoreCase);
        }
    }

    internal static class Views
    {
        /// <summary>Zooms the current view so <paramref name="ext"/> (WCS) fills it.</summary>
        public static void ZoomTo(Editor ed, Extents3d ext, double margin)
        {
            using (var view = ed.GetCurrentView())
            {
                var wcsToDcs = Matrix3d.PlaneToWorld(view.ViewDirection);
                wcsToDcs = Matrix3d.Displacement(view.Target - Point3d.Origin) * wcsToDcs;
                wcsToDcs = Matrix3d.Rotation(-view.ViewTwist, view.ViewDirection, view.Target) * wcsToDcs;
                wcsToDcs = wcsToDcs.Inverse();

                var box = ext;
                box.TransformBy(wcsToDcs);
                var width = Math.Max(box.MaxPoint.X - box.MinPoint.X, 1e-6) * (1 + 2 * margin);
                var height = Math.Max(box.MaxPoint.Y - box.MinPoint.Y, 1e-6) * (1 + 2 * margin);
                var ratio = view.Width / view.Height;
                if (width / height > ratio) height = width / ratio;
                else width = height * ratio;

                view.CenterPoint = new Point2d((box.MinPoint.X + box.MaxPoint.X) / 2, (box.MinPoint.Y + box.MaxPoint.Y) / 2);
                view.Width = width;
                view.Height = height;
                ed.SetCurrentView(view);
            }
        }

        public static Extents3d? Union(IEnumerable<Entity> entities)
        {
            Extents3d? total = null;
            foreach (var entity in entities)
            {
                var ext = Geo.ExtentsOf(entity);
                if (ext == null) continue;
                if (total == null) total = ext;
                else
                {
                    var t = total.Value;
                    t.AddExtents(ext.Value);
                    total = t;
                }
            }
            return total;
        }
    }

    internal static class Describe
    {
        public static string Handle(ObjectId id) => id.Handle.ToString();

        public static string BlockName(Transaction tr, BlockReference br)
        {
            if (br.IsDynamicBlock)
                return ((BlockTableRecord)tr.GetObject(br.DynamicBlockTableRecord, OpenMode.ForRead)).Name;
            return br.Name;
        }

        public static Dictionary<string, string> Attributes(Transaction tr, BlockReference br)
        {
            var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (ObjectId id in br.AttributeCollection)
            {
                if (tr.GetObject(id, OpenMode.ForRead) is AttributeReference ar)
                    map[ar.Tag] = ar.TextString;
            }
            return map;
        }

        /// <summary>All text an entity shows: TEXT, MTEXT, attribute values, dimension overrides.</summary>
        public static IEnumerable<string> Texts(Transaction tr, Entity e)
        {
            switch (e)
            {
                case DBText t: yield return t.TextString; break;
                case MText m: yield return m.Text; break;
                case Dimension d: yield return d.DimensionText; break;
                case BlockReference br:
                    foreach (var v in Attributes(tr, br).Values) yield return v;
                    break;
            }
        }

        public static double? CurveLength(Curve c)
        {
            try { return Geo.R(c.GetDistanceAtParameter(c.EndParam) - c.GetDistanceAtParameter(c.StartParam)); }
            catch { return null; }
        }

        public static Dictionary<string, object> Entity(Transaction tr, Entity e, bool details)
        {
            var d = new Dictionary<string, object>
            {
                ["handle"] = e.Handle.ToString(),
                ["type"] = e.GetRXClass().DxfName,
                ["layer"] = e.Layer,
            };
            if (details)
            {
                d["class"] = e.GetType().Name;
                d["color"] = Colors.Json(e.Color);
                d["linetype"] = e.Linetype;
                d["lineweight"] = (int)e.LineWeight;
                d["linetypeScale"] = e.LinetypeScale;
                d["visible"] = e.Visible;
                var ext = Geo.ExtentsOf(e);
                if (ext != null) d["extents"] = Geo.Json(ext.Value);
            }

            switch (e)
            {
                case Line l:
                    d["start"] = Geo.Json(l.StartPoint);
                    d["end"] = Geo.Json(l.EndPoint);
                    d["length"] = Geo.R(l.Length);
                    d["angle"] = Geo.Deg(l.Angle);
                    break;
                case Arc a:
                    d["center"] = Geo.Json(a.Center);
                    d["radius"] = Geo.R(a.Radius);
                    d["startAngle"] = Geo.Deg(a.StartAngle);
                    d["endAngle"] = Geo.Deg(a.EndAngle);
                    d["length"] = Geo.R(a.Length);
                    break;
                case Circle ci:
                    d["center"] = Geo.Json(ci.Center);
                    d["radius"] = Geo.R(ci.Radius);
                    d["area"] = Geo.R(ci.Area);
                    d["circumference"] = Geo.R(ci.Circumference);
                    break;
                case Polyline p:
                    d["closed"] = p.Closed;
                    d["vertexCount"] = p.NumberOfVertices;
                    d["length"] = Geo.R(p.Length);
                    if (p.Closed) d["area"] = Geo.R(p.Area);
                    if (Math.Abs(p.Elevation) > 1e-9) d["elevation"] = Geo.R(p.Elevation);
                    if (details)
                    {
                        var vertices = new List<object>();
                        for (int i = 0; i < p.NumberOfVertices; i++)
                        {
                            var pt = p.GetPoint2dAt(i);
                            var bulge = p.GetBulgeAt(i);
                            vertices.Add(bulge == 0
                                ? (object)new { x = Geo.R(pt.X), y = Geo.R(pt.Y) }
                                : new { x = Geo.R(pt.X), y = Geo.R(pt.Y), bulge = Geo.R(bulge) });
                        }
                        d["vertices"] = vertices;
                    }
                    break;
                case Polyline2d p2:
                    d["closed"] = p2.Closed;
                    d["length"] = Geo.R(p2.Length);
                    if (details) d["vertices"] = HeavyVertices(tr, p2);
                    break;
                case Polyline3d p3:
                    d["closed"] = p3.Closed;
                    d["length"] = Geo.R(p3.Length);
                    if (details) d["vertices"] = HeavyVertices(tr, p3);
                    break;
                case Ellipse el:
                    d["center"] = Geo.Json(el.Center);
                    d["majorAxis"] = Geo.Json(el.MajorAxis);
                    d["radiusRatio"] = Geo.R(el.RadiusRatio);
                    d["length"] = CurveLength(el);
                    break;
                case Spline sp:
                    d["degree"] = sp.Degree;
                    d["closed"] = sp.Closed;
                    d["length"] = CurveLength(sp);
                    if (details)
                    {
                        var pts = new List<object>();
                        for (int i = 0; i < sp.NumControlPoints; i++) pts.Add(Geo.Json(sp.GetControlPointAt(i)));
                        d["controlPoints"] = pts;
                    }
                    break;
                case DBText t:
                    d["text"] = t.TextString;
                    d["position"] = Geo.Json(t.Justify == AttachmentPoint.BaseLeft ? t.Position : t.AlignmentPoint);
                    d["height"] = Geo.R(t.Height);
                    d["rotation"] = Geo.Deg(t.Rotation);
                    d["justify"] = t.Justify.ToString();
                    d["textStyle"] = t.TextStyleName;
                    break;
                case MText m:
                    d["text"] = m.Text;
                    if (details) d["contents"] = m.Contents;
                    d["position"] = Geo.Json(m.Location);
                    d["height"] = Geo.R(m.TextHeight);
                    d["width"] = Geo.R(m.Width);
                    d["rotation"] = Geo.Deg(m.Rotation);
                    d["textStyle"] = m.TextStyleName;
                    break;
                case BlockReference br:
                    d["blockName"] = BlockName(tr, br);
                    d["position"] = Geo.Json(br.Position);
                    d["scale"] = new { x = Geo.R(br.ScaleFactors.X), y = Geo.R(br.ScaleFactors.Y), z = Geo.R(br.ScaleFactors.Z) };
                    d["rotation"] = Geo.Deg(br.Rotation);
                    var attributes = Attributes(tr, br);
                    if (attributes.Count > 0) d["attributes"] = attributes;
                    if (details && br.IsDynamicBlock)
                    {
                        var props = new Dictionary<string, object>();
                        foreach (DynamicBlockReferenceProperty prop in br.DynamicBlockReferencePropertyCollection)
                            if (prop.PropertyName != "Origin") props[prop.PropertyName] = prop.Value?.ToString();
                        d["dynamicProperties"] = props;
                    }
                    break;
                case Hatch h:
                    d["pattern"] = h.PatternName;
                    d["loops"] = h.NumberOfLoops;
                    try { d["area"] = Geo.R(h.Area); } catch { }
                    break;
                case Dimension dim:
                    d["measurement"] = Geo.R(dim.Measurement);
                    if (!string.IsNullOrEmpty(dim.DimensionText)) d["textOverride"] = dim.DimensionText;
                    d["dimStyle"] = dim.DimensionStyleName;
                    break;
                case DBPoint pt:
                    d["position"] = Geo.Json(pt.Position);
                    break;
                case Region r:
                    d["area"] = Geo.R(r.Area);
                    d["perimeter"] = Geo.R(r.Perimeter);
                    break;
                case Curve curve:
                    d["length"] = CurveLength(curve);
                    break;
            }
            return d;
        }

        private static List<object> HeavyVertices(Transaction tr, Curve polyline)
        {
            var list = new List<object>();
            foreach (ObjectId id in (System.Collections.IEnumerable)polyline)
            {
                switch (tr.GetObject(id, OpenMode.ForRead))
                {
                    case Vertex2d v when v.VertexType != Vertex2dType.SplineControlVertex:
                        list.Add(Geo.Json(v.Position));
                        break;
                    case PolylineVertex3d v when v.VertexType != Vertex3dType.ControlVertex:
                        list.Add(Geo.Json(v.Position));
                        break;
                }
            }
            return list;
        }
    }
}
