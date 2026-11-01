using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Runtime;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Application = Autodesk.AutoCAD.ApplicationServices.Application;

namespace AutoCadMcp
{
    /// <summary>Marks a static method <c>object M(CommandContext c)</c> as an MCP method.</summary>
    [AttributeUsage(AttributeTargets.Method)]
    internal sealed class McpCommandAttribute : Attribute
    {
        public McpCommandAttribute(string name) => Name = name;
        public string Name { get; }
    }

    /// <summary>An error the caller should see verbatim.</summary>
    internal sealed class McpException : System.Exception
    {
        public McpException(string message) : base(message) { }
    }

    internal static class Errors
    {
        public static string Describe(System.Exception ex)
        {
            if (ex is Autodesk.AutoCAD.Runtime.Exception acad)
            {
                switch (acad.ErrorStatus)
                {
                    case ErrorStatus.OnLockedLayer: return "The entity is on a locked layer. Unlock the layer with set_layer first.";
                    case ErrorStatus.WasErased: return "The entity has been erased.";
                    case ErrorStatus.InvalidInput: return "AutoCAD rejected the input (eInvalidInput). Check the geometry, e.g. zero-length or self-intersecting.";
                    case ErrorStatus.NotApplicable: return "That operation does not apply to this entity (eNotApplicable).";
                    default: return $"AutoCAD error {acad.ErrorStatus}: {acad.Message}";
                }
            }
            return ex.Message;
        }
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
            NullValueHandling = NullValueHandling.Ignore,
            ReferenceLoopHandling = ReferenceLoopHandling.Ignore,
        });

        public CommandContext(JObject parameters) => Params = parameters;

        public JObject Params { get; }

        public Document Doc =>
            Application.DocumentManager.MdiActiveDocument ?? throw new McpException("No drawing is open in AutoCAD. Use open_drawing or new_drawing.");

        public Database Db => Doc.Database;
        public Editor Ed => Doc.Editor;

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

        public JToken Token(string name)
        {
            var token = Params[name];
            return token == null || token.Type == JTokenType.Null ? null : token;
        }

        public ObjectId IdOf(string handle)
        {
            if (string.IsNullOrWhiteSpace(handle)) throw new McpException("Empty entity handle.");
            long value;
            try { value = Convert.ToInt64(handle.Trim(), 16); }
            catch { throw new McpException($"'{handle}' is not a valid handle (expected hex, e.g. '2A3F')."); }
            if (!Db.TryGetObjectId(new Handle(value), out var id) || id.IsNull || id.IsErased)
                throw new McpException($"No entity with handle '{handle}'.");
            return id;
        }

        public List<ObjectId> RequireIds(string name = "handles")
        {
            var handles = Require<List<string>>(name);
            if (handles.Count == 0) throw new McpException($"'{name}' must not be empty.");
            return handles.Select(IdOf).ToList();
        }

        /// <summary>Read-only access to the active drawing.</summary>
        public T Read<T>(Func<Transaction, T> action)
        {
            using (Doc.LockDocument())
            using (var tr = Db.TransactionManager.StartTransaction())
            {
                var result = action(tr);
                tr.Commit();
                return result;
            }
        }

        /// <summary>Changes the active drawing in one transaction, then refreshes the screen.</summary>
        public T Write<T>(Func<Transaction, T> action)
        {
            var doc = Doc;
            T result;
            using (doc.LockDocument())
            using (var tr = doc.TransactionManager.StartTransaction())
            {
                result = action(tr);
                tr.Commit();
            }
            try { doc.Editor.UpdateScreen(); } catch { }
            return result;
        }

        public JToken Wrap(object result) =>
            result == null ? JValue.CreateNull() : JToken.FromObject(result, Serializer);
    }
}
