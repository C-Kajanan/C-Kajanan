using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Newtonsoft.Json.Linq;

namespace AutoCadMcp.Commands
{
    /// <summary>Commands that change, transform, select or remove existing entities, and layer management.</summary>
    internal static class EditCommands
    {
        [McpCommand("set_entity_properties")]
        public static object SetEntityProperties(CommandContext c)
        {
            var ids = c.RequireIds();
            var layer = c.Get<string>("layer");
            var color = c.Token("color");
            var linetype = c.Get<string>("linetype");
            var ltScale = c.Get<double?>("linetypeScale");
            var lineweight = c.Get<int?>("lineweight");
            var text = c.Get<string>("text");

            return c.Write(tr =>
            {
                var layerId = string.IsNullOrEmpty(layer) ? ObjectId.Null : Symbols.Layer(tr, c.Db, layer);
                var parsedColor = color == null ? null : Colors.Parse(color);
                var linetypeId = string.IsNullOrEmpty(linetype) ? ObjectId.Null : Symbols.Linetype(tr, c.Db, linetype);
                var textSkipped = new List<string>();

                foreach (var id in ids)
                {
                    var e = (Entity)tr.GetObject(id, OpenMode.ForWrite);
                    if (!layerId.IsNull) e.LayerId = layerId;
                    if (parsedColor != null) e.Color = parsedColor;
                    if (!linetypeId.IsNull) e.LinetypeId = linetypeId;
                    if (ltScale != null) e.LinetypeScale = ltScale.Value;
                    if (lineweight != null) e.LineWeight = (LineWeight)lineweight.Value;
                    if (text != null)
                    {
                        switch (e)
                        {
                            case DBText t: t.TextString = text; break;
                            case MText m: m.Contents = text.Replace("\r\n", "\\P").Replace("\n", "\\P"); break;
                            case Dimension d: d.DimensionText = text; break;
                            default: textSkipped.Add(e.Handle.ToString()); break;
                        }
                    }
                }
                return new { updated = ids.Count, textNotApplicable = textSkipped.Count > 0 ? textSkipped : null };
            });
        }

        [McpCommand("set_block_attributes")]
        public static object SetBlockAttributes(CommandContext c)
        {
            var id = c.IdOf(c.Require<string>("handle"));
            var values = new Dictionary<string, string>(c.Require<Dictionary<string, string>>("attributes"), StringComparer.OrdinalIgnoreCase);
            return c.Write(tr =>
            {
                if (!(tr.GetObject(id, OpenMode.ForRead) is BlockReference br))
                    throw new McpException($"Handle {id.Handle} is not a block reference.");
                var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (ObjectId attId in br.AttributeCollection)
                {
                    var ar = (AttributeReference)tr.GetObject(attId, OpenMode.ForRead);
                    if (!values.TryGetValue(ar.Tag, out var value)) continue;
                    ar.UpgradeOpen();
                    ar.TextString = value;
                    set.Add(ar.Tag);
                }
                var unknown = values.Keys.Where(k => !set.Contains(k)).ToList();
                return new { handle = br.Handle.ToString(), attributes = Describe.Attributes(tr, br), unknownTags = unknown.Count > 0 ? unknown : null };
            });
        }

        private static object Transform(CommandContext c, Matrix3d matrix)
        {
            var ids = c.RequireIds();
            return c.Write(tr =>
            {
                foreach (var id in ids) ((Entity)tr.GetObject(id, OpenMode.ForWrite)).TransformBy(matrix);
                return new { transformed = ids.Count, handles = ids.Select(Describe.Handle).ToList() };
            });
        }

        [McpCommand("move_entities")]
        public static object Move(CommandContext c) => Transform(c, Matrix3d.Displacement(Geo.Vector(c, "displacement")));

        [McpCommand("rotate_entities")]
        public static object Rotate(CommandContext c) =>
            Transform(c, Matrix3d.Rotation(Geo.Rad(c.Require<double>("angle")), Vector3d.ZAxis, Geo.Point(c, "basePoint")));

        [McpCommand("scale_entities")]
        public static object Scale(CommandContext c)
        {
            var factor = c.Require<double>("factor");
            if (factor <= 0) throw new McpException("factor must be positive.");
            return Transform(c, Matrix3d.Scaling(factor, Geo.Point(c, "basePoint")));
        }

        /// <summary>Deep-clones entities into their own space (keeps attributes, xdata, etc.).</summary>
        private static List<ObjectId> Clone(CommandContext c, Transaction tr, List<ObjectId> ids)
        {
            var result = new List<ObjectId>();
            foreach (var group in ids.GroupBy(id => tr.GetObject(id, OpenMode.ForRead).OwnerId))
            {
                var mapping = new IdMapping();
                var source = group.ToList();
                c.Db.DeepCloneObjects(new ObjectIdCollection(source.ToArray()), group.Key, mapping, false);
                foreach (var id in source)
                {
                    var pair = mapping[id];
                    if (pair.IsCloned) result.Add(pair.Value);
                }
            }
            return result;
        }

        [McpCommand("copy_entities")]
        public static object Copy(CommandContext c)
        {
            var ids = c.RequireIds();
            var displacement = Geo.Vector(c, "displacement");
            var count = Math.Max(1, Math.Min(1000, c.Get("count", 1)));
            return c.Write(tr =>
            {
                var created = new List<string>();
                for (int i = 1; i <= count; i++)
                {
                    var matrix = Matrix3d.Displacement(displacement * i);
                    foreach (var id in Clone(c, tr, ids))
                    {
                        ((Entity)tr.GetObject(id, OpenMode.ForWrite)).TransformBy(matrix);
                        created.Add(Describe.Handle(id));
                    }
                }
                return new { created = created.Count, handles = created };
            });
        }

        [McpCommand("mirror_entities")]
        public static object Mirror(CommandContext c)
        {
            var ids = c.RequireIds();
            var p1 = Geo.Point(c, "point1");
            var p2 = Geo.Point(c, "point2");
            if (p1.IsEqualTo(p2)) throw new McpException("point1 and point2 must differ.");
            var keep = c.Get("keepOriginals", true);
            var matrix = Matrix3d.Mirroring(new Line3d(p1, p2));
            return c.Write(tr =>
            {
                var targets = keep ? Clone(c, tr, ids) : ids;
                foreach (var id in targets) ((Entity)tr.GetObject(id, OpenMode.ForWrite)).TransformBy(matrix);
                return new { mirrored = targets.Count, handles = targets.Select(Describe.Handle).ToList() };
            });
        }

        [McpCommand("offset_entity")]
        public static object Offset(CommandContext c)
        {
            var id = c.IdOf(c.Require<string>("handle"));
            var distance = c.Require<double>("distance");
            return c.Write(tr =>
            {
                if (!(tr.GetObject(id, OpenMode.ForRead) is Curve curve))
                    throw new McpException($"Handle {id.Handle} is a {id.ObjectClass.DxfName}, which can't be offset.");
                var space = (BlockTableRecord)tr.GetObject(curve.OwnerId, OpenMode.ForWrite);
                var created = new List<object>();
                foreach (DBObject obj in curve.GetOffsetCurves(distance))
                {
                    if (!(obj is Entity e)) { obj.Dispose(); continue; }
                    space.AppendEntity(e);
                    tr.AddNewlyCreatedDBObject(e, true);
                    created.Add(Describe.Entity(tr, e, false));
                }
                return new { created };
            });
        }

        [McpCommand("erase_entities")]
        public static object Erase(CommandContext c)
        {
            var ids = c.RequireIds();
            return c.Write(tr =>
            {
                foreach (var id in ids) tr.GetObject(id, OpenMode.ForWrite).Erase();
                return new { erased = ids.Count };
            });
        }

        [McpCommand("create_layer")]
        public static object CreateLayer(CommandContext c)
        {
            var db = c.Db;
            var name = c.Require<string>("name");
            return c.Write(tr =>
            {
                var table = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                var existed = table.Has(name);
                var id = Symbols.Layer(tr, db, name);
                var layer = (LayerTableRecord)tr.GetObject(id, OpenMode.ForWrite);
                if (c.Token("color") is JToken color) layer.Color = Colors.Parse(color);
                if (c.Get<string>("linetype") is string lt) layer.LinetypeObjectId = Symbols.Linetype(tr, db, lt);
                if (c.Get<int?>("lineweight") is int lw) layer.LineWeight = (LineWeight)lw;
                if (c.Get<string>("description") is string desc) layer.Description = desc;
                if (c.Get<bool?>("plottable") is bool plot) layer.IsPlottable = plot;
                if (c.Get("makeCurrent", false))
                {
                    if (layer.IsFrozen) layer.IsFrozen = false;
                    db.Clayer = id;
                }
                return new { name = layer.Name, created = !existed, current = db.Clayer == id };
            });
        }

        [McpCommand("set_layer")]
        public static object SetLayer(CommandContext c)
        {
            var db = c.Db;
            var name = c.Require<string>("name");
            var needsRegen = false;
            var result = c.Write(tr =>
            {
                var id = Symbols.Layer(tr, db, name, create: false);
                var layer = (LayerTableRecord)tr.GetObject(id, OpenMode.ForWrite);
                if (c.Get<bool?>("makeCurrent") == true)
                {
                    if (layer.IsFrozen && c.Get<bool?>("frozen") != false) throw new McpException("A frozen layer can't be made current. Pass frozen=false too.");
                    if (c.Get<bool?>("frozen") == false) layer.IsFrozen = false;
                    db.Clayer = id;
                }
                if (c.Get<bool?>("on") is bool on) layer.IsOff = !on;
                if (c.Get<bool?>("frozen") is bool frozen && layer.IsFrozen != frozen)
                {
                    if (frozen && db.Clayer == id) throw new McpException("The current layer can't be frozen. Make another layer current first.");
                    layer.IsFrozen = frozen;
                    needsRegen = true;
                }
                if (c.Get<bool?>("locked") is bool locked) layer.IsLocked = locked;
                if (c.Token("color") is JToken color) layer.Color = Colors.Parse(color);
                if (c.Get<string>("newName") is string newName && newName != layer.Name)
                {
                    if (id == db.LayerZero) throw new McpException("Layer 0 can't be renamed.");
                    Symbols.Validate(newName, "layer");
                    var table = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                    if (table.Has(newName)) throw new McpException($"A layer named '{newName}' already exists.");
                    layer.Name = newName;
                }
                return new { name = layer.Name, current = db.Clayer == id, on = !layer.IsOff, frozen = layer.IsFrozen, locked = layer.IsLocked, color = Colors.Json(layer.Color) };
            });
            if (needsRegen) try { c.Ed.Regen(); } catch { }
            return result;
        }

        [McpCommand("load_linetype")]
        public static object LoadLinetype(CommandContext c)
        {
            var db = c.Db;
            var name = c.Require<string>("name");
            var already = c.Read(tr => ((LinetypeTable)tr.GetObject(db.LinetypeTableId, OpenMode.ForRead)).Has(name));
            if (already) return new { name, loaded = true, alreadyLoaded = true };
            var file = c.Get<string>("file") ?? (db.Measurement == MeasurementValue.Metric ? "acadiso.lin" : "acad.lin");
            using (c.Doc.LockDocument())
            {
                try { db.LoadLineTypeFile(name, file); }
                catch (Autodesk.AutoCAD.Runtime.Exception ex)
                {
                    throw new McpException($"Could not load linetype '{name}' from {file}: {ex.ErrorStatus}.");
                }
            }
            return new { name, loaded = true, file };
        }

        [McpCommand("select_entities")]
        public static object Select(CommandContext c)
        {
            var ids = c.RequireIds();
            c.Ed.SetImpliedSelection(ids.ToArray());
            if (c.Get("zoom", true))
            {
                var ext = c.Read(tr => Views.Union(ids.Select(id => (Entity)tr.GetObject(id, OpenMode.ForRead))));
                if (ext != null) Views.ZoomTo(c.Ed, ext.Value, 0.15);
            }
            return new { selected = ids.Count };
        }

        [McpCommand("zoom")]
        public static object Zoom(CommandContext c)
        {
            var db = c.Db;
            var margin = c.Get("margin", 0.05);
            Extents3d? target;
            var handles = c.Get<List<string>>("handles");
            if (c.Token("window") is JToken window)
            {
                target = Geo.Window(window);
            }
            else if (handles != null && handles.Count > 0)
            {
                var ids = handles.Select(c.IdOf).ToList();
                target = c.Read(tr => Views.Union(ids.Select(id => (Entity)tr.GetObject(id, OpenMode.ForRead))));
            }
            else
            {
                target = c.Read(tr =>
                {
                    var space = Spaces.Current(tr, db, OpenMode.ForRead);
                    return Views.Union(space.Cast<ObjectId>().Select(id => (Entity)tr.GetObject(id, OpenMode.ForRead)).Where(e => e.Visible));
                });
            }
            if (target == null) return new { zoomed = false, reason = "Nothing to zoom to." };
            using (c.Doc.LockDocument()) Views.ZoomTo(c.Ed, target.Value, margin);
            return new { zoomed = true, extents = Geo.Json(target.Value) };
        }
    }
}
