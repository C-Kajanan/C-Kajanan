import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../skill/autocad/scripts/acad.mjs", import.meta.url));

function run(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [script, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as any).code as number) : 0, stdout, stderr }),
    );
  });
}

test("skill script calls the plug-in like the MCP server does", async () => {
  const calls: { method: string; params: any; token?: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      calls.push({ method, params, token: req.headers["x-autocad-mcp-token"] as string | undefined });
      res.setHeader("Content-Type", "application/json");
      if (method === "export_view_image")
        return res.end(JSON.stringify({ ok: true, result: { mimeType: "image/png", base64: Buffer.from("PNGDATA").toString("base64"), width: 10 } }));
      if (method === "get_entity") return res.end(JSON.stringify({ ok: false, error: "No entity with handle 'FFFF'." }));
      res.end(JSON.stringify({ ok: true, result: { method, params } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const env = { AUTOCAD_MCP_HOST: "127.0.0.1", AUTOCAD_MCP_PORT: String((server.address() as AddressInfo).port), AUTOCAD_MCP_TOKEN: "t0k" };
  try {
    const line = await run(["draw_line", '{"start":{"x":0,"y":0},"end":{"x":10,"y":0}}'], env);
    assert.equal(line.code, 0, line.stderr);
    assert.deepEqual(JSON.parse(line.stdout).params.end, { x: 10, y: 0 });
    assert.equal(calls.at(-1)!.token, "t0k");

    const out = join(mkdtempSync(join(tmpdir(), "acad-")), "view.png");
    const image = await run(["export_view_image", "--out", out], env);
    assert.equal(image.code, 0, image.stderr);
    assert.equal(JSON.parse(image.stdout).imagePath, out);
    assert.equal(readFileSync(out, "utf8"), "PNGDATA");

    const refused = await run(["erase_entities", '{"handles":["2A"]}'], env);
    assert.equal(refused.code, 3);
    assert.equal(calls.some((c) => c.method === "erase_entities"), false);
    const erased = await run(["erase_entities", '{"handles":["2A"]}', "--confirm"], env);
    assert.equal(erased.code, 0, erased.stderr);

    const failed = await run(["get_entity", '{"handle":"FFFF"}'], env);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /No entity with handle/);

    const unknown = await run(["draw_teapot", "{}"], env);
    assert.equal(unknown.code, 2);
  } finally {
    server.close();
  }
});

test("skill script reports when AutoCAD is not running", async () => {
  const result = await run(["ping"], { AUTOCAD_MCP_HOST: "127.0.0.1", AUTOCAD_MCP_PORT: "1" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Could not reach the AutoCadMcp plug-in/);
});
