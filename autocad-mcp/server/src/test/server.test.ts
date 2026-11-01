import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tools } from "../tools.js";

// Stands in for the AutoCAD plug-in: records requests and answers like it would.
async function startFakeAutoCad() {
  const calls: { method: string; params: Record<string, unknown>; token?: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      calls.push({ method, params, token: req.headers["x-autocad-mcp-token"] as string | undefined });
      res.setHeader("Content-Type", "application/json");
      if (method === "ping") return res.end(JSON.stringify({ ok: true, result: { version: "25.0", product: "AutoCAD 2025" } }));
      if (method === "export_view_image")
        return res.end(JSON.stringify({ ok: true, result: { mimeType: "image/png", base64: "iVBORw0K", drawing: "Drawing1.dwg" } }));
      if (method === "erase_entities") return res.end(JSON.stringify({ ok: false, error: "No entity with handle 'FFFF'." }));
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

test("exposes every tool and forwards calls to AutoCAD", async () => {
  const acad = await startFakeAutoCad();
  const client = await connect({ AUTOCAD_MCP_HOST: "127.0.0.1", AUTOCAD_MCP_PORT: String(acad.port), AUTOCAD_MCP_TOKEN: "s3cret" });
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((t) => t.name).sort(), tools.map((t) => t.name).sort());
    assert.equal(listed.tools.find((t) => t.name === "erase_entities")?.annotations?.destructiveHint, true);
    assert.equal(listed.tools.find((t) => t.name === "list_layers")?.annotations?.readOnlyHint, true);

    const ping = await client.callTool({ name: "ping", arguments: {} });
    assert.match((ping.content as any)[0].text, /AutoCAD 2025/);

    // Defaults from the zod schema (z = 0, closed = false) are applied before forwarding.
    await client.callTool({ name: "draw_polyline", arguments: { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], layer: "WALLS" } });
    const pline = acad.calls.find((c) => c.method === "draw_polyline")!;
    assert.deepEqual(pline.params.points, [{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }]);
    assert.equal(pline.params.closed, false);
    assert.equal(pline.params.layer, "WALLS");
    assert.equal(pline.token, "s3cret");

    const image = await client.callTool({ name: "export_view_image", arguments: {} });
    assert.equal((image.content as any)[0].type, "image");
    assert.equal((image.content as any)[0].data, "iVBORw0K");

    const failed = await client.callTool({ name: "erase_entities", arguments: { handles: ["FFFF"] } });
    assert.equal(failed.isError, true);
    assert.match((failed.content as any)[0].text, /No entity with handle/);

    const invalid = await client.callTool({ name: "get_entity", arguments: { handle: "not-hex" } });
    assert.equal(invalid.isError, true);
    assert.equal(acad.calls.some((c) => c.method === "get_entity"), false);
  } finally {
    await client.close();
    acad.server.close();
  }
});

test("reports a helpful error when AutoCAD is not running", async () => {
  const client = await connect({ AUTOCAD_MCP_HOST: "127.0.0.1", AUTOCAD_MCP_PORT: "1" });
  try {
    const result = await client.callTool({ name: "ping", arguments: {} });
    assert.equal(result.isError, true);
    assert.match((result.content as any)[0].text, /Could not reach the AutoCadMcp plug-in/);
  } finally {
    await client.close();
  }
});
