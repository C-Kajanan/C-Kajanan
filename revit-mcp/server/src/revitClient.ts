// HTTP client for the RevitMcp add-in running inside Revit.
// The add-in listens on http://localhost:<port>/ and accepts
// POST { "method": string, "params": object } and replies with
// { "ok": true, "result": any } or { "ok": false, "error": string }.

export interface RevitClientOptions {
  baseUrl: string;
  timeoutMs: number;
  token?: string;
}

export class RevitError extends Error {}

export class RevitClient {
  constructor(private readonly options: RevitClientOptions) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): RevitClient {
    const host = env.REVIT_MCP_HOST ?? "localhost";
    const port = env.REVIT_MCP_PORT ?? "48884";
    return new RevitClient({
      baseUrl: `http://${host}:${port}/`,
      timeoutMs: Number(env.REVIT_MCP_TIMEOUT_MS ?? 60000),
      token: env.REVIT_MCP_TOKEN || undefined,
    });
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.options.token) headers["X-Revit-Mcp-Token"] = this.options.token;

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
        throw new RevitError(
          `Revit did not answer within ${this.options.timeoutMs} ms. Revit only processes requests when it is idle; close any open dialogs or running commands and try again.`,
        );
      }
      throw new RevitError(
        `Could not reach the RevitMcp add-in at ${this.options.baseUrl}. Make sure Revit is open, the add-in is installed, and the server is started (Add-Ins tab > Revit MCP > Start). (${(err as Error).message})`,
      );
    } finally {
      clearTimeout(timer);
    }

    let body: { ok?: boolean; result?: T; error?: string };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new RevitError(`Revit add-in returned a non-JSON response (HTTP ${response.status}).`);
    }
    if (!response.ok || !body.ok) {
      throw new RevitError(body.error ?? `Revit add-in returned HTTP ${response.status}.`);
    }
    return body.result as T;
  }
}
