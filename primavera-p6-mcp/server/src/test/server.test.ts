import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingMessage["headers"];
  body?: unknown;
}

// Stands in for a P6 EPPM REST API server.
async function startFakeP6() {
  const calls: Call[] = [];
  let sessions = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      const path = url.pathname.replace("/p6ws/restapi", "");
      const call: Call = { method: req.method!, path, query: Object.fromEntries(url.searchParams), headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
      calls.push(call);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (path === "/login") {
        if (req.headers.username !== "planner" || req.headers.password !== "pw") return json(401, { message: "bad login" });
        sessions++;
        res.writeHead(200, { "Set-Cookie": `JSESSIONID=s${sessions}; Path=/p6ws; HttpOnly` });
        return res.end();
      }
      if (!String(req.headers.cookie ?? "").includes("JSESSIONID=s")) return json(401, { message: "not logged in" });
      if (path === "/project" && req.method === "GET") {
        if (call.query.Filter === "Id :eq: 'OFFICE-01'") return json(200, [{ ObjectId: 4512, Id: "OFFICE-01" }]);
        return json(200, [{ ObjectId: 4512, Id: "OFFICE-01", Name: "Office Building" }, { ObjectId: 4600, Id: "DEPOT", Name: "Bus depot" }]);
      }
      if (path === "/activity" && req.method === "GET") return json(200, [{ ObjectId: 9001, Id: "A1010", Name: "Permits" }]);
      if (path === "/relationship") return json(200, call.query.Filter?.startsWith("Predecessor") ? [{ ObjectId: 1 }, { ObjectId: 2 }] : [{ ObjectId: 2 }, { ObjectId: 3 }]);
      if (path === "/resourceAssignment") return json(200, []);
      if (path === "/activity" && req.method === "PUT") return json(200, true);
      if (path === "/job/schedule") return json(200, { JobId: "77", JobStatus: "Running" });
      if (path === "/job/readJobStatus") return json(200, [{ JobStatus: "Complete" }]);
      if (path === "/export/exportXERProject") {
        res.writeHead(201, { "Content-Type": "application/octet-stream" });
        return res.end(readFileSync(join(examples, "office-building-update1.xer")));
      }
      json(404, { message: `no route ${req.method} ${path}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, calls, baseUrl: `http://127.0.0.1:${port}/p6ws/restapi` };
}

async function connect(env: Record<string, string>) {
  const base = { ...(process.env as Record<string, string>) };
  for (const k of Object.keys(base)) if (k.startsWith("P6_")) delete base[k];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../index.js", import.meta.url))],
    env: { ...base, ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;
const json = (r: unknown) => JSON.parse(text(r));

test("without a P6 server only the XER tools are offered, and they work over MCP", async () => {
  const client = await connect({ P6_XER_DIR: examples });
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("xer_schedule_health"));
    assert.ok(!names.some((n) => n.startsWith("p6_")));

    const files = json(await client.callTool({ name: "xer_list_files", arguments: {} }));
    assert.equal(files.files.length, 2);

    const opened = json(await client.callTool({ name: "xer_open", arguments: { file: "office-building-update1.xer" } }));
    assert.equal(opened.projects[0].code, "OFFICE-01");
    assert.equal(opened.tables.TASK, 13);

    const list = json(await client.callTool({ name: "xer_list_activities", arguments: { file: "office-building-update1.xer", maxFloat: -1, limit: 3 } }));
    assert.equal(list.total, 7);
    assert.equal(list.items.length, 3);
    assert.equal(list.truncated, true);

    const rows = json(await client.callTool({ name: "xer_query_table", arguments: { file: "office-building-update1.xer", table: "RSRC", fields: ["rsrc_short_name"] } }));
    assert.deepEqual(rows.items.map((r: { rsrc_short_name: string }) => r.rsrc_short_name), ["LAB", "EXC", "CONC", "CRANE"]);

    const missing = await client.callTool({ name: "xer_get_activity", arguments: { file: "office-building-update1.xer", activityId: "NOPE" } });
    assert.equal(missing.isError, true);
    assert.match(text(missing), /not in project OFFICE-01/);
  } finally {
    await client.close();
  }
});

test("P6 REST tools log in, reuse the session and build filters", async () => {
  const p6 = await startFakeP6();
  const out = mkdtempSync(join(tmpdir(), "p6mcp-"));
  const client = await connect({ P6_BASE_URL: p6.baseUrl, P6_USERNAME: "planner", P6_PASSWORD: "pw", P6_DATABASE: "PMDB", P6_XER_DIR: out });
  try {
    const listed = (await client.listTools()).tools;
    const names = listed.map((t) => t.name);
    assert.ok(names.includes("p6_list_activities"));
    assert.ok(!names.includes("p6_update_activities"), "write tools need P6_ALLOW_WRITES");
    assert.equal(listed.find((t) => t.name === "p6_list_projects")?.annotations?.readOnlyHint, true);

    const projects = json(await client.callTool({ name: "p6_list_projects", arguments: { search: "depot" } }));
    assert.deepEqual(projects.items.map((p: { Id: string }) => p.Id), ["DEPOT"]);
    const login = p6.calls.find((c) => c.path === "/login")!;
    assert.equal(login.query.DatabaseName, "PMDB");

    await client.callTool({ name: "p6_list_activities", arguments: { projectId: "OFFICE-01", status: "In Progress" } });
    const act = p6.calls.filter((c) => c.path === "/activity").at(-1)!;
    assert.equal(act.query.Filter, "ProjectObjectId :eq: 4512 :and: Status :eq: 'In Progress'");
    assert.match(act.query.Fields, /TotalFloat/);
    assert.equal(act.query.OrderBy, "StartDate asc");
    assert.equal(p6.calls.filter((c) => c.path === "/login").length, 1, "session is reused");

    const rels = json(await client.callTool({ name: "p6_list_relationships", arguments: { activityObjectId: 9001 } }));
    assert.equal(rels.total, 3, "predecessor and successor reads are merged without duplicates");

    const exported = json(await client.callTool({ name: "p6_export_xer", arguments: { projectObjectId: 4512, outFile: "live.xer" } }));
    assert.match(exported.note, /Open it with xer_open/);
    const summary = json(await client.callTool({ name: "xer_project_summary", arguments: { file: "live.xer" } }));
    assert.equal(summary.project.code, "OFFICE-01");
  } finally {
    await client.close();
    p6.server.close();
  }
});

test("write tools are offered with P6_ALLOW_WRITES and send P6's request shapes", async () => {
  const p6 = await startFakeP6();
  const client = await connect({ P6_BASE_URL: p6.baseUrl, P6_USERNAME: "planner", P6_PASSWORD: "pw", P6_ALLOW_WRITES: "1" });
  try {
    const listed = (await client.listTools()).tools;
    assert.equal(listed.find((t) => t.name === "p6_delete_activities")?.annotations?.destructiveHint, true);

    await client.callTool({ name: "p6_update_activities", arguments: { activities: [{ ObjectId: 9001, RemainingDuration: 16 }] } });
    assert.deepEqual(p6.calls.find((c) => c.method === "PUT")!.body, [{ ObjectId: 9001, RemainingDuration: 16 }]);

    const bad = await client.callTool({ name: "p6_update_activities", arguments: { activities: [{ Name: "x" }] } });
    assert.equal(bad.isError, true);

    const sched = json(await client.callTool({ name: "p6_schedule_project", arguments: { projectObjectId: 4512, newDataDate: "2026-04-01T08:00:00", waitSeconds: 5 } }));
    assert.deepEqual(p6.calls.find((c) => c.path === "/job/schedule")!.body, { ProjectObjectId: [4512], Timeout: 5, NewDataDate: "2026-04-01T08:00:00" });
    assert.deepEqual(sched.status, [{ JobStatus: "Complete" }]);
  } finally {
    await client.close();
    p6.server.close();
  }
});

test("bad credentials give a clear error", async () => {
  const p6 = await startFakeP6();
  const client = await connect({ P6_BASE_URL: p6.baseUrl, P6_USERNAME: "planner", P6_PASSWORD: "wrong" });
  try {
    const r = await client.callTool({ name: "p6_connection_info", arguments: {} });
    assert.equal(r.isError, true);
    assert.match(text(r), /P6 login failed \(HTTP 401\)/);
  } finally {
    await client.close();
    p6.server.close();
  }
});
