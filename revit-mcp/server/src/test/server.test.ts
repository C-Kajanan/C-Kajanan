import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tools } from "../tools.js";

// Stands in for the Revit add-in: records requests and answers like it would.
async function startFakeRevit() {
  const calls: { method: string; params: Record<string, unknown>; token?: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      calls.push({ method, params, token: req.headers["x-revit-mcp-token"] as string | undefined });
      res.setHeader("Content-Type", "application/json");
      if (method === "ping") return res.end(JSON.stringify({ ok: true, result: { revitVersion: "2025" } }));
      if (method === "export_view_image")
        return res.end(JSON.stringify({ ok: true, result: { mimeType: "image/png", base64: "iVBORw0K", viewName: "Level 1" } }));
      if (method === "delete_elements") return res.end(JSON.stringify({ ok: false, error: "Element 99 does not exist." }));
      res.end(JSON.stringify({ ok: true, result: { method, params } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, calls, port: (server.address() as AddressInfo).port };
}

async function connect(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../index.js", import.meta.url))],
    env: { ...(process.env as Record<string, string>), ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

test("exposes every tool and forwards calls to Revit", async () => {
  const revit = await startFakeRevit();
  const client = await connect({ REVIT_MCP_HOST: "127.0.0.1", REVIT_MCP_PORT: String(revit.port), REVIT_MCP_TOKEN: "s3cret" });
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((t) => t.name).sort(), tools.map((t) => t.name).sort());
    assert.equal(listed.tools.find((t) => t.name === "delete_elements")?.annotations?.destructiveHint, true);

    const ping = await client.callTool({ name: "ping", arguments: {} });
    assert.match((ping.content as any)[0].text, /2025/);

    // Defaults from the zod schema are applied before forwarding.
    await client.callTool({ name: "create_wall", arguments: { start: { x: 0, y: 0 }, end: { x: 5000, y: 0 } } });
    const wall = revit.calls.find((c) => c.method === "create_wall")!;
    assert.equal(wall.params.height, 3000);
    assert.equal(wall.token, "s3cret");

    const image = await client.callTool({ name: "export_view_image", arguments: {} });
    assert.equal((image.content as any)[0].type, "image");
    assert.equal((image.content as any)[0].data, "iVBORw0K");

    const failed = await client.callTool({ name: "delete_elements", arguments: { ids: [99] } });
    assert.equal(failed.isError, true);
    assert.match((failed.content as any)[0].text, /does not exist/);

    const invalid = await client.callTool({ name: "delete_elements", arguments: { ids: [] } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    revit.server.close();
  }
});

test("reports a helpful error when Revit is not running", async () => {
  const client = await connect({ REVIT_MCP_HOST: "127.0.0.1", REVIT_MCP_PORT: "1" });
  try {
    const result = await client.callTool({ name: "ping", arguments: {} });
    assert.equal(result.isError, true);
    assert.match((result.content as any)[0].text, /Could not reach the RevitMcp add-in/);
  } finally {
    await client.close();
  }
});
