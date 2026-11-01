using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Newtonsoft.Json.Linq;

namespace AutoCadMcp.Commands
{
    /// <summary>Commands that add new entities to the current space.</summary>
    internal static class DrawCommands
    {
        [McpCommand("draw_line")]
        public static object DrawLine(CommandContext c)
        {
            var start = Geo.Point(c, "start");
            var end = Geo.Point(c, "end");
            if (start.IsEqualTo(end)) throw new McpException("start and end are the same point.");
            return c.Write(tr => Describe.Entity(tr, Spaces.Add(c, tr, new Line(start, end)), false));
        }

        [McpCommand("draw_polyline")]
        public static object DrawPolyline(CommandContext c)
        {
            var points = Geo.Points(c, "points");
            if (points.Count < 2) throw new McpException("A polyline needs at least 2 points.");
            var bulges = c.Get<List<double>>("bulges");
            var width = c.Get("width", 0.0);
            var closed = c.Get("closed", false);
            return c.Write(tr => Describe.Entity(tr, Spaces.Add(c, tr, Pline(points, closed, bulges, width)), false));
        }

        [McpCommand("draw_rectangle")]
        public static object DrawRectangle(CommandContext c)
        {
            var a = Geo.Point(c, "corner1");
            var b = Geo.Point(c, "corner2");
            if (Math.Abs(a.X - b.X) < 1e-9 || Math.Abs(a.Y - b.Y) < 1e-9) throw new McpException("The corners must differ in both X and Y.");
            var points = new List<Point3d>
            {
                new Point3d(a.X, a.Y, a.Z), new Point3d(b.X, a.Y, a.Z), new Point3d(b.X, b.Y, a.Z), new Point3d(a.X, b.Y, a.Z),
            };
            return c.Write(tr => Describe.Entity(tr, Spaces.Add(c, tr, Pline(points, true, null, 0)), false));
        }

        internal static Polyline Pline(List<Point3d> points, bool closed, List<double> bulges, double width)
        {
            var pline = new Polyline(points.Count);
            for (int i = 0; i < points.Count; i++)
            {
                var bulge = bulges != null && i < bulges.Count ? bulges[i] : 0;
                pline.AddVertexAt(i, new Point2d(points[i].X, points[i].Y), bulge, width, width);
            }
            pline.Closed = closed;
            pline.Elevation = points[0].Z;
            return pline;
        }

        [McpCommand("draw_circle")]
        public static object DrawCircle(CommandContext c)
        {
            var center = Geo.Point(c, "center");
            var radius = c.Require<double>("radius");
            return c.Write(tr => Describe.Entity(tr, Spaces.Add(c, tr, new Circle(center, Vector3d.ZAxis, radius)), false));
        }

        [McpCommand("draw_arc")]
        public static object DrawArc(CommandContext c)
        {
            var center = Geo.Point(c, "center");
            var radius = c.Require<double>("radius");
            var start = Geo.Rad(c.Require<double>("startAngle"));
            var end = Geo.Rad(c.Require<double>("endAngle"));
            return c.Write(tr => Describe.Entity(tr, Spaces.Add(c, tr, new Arc(center, Vector3d.ZAxis, radius, start, end)), false));
        }

        private static readonly Dictionary<string, AttachmentPoint> TextJustify = new Dictionary<string, AttachmentPoint>(StringComparer.OrdinalIgnoreCase)
        {
            ["Left"] = AttachmentPoint.BaseLeft,
            ["Center"] = AttachmentPoint.BaseCenter,
            ["Right"] = AttachmentPoint.BaseRight,
            ["Middle"] = AttachmentPoint.BaseMid,
            ["TopLeft"] = AttachmentPoint.TopLeft,
            ["TopCenter"] = AttachmentPoint.TopCenter,
            ["TopRight"] = AttachmentPoint.TopRight,
            ["MiddleLeft"] = AttachmentPoint.MiddleLeft,
            ["MiddleCenter"] = AttachmentPoint.MiddleCenter,
            ["MiddleRight"] = AttachmentPoint.MiddleRight,
            ["BottomLeft"] = AttachmentPoint.BottomLeft,
            ["BottomCenter"] = AttachmentPoint.BottomCenter,
            ["BottomRight"] = AttachmentPoint.BottomRight,
        };

        [McpCommand("draw_text")]
        public static object DrawText(CommandContext c)
        {
            var position = Geo.Point(c, "position");
            var text = c.Require<string>("text");
            var height = c.Get("height", 2.5);
            var rotation = Geo.Rad(c.Get("rotation", 0.0));
            var justifyName = c.Get("justify", "Left");
            if (!TextJustify.TryGetValue(justifyName, out var justify))
                throw new McpException($"Unknown justify '{justifyName}'. Use one of: {string.Join(", ", TextJustify.Keys)}");

            return c.Write(tr =>
            {
                var styleId = Symbols.TextStyle(tr, c.Db, c.Get<string>("textStyle"));
                var dbText = new DBText
                {
                    TextString = text,
                    Position = position,
                    Height = height,
                    Rotation = rotation,
                };
                Spaces.Add(c, tr, dbText);
                dbText.TextStyleId = styleId;
                if (justify != AttachmentPoint.BaseLeft)
                {
                    dbText.Justify = justify;
                    dbText.AlignmentPoint = position;
                    dbText.AdjustAlignment(c.Db);
                }
                return Describe.Entity(tr, dbText, false);
            });
        }

        [McpCommand("draw_mtext")]
        public static object DrawMText(CommandContext c)
        {
            var position = Geo.Point(c, "position");
            var text = c.Require<string>("text").Replace("\r\n", "\\P").Replace("\n", "\\P");
            return c.Write(tr =>
            {
                var mtext = new MText
                {
                    Location = position,
                    Contents = text,
                    Width = c.Get("width", 0.0),
                    Rotation = Geo.Rad(c.Get("rotation", 0.0)),
                    Attachment = AttachmentPoint.TopLeft,
                };
                Spaces.Add(c, tr, mtext);
                mtext.TextStyleId = Symbols.TextStyle(tr, c.Db, c.Get<string>("textStyle"));
                mtext.TextHeight = c.Get("height", 2.5);
                return Describe.Entity(tr, mtext, false);
            });
        }

        [McpCommand("draw_hatch")]
        public static object DrawHatch(CommandContext c)
        {
            var boundaryHandles = c.Get<List<string>>("boundaryHandles");
            var boundaryIds = boundaryHandles?.Select(c.IdOf).ToList();
            var points = boundaryIds == null || boundaryIds.Count == 0 ? Geo.Points(c, "points") : null;
            if (points != null && points.Count < 3) throw new McpException("Give boundaryHandles or at least 3 points.");
            var pattern = c.Get("pattern", "SOLID").ToUpperInvariant();

            return c.Write(tr =>
            {
                var hatch = new Hatch();
                Spaces.Add(c, tr, hatch);
                hatch.Normal = Vector3d.ZAxis;
                hatch.Elevation = points != null ? points[0].Z : 0;
                hatch.PatternScale = c.Get("scale", 1.0);
                hatch.PatternAngle = Geo.Rad(c.Get("angle", 0.0));
                hatch.SetHatchPattern(HatchPatternType.PreDefined, pattern);
                hatch.Associative = false;

                if (points != null)
                {
                    var vertices = new Point2dCollection(points.Select(p => new Point2d(p.X, p.Y)).ToArray());
                    if (!vertices[0].IsEqualTo(vertices[vertices.Count - 1])) vertices.Add(vertices[0]);
                    var bulges = new DoubleCollection(Enumerable.Repeat(0.0, vertices.Count).ToArray());
                    hatch.AppendLoop(HatchLoopTypes.Default, vertices, bulges);
                }
                else
                {
                    // First boundary is the outer loop; the rest become islands/inner loops.
                    for (int i = 0; i < boundaryIds.Count; i++)
                        hatch.AppendLoop(i == 0 ? HatchLoopTypes.Outermost : HatchLoopTypes.Default, new ObjectIdCollection(new[] { boundaryIds[i] }));
                }
                hatch.EvaluateHatch(true);
                return Describe.Entity(tr, hatch, false);
            });
        }

        [McpCommand("add_dimension")]
        public static object AddDimension(CommandContext c)
        {
            var kind = c.Get("kind", "aligned");
            var p1 = Geo.Point(c, "point1");
            var p2 = Geo.Point(c, "point2");
            var dimLine = Geo.Point(c, "dimLinePoint");
            var text = c.Get("textOverride", "");

            return c.Write(tr =>
            {
                var styleId = Symbols.DimStyle(tr, c.Db, c.Get<string>("dimStyle"));
                Dimension dim;
                if (kind.Equals("linear", StringComparison.OrdinalIgnoreCase))
                    dim = new RotatedDimension(Geo.Rad(c.Get("rotation", 0.0)), p1, p2, dimLine, text, styleId);
                else if (kind.Equals("aligned", StringComparison.OrdinalIgnoreCase))
                    dim = new AlignedDimension(p1, p2, dimLine, text, styleId);
                else
                    throw new McpException($"Unknown dimension kind '{kind}'. Use 'aligned' or 'linear'.");
                Spaces.Add(c, tr, dim);
                dim.DimensionStyle = styleId;
                return Describe.Entity(tr, dim, false);
            });
        }

        [McpCommand("insert_block")]
        public static object InsertBlock(CommandContext c)
        {
            var db = c.Db;
            var name = c.Require<string>("name");
            var position = Geo.Point(c, "position");
            var scale = c.Get("scale", 1.0);
            var rotation = Geo.Rad(c.Get("rotation", 0.0));
            var values = c.Get<Dictionary<string, string>>("attributes") ?? new Dictionary<string, string>();
            values = new Dictionary<string, string>(values, StringComparer.OrdinalIgnoreCase);
            var sourceFile = c.Get<string>("sourceFile");

            var exists = c.Read(tr => !Symbols.Block(tr, db, name).IsNull);
            if (!exists)
            {
                if (string.IsNullOrEmpty(sourceFile))
                    throw new McpException($"No block named '{name}' in this drawing. Use list_blocks, or pass sourceFile to import it from a .dwg.");
                ImportBlock(c, name, sourceFile);
            }

            return c.Write(tr =>
            {
                var btrId = Symbols.Block(tr, db, name);
                var btr = (BlockTableRecord)tr.GetObject(btrId, OpenMode.ForRead);
                if (btr.IsLayout) throw new McpException($"'{name}' is a layout, not a block.");

                var br = new BlockReference(position, btrId) { ScaleFactors = new Scale3d(scale), Rotation = rotation };
                Spaces.Add(c, tr, br);

                var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                if (btr.HasAttributeDefinitions)
                {
                    foreach (ObjectId id in btr)
                    {
                        if (!(tr.GetObject(id, OpenMode.ForRead) is AttributeDefinition ad) || ad.Constant) continue;
                        var ar = new AttributeReference();
                        ar.SetAttributeFromBlock(ad, br.BlockTransform);
                        if (values.TryGetValue(ad.Tag, out var value))
                        {
                            ar.TextString = value;
                            used.Add(ad.Tag);
                        }
                        if (ad.Justify != AttachmentPoint.BaseLeft) ar.AdjustAlignment(db);
                        br.AttributeCollection.AppendAttribute(ar);
                        tr.AddNewlyCreatedDBObject(ar, true);
                    }
                }

                var result = Describe.Entity(tr, br, false);
                var unknown = values.Keys.Where(k => !used.Contains(k)).ToList();
                if (unknown.Count > 0) result["unknownAttributeTags"] = unknown;
                return result;
            });
        }

        /// <summary>Copies block <paramref name="name"/> from a .dwg, or inserts the whole file as that block.</summary>
        private static void ImportBlock(CommandContext c, string name, string path)
        {
            if (!File.Exists(path)) throw new McpException($"File not found: {path}");
            Symbols.Validate(name, "block");
            using (c.Doc.LockDocument())
            using (var source = new Database(false, true))
            {
                source.ReadDwgFile(path, FileShare.Read, true, "");
                source.CloseInput(true);

                ObjectId sourceId;
                using (var str = source.TransactionManager.StartTransaction())
                {
                    sourceId = Symbols.Block(str, source, name);
                    str.Commit();
                }

                if (!sourceId.IsNull)
                {
                    var mapping = new IdMapping();
                    source.WblockCloneObjects(new ObjectIdCollection(new[] { sourceId }), c.Db.BlockTableId, mapping, DuplicateRecordCloning.Ignore, false);
                }
                else
                {
                    c.Db.Insert(name, source, true);
                }
            }
        }

        [McpCommand("create_block")]
        public static object CreateBlock(CommandContext c)
        {
            var db = c.Db;
            var name = c.Require<string>("name");
            Symbols.Validate(name, "block");
            var ids = c.RequireIds();
            var basePoint = Geo.Point(c, "basePoint");
            var keep = c.Get("keepOriginals", false);

            return c.Write(tr =>
            {
                if (!Symbols.Block(tr, db, name).IsNull) throw new McpException($"A block named '{name}' already exists.");
                var owners = ids.Select(id => tr.GetObject(id, OpenMode.ForRead).OwnerId).Distinct().ToList();
                if (owners.Count != 1) throw new McpException("All entities must be in the same space.");

                var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForWrite);
                var btr = new BlockTableRecord { Name = name, Origin = basePoint };
                var btrId = table.Add(btr);
                tr.AddNewlyCreatedDBObject(btr, true);

                var mapping = new IdMapping();
                db.DeepCloneObjects(new ObjectIdCollection(ids.ToArray()), btrId, mapping, false);

                object reference = null;
                if (!keep)
                {
                    foreach (var id in ids) tr.GetObject(id, OpenMode.ForWrite).Erase();
                    var space = (BlockTableRecord)tr.GetObject(owners[0], OpenMode.ForWrite);
                    var br = new BlockReference(basePoint, btrId);
                    br.SetDatabaseDefaults(db);
                    space.AppendEntity(br);
                    tr.AddNewlyCreatedDBObject(br, true);
                    reference = Describe.Entity(tr, br, false);
                }
                return new { block = name, entityCount = ids.Count, reference };
            });
        }
    }
}
