using System;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.Runtime;
using Application = Autodesk.AutoCAD.ApplicationServices.Application;

[assembly: ExtensionApplication(typeof(AutoCadMcp.Plugin))]
[assembly: CommandClass(typeof(AutoCadMcp.PluginCommands))]

namespace AutoCadMcp
{
    /// <summary>
    /// Entry point. Starts the local bridge that the MCP server talks to and
    /// adds the MCPSTART / MCPSTOP / MCPSTATUS commands.
    /// </summary>
    public sealed class Plugin : IExtensionApplication
    {
        internal static McpBridge Bridge { get; private set; }

        internal static int Port =>
            int.TryParse(Environment.GetEnvironmentVariable("AUTOCAD_MCP_PORT"), out var p) ? p : 48885;

        public void Initialize()
        {
            // Initialize runs on AutoCAD's main thread, which the dispatcher needs.
            MainThread.Initialize();
            Bridge = new McpBridge();

            if (Environment.GetEnvironmentVariable("AUTOCAD_MCP_AUTOSTART") == "0") return;
            try
            {
                Bridge.Start(Port);
                Write($"\nAutoCAD MCP: listening on http://localhost:{Port}/ (MCPSTOP to stop).\n");
            }
            catch (System.Exception ex)
            {
                Write($"\nAutoCAD MCP: could not start on port {Port}: {ex.Message}\n");
            }
        }

        public void Terminate()
        {
            Bridge?.Stop();
        }

        internal static void Write(string message)
        {
            try { Application.DocumentManager.MdiActiveDocument?.Editor.WriteMessage(message); } catch { }
        }
    }

    public sealed class PluginCommands
    {
        [CommandMethod("MCPSTART", CommandFlags.Session)]
        public void Start()
        {
            if (Plugin.Bridge.IsRunning)
            {
                Plugin.Write($"\nAutoCAD MCP is already listening on port {Plugin.Port}.\n");
                return;
            }
            try
            {
                Plugin.Bridge.Start(Plugin.Port);
                Plugin.Write($"\nAutoCAD MCP: listening on http://localhost:{Plugin.Port}/\n");
            }
            catch (System.Exception ex)
            {
                Plugin.Write($"\nAutoCAD MCP: could not start on port {Plugin.Port}: {ex.Message}\n");
            }
        }

        [CommandMethod("MCPSTOP", CommandFlags.Session)]
        public void Stop()
        {
            Plugin.Bridge.Stop();
            Plugin.Write("\nAutoCAD MCP: stopped.\n");
        }

        [CommandMethod("MCPSTATUS", CommandFlags.Session)]
        public void Status()
        {
            Plugin.Write(Plugin.Bridge.IsRunning
                ? $"\nAutoCAD MCP: listening on http://localhost:{Plugin.Port}/\n"
                : "\nAutoCAD MCP: stopped. Type MCPSTART to start.\n");
        }
    }
}
