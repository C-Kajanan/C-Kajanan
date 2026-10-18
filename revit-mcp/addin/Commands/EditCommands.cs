using System;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMcp.Commands
{
    /// <summary>Commands that change, transform, select or remove existing elements.</summary>
    internal static class EditCommands
    {
        [McpCommand("set_parameter")]
        public static object SetParameter(CommandContext c)
        {
            var doc = c.Doc;
            var id = c.Require<long>("id");
            var name = c.Require<string>("parameterName");
            var value = c.Token("value") ?? throw new McpException("Missing required parameter 'value'.");
            var onType = c.Get("onType", false);

            var element = doc.GetElement(Ids.From(id)) ?? throw new McpException($"Element {id} does not exist.");
            if (onType)
                element = doc.GetElement(element.GetTypeId()) ?? throw new McpException($"Element {id} has no type.");

            var parameter = element.LookupParameter(name) ?? throw new McpException($"'{Describe.SafeName(element)}' has no parameter '{name}'.");
            if (parameter.IsReadOnly) throw new McpException($"Parameter '{name}' is read-only.");

            return c.Write("Set " + name, () =>
            {
                bool ok;
                switch (value.Type)
                {
                    case JTokenType.Boolean:
                        ok = parameter.Set(value.Value<bool>() ? 1 : 0);
                        break;
                    case JTokenType.Integer:
                    case JTokenType.Float:
                        ok = SetNumber(parameter, value.Value<double>());
                        break;
                    default:
                        ok = SetText(parameter, value.ToString());
                        break;
                }
                if (!ok) throw new McpException($"Revit rejected value '{value}' for '{name}'.");
                return new { id, parameter = name, value = Describe.Value(parameter) };
            });
        }

        private static bool SetNumber(Parameter p, double number)
        {
            switch (p.StorageType)
            {
                case StorageType.Double: return p.Set(number);
                case StorageType.Integer: return p.Set((int)Math.Round(number));
                case StorageType.ElementId: return p.Set(Ids.From((long)number));
                case StorageType.String: return p.Set(number.ToString(System.Globalization.CultureInfo.InvariantCulture));
                default: return false;
            }
        }

        private static bool SetText(Parameter p, string text)
        {
            switch (p.StorageType)
            {
                case StorageType.String:
                    return p.Set(text);
                case StorageType.ElementId:
                    return long.TryParse(text, out var id) && p.Set(Ids.From(id));
                default:
                    // Parsed in project display units, e.g. "3000", "3 m", "45°", "Yes".
                    return p.SetValueString(text);
            }
        }

        [McpCommand("move_elements")]
        public static object Move(CommandContext c)
        {
            var ids = c.RequireIds();
            var vector = Units.Point(c.Require<JObject>("vector"));
            return c.Write("Move", () =>
            {
                ElementTransformUtils.MoveElements(c.Doc, ids, vector);
                return new { moved = ids.Select(Ids.Of) };
            });
        }

        [McpCommand("rotate_elements")]
        public static object Rotate(CommandContext c)
        {
            var ids = c.RequireIds();
            var center = Units.Point(c.Require<JObject>("center"));
            var angle = Units.Radians(c.Require<double>("angle"));
            return c.Write("Rotate", () =>
            {
                ElementTransformUtils.RotateElements(c.Doc, ids, Line.CreateBound(center, center + XYZ.BasisZ), angle);
                return new { rotated = ids.Select(Ids.Of) };
            });
        }

        [McpCommand("copy_elements")]
        public static object Copy(CommandContext c)
        {
            var ids = c.RequireIds();
            var vector = Units.Point(c.Require<JObject>("vector"));
            return c.Write("Copy", () =>
                new { newIds = ElementTransformUtils.CopyElements(c.Doc, ids, vector).Select(Ids.Of).ToList() });
        }

        [McpCommand("delete_elements")]
        public static object Delete(CommandContext c)
        {
            var ids = c.RequireIds();
            return c.Write("Delete", () => new { deletedIds = c.Doc.Delete(ids).Select(Ids.Of).ToList() });
        }

        [McpCommand("select_elements")]
        public static object Select(CommandContext c)
        {
            var ids = c.Require<long[]>("ids").Select(Ids.From).Where(id => c.Doc.GetElement(id) != null).ToList();
            c.UiDoc.Selection.SetElementIds(ids);
            if (c.Get("zoom", true) && ids.Count > 0) c.UiDoc.ShowElements(ids);
            return new { selected = ids.Select(Ids.Of) };
        }

        [McpCommand("color_elements")]
        public static object ColorElements(CommandContext c)
        {
            var doc = c.Doc;
            var ids = c.RequireIds();
            var view = Lookup.View(c);
            var reset = c.Get("reset", false);
            var rgb = c.Get<JObject>("color") ?? new JObject { ["r"] = 255, ["g"] = 0, ["b"] = 0 };
            var color = new Color((byte)rgb.Value<int>("r"), (byte)rgb.Value<int>("g"), (byte)rgb.Value<int>("b"));

            var solidFill = new FilteredElementCollector(doc).OfClass(typeof(FillPatternElement)).Cast<FillPatternElement>()
                .FirstOrDefault(f => f.GetFillPattern().IsSolidFill);

            return c.Write(reset ? "Reset colors" : "Color elements", () =>
            {
                var overrides = new OverrideGraphicSettings();
                if (!reset)
                {
                    overrides.SetProjectionLineColor(color);
                    overrides.SetCutLineColor(color);
                    if (solidFill != null)
                    {
                        overrides.SetSurfaceForegroundPatternId(solidFill.Id);
                        overrides.SetSurfaceForegroundPatternColor(color);
                        overrides.SetCutForegroundPatternId(solidFill.Id);
                        overrides.SetCutForegroundPatternColor(color);
                    }
                }
                foreach (var id in ids) view.SetElementOverrides(id, overrides);
                return new { view = view.Name, count = ids.Count, reset };
            });
        }
    }
}
