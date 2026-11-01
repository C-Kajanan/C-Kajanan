using System;
using System.IO;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Application = Autodesk.AutoCAD.ApplicationServices.Application;

namespace AutoCadMcp.Commands
{
    /// <summary>Open, create and save drawings, and run raw AutoCAD commands.</summary>
    internal static class DocumentCommands
    {
        [McpCommand("open_drawing")]
        public static object Open(CommandContext c)
        {
            var path = Path.GetFullPath(c.Require<string>("path"));
            if (!File.Exists(path)) throw new McpException($"File not found: {path}");
            var manager = Application.DocumentManager;

            foreach (Document open in manager)
            {
                if (string.Equals(open.Name, path, StringComparison.OrdinalIgnoreCase))
                {
                    manager.MdiActiveDocument = open;
                    return new { name = Path.GetFileName(path), path, alreadyOpen = true };
                }
            }

            var doc = manager.Open(path, c.Get("readOnly", false));
            manager.MdiActiveDocument = doc;
            return new { name = Path.GetFileName(doc.Name), path = doc.Name, readOnly = doc.IsReadOnly };
        }

        [McpCommand("new_drawing")]
        public static object New(CommandContext c)
        {
            var template = c.Get<string>("template");
            if (string.IsNullOrEmpty(template))
                template = Convert.ToInt32(Application.GetSystemVariable("MEASUREINIT")) == 1 ? "acadiso.dwt" : "acad.dwt";
            var manager = Application.DocumentManager;
            var doc = manager.Add(template);
            manager.MdiActiveDocument = doc;
            return new { name = doc.Name, template };
        }

        [McpCommand("save_drawing")]
        public static object Save(CommandContext c)
        {
            var doc = c.Doc;
            var db = c.Db;
            var format = c.Get("format", "dwg").ToLowerInvariant();
            var path = c.Get<string>("path");

            if (string.IsNullOrEmpty(path))
            {
                if (!doc.IsNamedDrawing) throw new McpException("This drawing has never been saved. Pass a path.");
                if (doc.IsReadOnly) throw new McpException("The drawing is open read-only. Pass a path to save a copy.");
                if (format == "dxf") throw new McpException("Pass a path to export DXF.");
                path = db.Filename;
                using (doc.LockDocument()) db.SaveAs(path, true, DwgVersion.Current, db.SecurityParameters);
                return new { saved = path, format };
            }

            path = Path.GetFullPath(path);
            var extension = format == "dxf" ? ".dxf" : ".dwg";
            if (!path.EndsWith(extension, StringComparison.OrdinalIgnoreCase)) path += extension;
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

            using (doc.LockDocument())
            {
                if (format == "dxf") db.DxfOut(path, 16, DwgVersion.Current);
                else db.SaveAs(path, DwgVersion.Current);
            }
            return new { saved = path, format };
        }

        [McpCommand("run_command")]
        public static object RunCommand(CommandContext c)
        {
            var command = c.Require<string>("command").TrimEnd();
            if (command.Length == 0) throw new McpException("Empty command.");
            // Queued: AutoCAD runs it after this request returns.
            c.Doc.SendStringToExecute(command + "\n", true, false, true);
            return new { queued = command, note = "The command runs asynchronously. Query the drawing to see its effect." };
        }
    }
}
