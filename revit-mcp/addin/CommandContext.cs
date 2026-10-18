using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RevitMcp
{
    /// <summary>Marks a static method <c>object M(CommandContext c)</c> as an MCP method.</summary>
    [AttributeUsage(AttributeTargets.Method)]
    internal sealed class McpCommandAttribute : Attribute
    {
        public McpCommandAttribute(string name) => Name = name;
        public string Name { get; }
    }

    /// <summary>An error the caller should see verbatim.</summary>
    internal sealed class McpException : Exception
    {
        public McpException(string message) : base(message) { }
    }

    internal static class CommandRegistry
    {
        private static readonly Dictionary<string, Func<CommandContext, object>> Commands = Discover();

        private static Dictionary<string, Func<CommandContext, object>> Discover()
        {
            var map = new Dictionary<string, Func<CommandContext, object>>(StringComparer.OrdinalIgnoreCase);
            var methods = typeof(CommandRegistry).Assembly.GetTypes()
                .SelectMany(t => t.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic));
            foreach (var method in methods)
            {
                var attr = method.GetCustomAttribute<McpCommandAttribute>();
                if (attr == null) continue;
                map[attr.Name] = (Func<CommandContext, object>)method.CreateDelegate(typeof(Func<CommandContext, object>));
            }
            return map;
        }

        public static object Invoke(string method, CommandContext context)
        {
            if (!Commands.TryGetValue(method, out var command))
                throw new McpException($"Unknown method '{method}'. Available: {string.Join(", ", Commands.Keys.OrderBy(k => k))}");
            return command(context);
        }
    }

    /// <summary>Per-request state handed to every command.</summary>
    internal sealed class CommandContext
    {
        private static readonly JsonSerializer Serializer = JsonSerializer.Create(new JsonSerializerSettings
        {
            NullValueHandling = NullValueHandling.Include,
            ReferenceLoopHandling = ReferenceLoopHandling.Ignore,
        });

        private readonly List<string> _warnings = new List<string>();

        public CommandContext(UIApplication app, JObject parameters)
        {
            App = app;
            Params = parameters;
        }

        public UIApplication App { get; }
        public JObject Params { get; }
        public UIDocument UiDoc => App.ActiveUIDocument;

        public Document Doc =>
            App.ActiveUIDocument?.Document ?? throw new McpException("No Revit document is open.");

        public T Get<T>(string name, T fallback = default)
        {
            var token = Params[name];
            if (token == null || token.Type == JTokenType.Null) return fallback;
            return token.ToObject<T>();
        }

        public T Require<T>(string name)
        {
            var token = Params[name];
            if (token == null || token.Type == JTokenType.Null) throw new McpException($"Missing required parameter '{name}'.");
            return token.ToObject<T>();
        }

        public JToken Token(string name) => Params[name];

        public List<ElementId> RequireIds(string name = "ids")
        {
            var ids = Require<List<long>>(name).Select(Ids.From).ToList();
            foreach (var id in ids)
                if (Doc.GetElement(id) == null) throw new McpException($"Element {Ids.Of(id)} does not exist.");
            return ids;
        }

        /// <summary>
        /// Runs <paramref name="action"/> in a transaction. Revit warnings are
        /// collected and returned instead of popping a dialog that would block.
        /// </summary>
        public T Write<T>(string name, Func<T> action)
        {
            using (var tx = new Transaction(Doc, "MCP: " + name))
            {
                var options = tx.GetFailureHandlingOptions();
                options.SetFailuresPreprocessor(new WarningCollector(_warnings));
                options.SetClearAfterRollback(true);
                tx.SetFailureHandlingOptions(options);

                tx.Start();
                T result;
                try
                {
                    result = action();
                }
                catch
                {
                    if (tx.HasStarted()) tx.RollBack();
                    throw;
                }

                var status = tx.Commit();
                if (status != TransactionStatus.Committed)
                    throw new McpException($"Revit rolled back '{name}' ({status}). {string.Join(" ", _warnings)}".Trim());
                return result;
            }
        }

        public JToken Wrap(object result)
        {
            var token = result == null ? JValue.CreateNull() : JToken.FromObject(result, Serializer);
            if (_warnings.Count == 0) return token;
            return new JObject { ["result"] = token, ["warnings"] = new JArray(_warnings.Distinct()) };
        }

        private sealed class WarningCollector : IFailuresPreprocessor
        {
            private readonly List<string> _sink;
            public WarningCollector(List<string> sink) => _sink = sink;

            public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor)
            {
                foreach (var failure in accessor.GetFailureMessages())
                {
                    _sink.Add(failure.GetDescriptionText());
                    if (failure.GetSeverity() == FailureSeverity.Warning)
                        accessor.DeleteWarning(failure);
                }
                return FailureProcessingResult.Continue;
            }
        }
    }
}
