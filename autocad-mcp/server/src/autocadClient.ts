// HTTP client for the AutoCadMcp plug-in running inside AutoCAD.
// The plug-in listens on http://localhost:<port>/ and accepts
// POST { "method": string, "params": object } and replies with
// { "ok": true, "result": any } or { "ok": false, "error": string }.

export interface AutoCadClientOptions {
  baseUrl: string;
  timeoutMs: number;
  token?: string;
}

export class AutoCadError extends Error {}

export class AutoCadClient {
  constructor(private readonly options: AutoCadClientOptions) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): AutoCadClient {
    const host = env.AUTOCAD_MCP_HOST ?? "localhost";
    const port = env.AUTOCAD_MCP_PORT ?? "48885";
    return new AutoCadClient({
      baseUrl: `http://${host}:${port}/`,
      timeoutMs: Number(env.AUTOCAD_MCP_TIMEOUT_MS ?? 60000),
      token: env.AUTOCAD_MCP_TOKEN || undefined,
    });
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.options.token) headers["X-AutoCAD-Mcp-Token"] = this.options.token;

    let response: Response;
    try {
      response = await fetch(this.options.baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ method, params }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new AutoCadError(
          `AutoCAD did not answer within ${this.options.timeoutMs} ms. AutoCAD only processes requests when no command is running; press Esc in AutoCAD, close any open dialogs and try again.`,
        );
      }
      throw new AutoCadError(
        `Could not reach the AutoCadMcp plug-in at ${this.options.baseUrl}. Make sure AutoCAD is open and the plug-in is loaded (type MCPSTART in AutoCAD). (${(err as Error).message})`,
      );
    } finally {
      clearTimeout(timer);
    }

    let body: { ok?: boolean; result?: T; error?: string };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new AutoCadError(`AutoCAD plug-in returned a non-JSON response (HTTP ${response.status}).`);
    }
    if (!response.ok || !body.ok) {
      throw new AutoCadError(body.error ?? `AutoCAD plug-in returned HTTP ${response.status}.`);
    }
    return body.result as T;
  }
}
