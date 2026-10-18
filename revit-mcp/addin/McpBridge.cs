using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RevitMcp
{
    /// <summary>
    /// Local HTTP endpoint for the MCP server. Requests arrive on a thread-pool
    /// thread, are queued, and are executed on Revit's main thread through an
    /// ExternalEvent (the only safe way to call the Revit API from outside).
    /// </summary>
    internal sealed class McpBridge
    {
        private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(
            int.TryParse(Environment.GetEnvironmentVariable("REVIT_MCP_TIMEOUT_S"), out var s) ? s : 55);

        private readonly string _token = Environment.GetEnvironmentVariable("REVIT_MCP_TOKEN");
        private HttpListener _listener;
        private ExternalEvent _event;
        private RequestHandler _handler;

        public bool IsRunning => _listener?.IsListening == true;

        public void Start(int port)
        {
            if (IsRunning) return;

            _handler ??= new RequestHandler();
            _event ??= ExternalEvent.Create(_handler);

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
                if (!string.IsNullOrEmpty(_token) && request.Headers["X-Revit-Mcp-Token"] != _token)
                    throw new BridgeHttpException(401, "Missing or wrong X-Revit-Mcp-Token header.");

                string body;
                using (var reader = new StreamReader(request.InputStream, Encoding.UTF8))
                    body = await reader.ReadToEndAsync().ConfigureAwait(false);

                var json = JObject.Parse(body);
                var method = json.Value<string>("method");
                if (string.IsNullOrWhiteSpace(method))
                    throw new BridgeHttpException(400, "Missing 'method'.");

                var pending = new PendingRequest(method, json["params"] as JObject ?? new JObject());
                _handler.Enqueue(pending);
                var raised = _event.Raise();
                if (raised == ExternalEventRequest.Denied || raised == ExternalEventRequest.TimedOut)
                    throw new BridgeHttpException(503, $"Revit refused the request ({raised}).");

                var finished = await Task.WhenAny(pending.Completion.Task, Task.Delay(RequestTimeout)).ConfigureAwait(false);
                if (finished != pending.Completion.Task && pending.TryCancel())
                {
                    throw new BridgeHttpException(504,
                        "Revit is busy (a dialog or command is open) and did not run the request. Nothing was changed.");
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

    internal sealed class RequestHandler : IExternalEventHandler
    {
        private readonly ConcurrentQueue<PendingRequest> _queue = new ConcurrentQueue<PendingRequest>();

        public void Enqueue(PendingRequest request) => _queue.Enqueue(request);

        public void Execute(UIApplication app)
        {
            while (_queue.TryDequeue(out var request))
            {
                if (!request.TryStart()) continue; // timed out while waiting

                JObject response;
                try
                {
                    var context = new CommandContext(app, request.Params);
                    var result = CommandRegistry.Invoke(request.Method, context);
                    response = new JObject { ["ok"] = true, ["result"] = context.Wrap(result) };
                }
                catch (Exception ex)
                {
                    var inner = ex is System.Reflection.TargetInvocationException tie && tie.InnerException != null ? tie.InnerException : ex;
                    response = McpBridge.Error(inner.Message);
                }
                request.Completion.TrySetResult(response);
            }
        }

        public string GetName() => "Revit MCP request";
    }
}
