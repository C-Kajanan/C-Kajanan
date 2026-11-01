using System;
using System.Collections.Generic;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Newtonsoft.Json.Linq;
using Application = Autodesk.AutoCAD.ApplicationServices.Application;

namespace AutoCadMcp.Commands
{
    /// <summary>Read-only commands.</summary>
    internal static class QueryCommands
    {
        [McpCommand("ping")]
        public static object Ping(CommandContext c)
        {
            var doc = Application.DocumentManager.MdiActiveDocument;
            return new
            {
                product = Application.GetSystemVariable("PRODUCT")?.ToString(),
                version = Application.GetSystemVariable("ACADVER")?.ToString(),
                plugin = typeof(QueryCommands).Assembly.GetName().Version.ToString(3),
                drawingOpen = doc != null,
                activeDrawing = doc?.Name,
            };
        }

        [McpCommand("list_drawings")]
        public static object ListDrawings(CommandContext c)
        {
            var active = Application.DocumentManager.MdiActiveDocument;
            var list = new List<object>();
            foreach (Document doc in Application.DocumentManager)
            {
                list.Add(new
                {
                    name = Path.GetFileName(doc.Name),
                    path = doc.IsNamedDrawing ? doc.Name : null,
                    active = doc == active,
                    readOnly = doc.IsReadOnly,
                    saved = doc.IsNamedDrawing,
                    unsavedChanges = doc == active ? Convert.ToInt32(Application.GetSystemVariable("DBMOD")) != 0 : (bool?)null,
                });
            }
            return list;
        }

        [McpCommand("get_drawing_info")]
        public static object GetDrawingInfo(CommandContext c)
        {
            var doc = c.Doc;
            var db = c.Db;
            return c.Read(tr =>
            {
                var blocks = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                var model = (BlockTableRecord)tr.GetObject(blocks[BlockTableRecord.ModelSpace], OpenMode.ForRead);
                var counts = new SortedDictionary<string, int>();
                int total = 0;
                foreach (ObjectId id in model)
                {
                    var type = id.ObjectClass.DxfName;
                    counts[type] = counts.TryGetValue(type, out var n) ? n + 1 : 1;
                    total++;
                }

                int blockCount = 0;
                foreach (ObjectId id in blocks)
                {
                    var btr = (BlockTableRecord)tr.GetObject(id, OpenMode.ForRead);
                    if (!btr.IsLayout && !btr.IsAnonymous) blockCount++;
                }
                var layers = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                var layouts = (DBDictionary)tr.GetObject(db.LayoutDictionaryId, OpenMode.ForRead);
                var currentLayer = (LayerTableRecord)tr.GetObject(db.Clayer, OpenMode.ForRead);
                var currentSpace = (BlockTableRecord)tr.GetObject(db.CurrentSpaceId, OpenMode.ForRead);

                object extents = null;
                if (total > 0)
                {
                    try
                    {
                        db.UpdateExt(true);
                        extents = new { min = Geo.Json(db.Extmin), max = Geo.Json(db.Extmax) };
                    }
                    catch { }
                }

                return new
                {
                    name = Path.GetFileName(doc.Name),
                    path = doc.IsNamedDrawing ? doc.Name : null,
                    readOnly = doc.IsReadOnly,
                    unsavedChanges = Convert.ToInt32(Application.GetSystemVariable("DBMOD")) != 0,
                    insertionUnits = db.Insunits.ToString(),
                    measurement = db.Measurement.ToString(),
                    extents,
                    currentLayer = currentLayer.Name,
                    currentLayout = LayoutManager.Current.CurrentLayout,
                    currentSpace = currentSpace.Name == BlockTableRecord.ModelSpace ? "model" : "paper",
                    textSize = db.Textsize,
                    dimScale = db.Dimscale,
                    linetypeScale = db.Ltscale,
                    layerCount = layers.Cast<ObjectId>().Count(),
                    blockCount,
                    layoutCount = layouts.Count,
                    modelSpaceEntityCount = total,
                    modelSpaceEntitiesByType = counts,
                };
            });
        }

        [McpCommand("list_layers")]
        public static object ListLayers(CommandContext c)
        {
            var db = c.Db;
            return c.Read(tr =>
            {
                var perLayer = new Dictionary<ObjectId, int>();
                var blocks = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                var model = (BlockTableRecord)tr.GetObject(blocks[BlockTableRecord.ModelSpace], OpenMode.ForRead);
                foreach (ObjectId id in model)
                {
                    var layerId = ((Entity)tr.GetObject(id, OpenMode.ForRead)).LayerId;
                    perLayer[layerId] = perLayer.TryGetValue(layerId, out var n) ? n + 1 : 1;
                }

                var list = new List<object>();
                var table = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                foreach (ObjectId id in table)
                {
                    var layer = (LayerTableRecord)tr.GetObject(id, OpenMode.ForRead);
                    var linetype = (LinetypeTableRecord)tr.GetObject(layer.LinetypeObjectId, OpenMode.ForRead);
                    list.Add(new
                    {
                        name = layer.Name,
                        current = id == db.Clayer,
                        on = !layer.IsOff,
                        frozen = layer.IsFrozen,
                        locked = layer.IsLocked,
                        color = Colors.Json(layer.Color),
                        linetype = linetype.Name,
                        lineweight = (int)layer.LineWeight,
                        plottable = layer.IsPlottable,
                        description = string.IsNullOrEmpty(layer.Description) ? null : layer.Description,
                        xref = layer.IsDependent,
                        modelSpaceEntities = perLayer.TryGetValue(id, out var count) ? count : 0,
                    });
                }
                return list;
            });
        }

        [McpCommand("list_blocks")]
        public static object ListBlocks(CommandContext c)
        {
            var db = c.Db;
            var filter = c.Get<string>("nameContains");
            return c.Read(tr =>
            {
                var list = new List<object>();
                var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                foreach (ObjectId id in table)
                {
                    var btr = (BlockTableRecord)tr.GetObject(id, OpenMode.ForRead);
                    if (btr.IsLayout || btr.IsAnonymous) continue;
                    if (!string.IsNullOrEmpty(filter) && btr.Name.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) continue;

                    int entityCount = 0;
                    var tags = new List<string>();
                    foreach (ObjectId child in btr)
                    {
                        entityCount++;
                        if (child.ObjectClass.DxfName == "ATTDEF" && tr.GetObject(child, OpenMode.ForRead) is AttributeDefinition ad && !ad.Constant)
                            tags.Add(ad.Tag);
                    }

                    int inserts = btr.GetBlockReferenceIds(true, false).Count;
                    if (btr.IsDynamicBlock)
                        foreach (ObjectId anon in btr.GetAnonymousBlockIds())
                            inserts += ((BlockTableRecord)tr.GetObject(anon, OpenMode.ForRead)).GetBlockReferenceIds(true, false).Count;

                    list.Add(new
                    {
                        name = btr.Name,
                        entityCount,
                        attributeTags = tags,
                        insertCount = inserts,
                        dynamic = btr.IsDynamicBlock,
                        xref = btr.IsFromExternalReference,
                        xrefPath = btr.IsFromExternalReference ? btr.PathName : null,
                        origin = Geo.Json(btr.Origin),
                        description = string.IsNullOrEmpty(btr.Comments) ? null : btr.Comments,
                    });
                }
                return list;
            });
        }

        [McpCommand("list_layouts")]
        public static object ListLayouts(CommandContext c)
        {
            var db = c.Db;
            var current = LayoutManager.Current.CurrentLayout;
            return c.Read(tr =>
            {
                var list = new List<(int order, object row)>();
                var layouts = (DBDictionary)tr.GetObject(db.LayoutDictionaryId, OpenMode.ForRead);
                foreach (DBDictionaryEntry entry in layouts)
                {
                    var layout = (Layout)tr.GetObject(entry.Value, OpenMode.ForRead);
                    var space = (BlockTableRecord)tr.GetObject(layout.BlockTableRecordId, OpenMode.ForRead);
                    list.Add((layout.TabOrder, new
                    {
                        name = layout.LayoutName,
                        model = layout.ModelType,
                        current = string.Equals(layout.LayoutName, current, StringComparison.OrdinalIgnoreCase),
                        tabOrder = layout.TabOrder,
                        entityCount = space.Cast<ObjectId>().Count(),
                        paperSize = layout.CanonicalMediaName,
                        plotter = layout.PlotConfigurationName,
                    }));
                }
                return list.OrderBy(x => x.order).Select(x => x.row).ToList();
            });
        }

        [McpCommand("list_styles")]
        public static object ListStyles(CommandContext c)
        {
            var db = c.Db;
            return c.Read(tr =>
            {
                var textStyles = new List<object>();
                foreach (ObjectId id in (TextStyleTable)tr.GetObject(db.TextStyleTableId, OpenMode.ForRead))
                {
                    var s = (TextStyleTableRecord)tr.GetObject(id, OpenMode.ForRead);
                    if (s.IsShapeFile) continue;
                    textStyles.Add(new { name = s.Name, current = id == db.Textstyle, font = string.IsNullOrEmpty(s.FileName) ? s.Font.TypeFace : s.FileName, height = s.TextSize });
                }

                var dimStyles = new List<object>();
                foreach (ObjectId id in (DimStyleTable)tr.GetObject(db.DimStyleTableId, OpenMode.ForRead))
                {
                    var s = (DimStyleTableRecord)tr.GetObject(id, OpenMode.ForRead);
                    dimStyles.Add(new { name = s.Name, current = id == db.Dimstyle, textHeight = s.Dimtxt, scale = s.Dimscale, arrowSize = s.Dimasz });
                }

                var linetypes = new List<object>();
                foreach (ObjectId id in (LinetypeTable)tr.GetObject(db.LinetypeTableId, OpenMode.ForRead))
                {
                    var s = (LinetypeTableRecord)tr.GetObject(id, OpenMode.ForRead);
                    linetypes.Add(new { name = s.Name, current = id == db.Celtype, description = s.AsciiDescription });
                }

                return new { textStyles, dimStyles, linetypes };
            });
        }

        [McpCommand("query_entities")]
        public static object QueryEntities(CommandContext c)
        {
            var db = c.Db;
            var types = c.Get<List<string>>("types")?.Select(t => t.Trim().ToUpperInvariant()).ToHashSet();
            var layer = c.Get<string>("layer");
            var blockName = c.Get<string>("blockName");
            var text = c.Get<string>("textContains");
            var window = c.Token("window") is JToken w ? Geo.Window(w) : (Autodesk.AutoCAD.DatabaseServices.Extents3d?)null;
            var details = c.Get("includeDetails", false);
            var limit = c.Get("limit", 500);
            if (blockName != null) types = new HashSet<string> { "INSERT" };

            return c.Read(tr =>
            {
                var space = Spaces.Named(tr, db, c.Get("space", "model"));
                var results = new List<object>();
                int matched = 0;
                foreach (ObjectId id in space)
                {
                    if (types != null && !types.Contains(id.ObjectClass.DxfName)) continue;
                    var e = (Entity)tr.GetObject(id, OpenMode.ForRead);
                    if (!Wildcard.Match(e.Layer, layer)) continue;
                    if (blockName != null && !(e is BlockReference br && Wildcard.Match(Describe.BlockName(tr, br), blockName))) continue;
                    if (text != null && !Describe.Texts(tr, e).Any(t => t != null && t.IndexOf(text, StringComparison.OrdinalIgnoreCase) >= 0)) continue;
                    if (window != null)
                    {
                        var ext = Geo.ExtentsOf(e);
                        if (ext == null || !Geo.Overlaps(ext.Value, window.Value)) continue;
                    }
                    matched++;
                    if (results.Count < limit) results.Add(Describe.Entity(tr, e, details));
                }
                return new { space = space.Name, matched, returned = results.Count, truncated = matched > results.Count, entities = results };
            });
        }

        [McpCommand("get_entity")]
        public static object GetEntity(CommandContext c)
        {
            var id = c.IdOf(c.Require<string>("handle"));
            return c.Read(tr =>
            {
                if (!(tr.GetObject(id, OpenMode.ForRead) is Entity e))
                    throw new McpException($"Handle {id.Handle} is a {id.ObjectClass.DxfName}, not an entity.");
                var d = Describe.Entity(tr, e, true);
                var owner = (BlockTableRecord)tr.GetObject(e.OwnerId, OpenMode.ForRead);
                d["space"] = owner.Name;
                return d;
            });
        }

        [McpCommand("get_selection")]
        public static object GetSelection(CommandContext c)
        {
            var details = c.Get("includeDetails", false);
            var selection = c.Ed.SelectImplied();
            if (selection.Status != PromptStatus.OK || selection.Value == null)
                return new { count = 0, entities = new object[0] };
            var ids = selection.Value.GetObjectIds();
            return c.Read(tr => new
            {
                count = ids.Length,
                entities = ids.Take(1000).Select(id => Describe.Entity(tr, (Entity)tr.GetObject(id, OpenMode.ForRead), details)).ToList(),
            });
        }

        [McpCommand("export_view_image")]
        public static object ExportViewImage(CommandContext c)
        {
            var doc = c.Doc;
            var width = (uint)Math.Max(128, Math.Min(4096, c.Get("width", 1600)));
            var height = (uint)Math.Max(128, Math.Min(4096, c.Get("height", 1000)));
            try { doc.Editor.UpdateScreen(); } catch { }
            using (var bitmap = doc.CapturePreviewImage(width, height))
            using (var stream = new MemoryStream())
            {
                if (bitmap == null) throw new McpException("AutoCAD could not capture the view.");
                bitmap.Save(stream, ImageFormat.Png);
                return new
                {
                    mimeType = "image/png",
                    base64 = Convert.ToBase64String(stream.ToArray()),
                    drawing = Path.GetFileName(doc.Name),
                    layout = LayoutManager.Current.CurrentLayout,
                    width,
                    height,
                };
            }
        }
    }
}
