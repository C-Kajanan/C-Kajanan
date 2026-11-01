using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Application = Autodesk.AutoCAD.ApplicationServices.Application;

namespace AutoCadMcp
{
    /// <summary>
    /// Local HTTP endpoint for the MCP server. Requests arrive on a thread-pool
    /// thread, are queued, and run on AutoCAD's main thread (see <see cref="MainThread"/>).
    /// </summary>
    internal sealed class McpBridge
    {
        private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(
            int.TryParse(Environment.GetEnvironmentVariable("AUTOCAD_MCP_TIMEOUT_S"), out var s) ? s : 55);

        private readonly string _token = Environment.GetEnvironmentVariable("AUTOCAD_MCP_TOKEN");
        private HttpListener _listener;

        public bool IsRunning => _listener?.IsListening == true;

        public void Start(int port)
        {
            if (IsRunning) return;

            // "localhost" (not 127.0.0.1) so no URL ACL / admin rights are needed.
            _listener = new HttpListener();
            _listener.Prefixes.Add($"http://localhost:{port}/");
            _listener.Start();
            var listener = _listener;
            Task.Run(() => AcceptLoop(listener));
        }

        public void Stop()
        {
            try { _listener?.Stop(); _listener?.Close(); } catch { }
            _listener = null;
        }

        private async Task AcceptLoop(HttpListener listener)
        {
            while (listener.IsListening)
            {
                HttpListenerContext context;
                try
                {
                    context = await listener.GetContextAsync().ConfigureAwait(false);
                }
                catch
                {
                    break;
                }
                _ = Task.Run(() => HandleAsync(context));
            }
        }

        private async Task HandleAsync(HttpListenerContext context)
        {
            var request = context.Request;
            int status = 200;
            JObject response;

            try
            {
                // Block browsers: a web page could otherwise POST to localhost.
                if (!string.IsNullOrEmpty(request.Headers["Origin"]))
                    throw new BridgeHttpException(403, "Cross-origin requests are not allowed.");
                if (request.HttpMethod != "POST")
                    throw new BridgeHttpException(405, "Use POST with a JSON body {\"method\":..., \"params\":{...}}.");
                if (request.ContentType == null || !request.ContentType.StartsWith("application/json", StringComparison.OrdinalIgnoreCase))
                    throw new BridgeHttpException(415, "Content-Type must be application/json.");
                if (!string.IsNullOrEmpty(_token) && request.Headers["X-AutoCAD-Mcp-Token"] != _token)
                    throw new BridgeHttpException(401, "Missing or wrong X-AutoCAD-Mcp-Token header.");

                string body;
                using (var reader = new StreamReader(request.InputStream, Encoding.UTF8))
                    body = await reader.ReadToEndAsync().ConfigureAwait(false);

                var json = JObject.Parse(body);
                var method = json.Value<string>("method");
                if (string.IsNullOrWhiteSpace(method))
                    throw new BridgeHttpException(400, "Missing 'method'.");

                var pending = new PendingRequest(method, json["params"] as JObject ?? new JObject());
                MainThread.Enqueue(pending);

                var finished = await Task.WhenAny(pending.Completion.Task, Task.Delay(RequestTimeout)).ConfigureAwait(false);
                if (finished != pending.Completion.Task && pending.TryCancel())
                {
                    throw new BridgeHttpException(504,
                        "AutoCAD is busy (a command or dialog is active) and did not run the request. Nothing was changed. Press Esc in AutoCAD and try again.");
                }
                // Either finished, or already running on the main thread: wait for it.
                response = await pending.Completion.Task.ConfigureAwait(false);
            }
            catch (BridgeHttpException ex)
            {
                status = ex.Status;
                response = Error(ex.Message);
            }
            catch (JsonException ex)
            {
                status = 400;
                response = Error("Invalid JSON: " + ex.Message);
            }
            catch (Exception ex)
            {
                status = 500;
                response = Error(ex.Message);
            }

            try
            {
                var bytes = Encoding.UTF8.GetBytes(response.ToString(Formatting.None));
                context.Response.StatusCode = status;
                context.Response.ContentType = "application/json; charset=utf-8";
                context.Response.ContentLength64 = bytes.Length;
                await context.Response.OutputStream.WriteAsync(bytes, 0, bytes.Length).ConfigureAwait(false);
                context.Response.Close();
            }
            catch
            {
                // Client went away.
            }
        }

        internal static JObject Error(string message) => new JObject { ["ok"] = false, ["error"] = message };

        private sealed class BridgeHttpException : Exception
        {
            public BridgeHttpException(int status, string message) : base(message) => Status = status;
            public int Status { get; }
        }
    }

    internal sealed class PendingRequest
    {
        private const int Waiting = 0, Running = 1, Cancelled = 2;
        private int _state;

        public PendingRequest(string method, JObject parameters)
        {
            Method = method;
            Params = parameters;
        }

        public string Method { get; }
        public JObject Params { get; }
        public TaskCompletionSource<JObject> Completion { get; } =
            new TaskCompletionSource<JObject>(TaskCreationOptions.RunContinuationsAsynchronously);

        public bool TryStart() => Interlocked.CompareExchange(ref _state, Running, Waiting) == Waiting;
        public bool TryCancel() => Interlocked.CompareExchange(ref _state, Cancelled, Waiting) == Waiting;
    }

    /// <summary>
    /// Runs queued requests on AutoCAD's main thread, in the application
    /// context, and only while no command is active. Requests are posted to a
    /// hidden window created on the main thread; if AutoCAD is busy they wait
    /// for the next <see cref="Application.Idle"/> event.
    /// </summary>
    internal static class MainThread
    {
        private static readonly ConcurrentQueue<PendingRequest> Queue = new ConcurrentQueue<PendingRequest>();
        private static Control _marshal;
        private static bool _draining;

        public static void Initialize()
        {
            _marshal = new Control();
            _marshal.CreateControl();
            _ = _marshal.Handle; // force the window handle onto this thread
            Application.Idle += (s, e) => Drain();
        }

        public static void Enqueue(PendingRequest request)
        {
            Queue.Enqueue(request);
            try { _marshal.BeginInvoke((Action)Drain); } catch { /* the Idle event picks it up */ }
        }

        private static void Drain()
        {
            // Opening a drawing pumps messages; don't start another request inside one.
            if (_draining) return;
            _draining = true;
            try
            {
                while (!Queue.IsEmpty)
                {
                    if (!IsQuiescent()) return; // retried on the next Idle event
                    if (!Queue.TryDequeue(out var request)) return;
                    if (!request.TryStart()) continue; // timed out while waiting

                    JObject response;
                    try
                    {
                        var context = new CommandContext(request.Params);
                        var result = CommandRegistry.Invoke(request.Method, context);
                        response = new JObject { ["ok"] = true, ["result"] = context.Wrap(result) };
                    }
                    catch (Exception ex)
                    {
                        var inner = ex is System.Reflection.TargetInvocationException tie && tie.InnerException != null ? tie.InnerException : ex;
                        response = McpBridge.Error(Errors.Describe(inner));
                    }
                    request.Completion.TrySetResult(response);
                }
            }
            finally
            {
                _draining = false;
            }
        }

        private static bool IsQuiescent()
        {
            try
            {
                var doc = Application.DocumentManager.MdiActiveDocument;
                return doc == null || doc.Editor.IsQuiescent;
            }
            catch
            {
                return true;
            }
        }
    }
}
