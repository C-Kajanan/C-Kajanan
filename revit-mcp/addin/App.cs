using System;
using System.Reflection;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitMcp
{
    /// <summary>
    /// Entry point. Adds a "Revit MCP" panel to the Add-Ins tab and starts the
    /// local bridge that the MCP server talks to.
    /// </summary>
    public class App : IExternalApplication
    {
        internal static McpBridge Bridge { get; private set; }

        internal static int Port =>
            int.TryParse(Environment.GetEnvironmentVariable("REVIT_MCP_PORT"), out var p) ? p : 48884;

        public Result OnStartup(UIControlledApplication application)
        {
            Bridge = new McpBridge();

            var panel = application.CreateRibbonPanel("Revit MCP");
            var button = new PushButtonData(
                "RevitMcpToggle",
                "Start/Stop\nMCP",
                Assembly.GetExecutingAssembly().Location,
                typeof(ToggleServerCommand).FullName)
            {
                ToolTip = "Start or stop the local server that lets AI assistants (Claude, etc.) work with this Revit session.",
            };
            panel.AddItem(button);

            if (Environment.GetEnvironmentVariable("REVIT_MCP_AUTOSTART") != "0")
            {
                try
                {
                    Bridge.Start(Port);
                }
                catch (Exception ex)
                {
                    TaskDialog.Show("Revit MCP", $"Could not start the MCP bridge on port {Port}:\n{ex.Message}");
                }
            }

            return Result.Succeeded;
        }

        public Result OnShutdown(UIControlledApplication application)
        {
            Bridge?.Stop();
            return Result.Succeeded;
        }
    }

    [Transaction(TransactionMode.Manual)]
    public class ToggleServerCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            var bridge = App.Bridge;
            try
            {
                if (bridge.IsRunning)
                {
                    bridge.Stop();
                    TaskDialog.Show("Revit MCP", "MCP bridge stopped.");
                }
                else
                {
                    bridge.Start(App.Port);
                    TaskDialog.Show("Revit MCP", $"MCP bridge listening on http://localhost:{App.Port}/");
                }
                return Result.Succeeded;
            }
            catch (Exception ex)
            {
                message = ex.Message;
                return Result.Failed;
            }
        }
    }
}
