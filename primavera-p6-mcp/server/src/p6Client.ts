// Client for the Oracle Primavera P6 EPPM REST API (P6 EPPM 20.x and later,
// on-premises or Oracle Cloud). Base URL is usually
//   https://<host>:<port>/p6ws/restapi
//
// Authentication, in order of preference:
//   P6_AUTH_TOKEN                        sent as "Authorization: Bearer <token>" (Oracle Cloud OAuth)
//   P6_USERNAME + P6_PASSWORD + P6_DATABASE
//                                        POST /login?DatabaseName=..., then the session cookie
//                                        is reused. P6_LOGIN_MODE=basic sends the credentials
//                                        as HTTP Basic auth instead of username/password headers
//                                        (older P6 releases).

export class P6Error extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface P6ClientOptions {
  baseUrl: string;
  database?: string;
  username?: string;
  password?: string;
  token?: string;
  loginMode: "headers" | "basic";
  timeoutMs: number;
}

export class P6Client {
  private cookies = new Map<string, string>();
  private loggedIn = false;

  constructor(readonly options: P6ClientOptions) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): P6Client | undefined {
    const baseUrl = env.P6_BASE_URL?.trim();
    if (!baseUrl) return undefined;
    return new P6Client({
      baseUrl: baseUrl.replace(/\/+$/, ""),
      database: env.P6_DATABASE || undefined,
      username: env.P6_USERNAME || undefined,
      password: env.P6_PASSWORD || undefined,
      token: env.P6_AUTH_TOKEN || undefined,
      loginMode: env.P6_LOGIN_MODE === "basic" ? "basic" : "headers",
      timeoutMs: Number(env.P6_TIMEOUT_MS ?? 120000),
    });
  }

  get authMode(): string {
    return this.options.token ? "token" : "session";
  }

  private cookieHeader(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private storeCookies(res: Response) {
    const list: string[] =
      typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
        ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : res.headers.get("set-cookie")
          ? [res.headers.get("set-cookie")!]
          : [];
    for (const c of list) {
      const [pair] = c.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  private async fetch(path: string, init: RequestInit & { query?: Record<string, string | undefined> }): Promise<Response> {
    const url = new URL(this.options.baseUrl + path);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, v);
    const headers = new Headers(init.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (this.options.token) {
      const t = this.options.token;
      headers.set("Authorization", /^(Bearer|Basic) /i.test(t) ? t : `Bearer ${t}`);
    }
    const cookie = this.cookieHeader();
    if (cookie) headers.set("Cookie", cookie);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const res = await fetch(url, { ...init, headers, signal: controller.signal, redirect: "manual" });
      this.storeCookies(res);
      return res;
    } catch (err) {
      if (controller.signal.aborted) throw new P6Error(`P6 did not answer within ${this.options.timeoutMs} ms (${url.pathname}).`);
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      const hint =
        cause?.code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(cause.code)
          ? " The server's TLS certificate isn't trusted; point NODE_EXTRA_CA_CERTS at your CA certificate."
          : "";
      throw new P6Error(`Could not reach P6 at ${this.options.baseUrl}: ${cause?.message ?? (err as Error).message}.${hint}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async login(): Promise<void> {
    if (this.options.token) return;
    const { username, password, database } = this.options;
    if (!username || !password) {
      throw new P6Error("P6 credentials are not configured. Set P6_USERNAME and P6_PASSWORD (and P6_DATABASE), or P6_AUTH_TOKEN.");
    }
    this.cookies.clear();
    const headers: Record<string, string> =
      this.options.loginMode === "basic"
        ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
        : { username, password };
    const res = await this.fetch("/login", { method: "POST", headers, query: { DatabaseName: database } });
    if (!res.ok && res.status !== 302) {
      const text = await res.text().catch(() => "");
      throw new P6Error(
        `P6 login failed (HTTP ${res.status}). Check P6_USERNAME, P6_PASSWORD and P6_DATABASE${database ? ` (now "${database}")` : ""}.${text ? ` ${text.slice(0, 300)}` : ""}`,
        res.status,
      );
    }
    this.loggedIn = true;
  }

  async logout(): Promise<void> {
    if (!this.loggedIn) return;
    await this.fetch("/logout", { method: "POST" }).catch(() => undefined);
    this.cookies.clear();
    this.loggedIn = false;
  }

  /** Send a request, logging in first and once more if the session expired. */
  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: { query?: Record<string, string | undefined>; body?: unknown; raw?: boolean } = {},
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (!this.options.token && !this.loggedIn) await this.login();
      const init: RequestInit & { query?: Record<string, string | undefined> } = { method, query: options.query };
      if (options.body !== undefined) {
        init.body = JSON.stringify(options.body);
        init.headers = { "Content-Type": "application/json" };
      }
      const res = await this.fetch(path, init);
      if ((res.status === 401 || res.status === 302) && !this.options.token && attempt === 0) {
        this.loggedIn = false;
        continue;
      }
      if (options.raw) {
        if (!res.ok) throw new P6Error(`P6 ${method} ${path} failed (HTTP ${res.status}): ${(await res.text()).slice(0, 500)}`, res.status);
        return res as unknown as T;
      }
      const text = await res.text();
      if (!res.ok) {
        let message = text;
        try {
          const j = JSON.parse(text);
          message = j.message ?? j.error ?? j.detail ?? text;
        } catch {
          /* not JSON */
        }
        throw new P6Error(`P6 ${method} ${path} failed (HTTP ${res.status}): ${String(message).slice(0, 800) || res.statusText}`, res.status);
      }
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as T;
      }
    }
  }

  /** Read business objects, e.g. read("activity", ["Id","Name"], "ProjectObjectId :eq: 4512"). */
  read<T = Record<string, unknown>>(entity: string, fields: string[], filter?: string, orderBy?: string): Promise<T[]> {
    return this.request<T[]>("GET", `/${entity}`, { query: { Fields: fields.join(","), Filter: filter, OrderBy: orderBy } }).then((r) =>
      Array.isArray(r) ? r : r === undefined ? [] : [r as T],
    );
  }

  create(entity: string, objects: Record<string, unknown>[]) {
    return this.request("POST", `/${entity}`, { body: objects });
  }

  update(entity: string, objects: Record<string, unknown>[]) {
    return this.request("PUT", `/${entity}`, { body: objects });
  }

  delete(entity: string, objectIds: number[]) {
    return this.request("DELETE", `/${entity}`, { query: { ObjectId: objectIds.join(",") } });
  }
}
