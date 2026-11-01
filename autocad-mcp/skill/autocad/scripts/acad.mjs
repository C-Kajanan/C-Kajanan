#!/usr/bin/env node
// Calls the AutoCadMcp plug-in running inside AutoCAD. No dependencies; needs Node 18+.
//
//   node acad.mjs list                               tool names and flags
//   node acad.mjs <tool> '{"param": ...}'            call a tool, print the JSON result
//   node acad.mjs <tool> --file params.json          params from a file ("-" = stdin)
//   node acad.mjs export_view_image --out view.png   images are written to a file
//   node acad.mjs erase_entities '{...}' --confirm   destructive tools need --confirm
//
// Env: AUTOCAD_MCP_HOST (localhost), AUTOCAD_MCP_PORT (48885),
//      AUTOCAD_MCP_TOKEN (unset), AUTOCAD_MCP_TIMEOUT_MS (60000).

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tools = JSON.parse(readFileSync(new URL("./tools.json", import.meta.url), "utf8"));

function fail(message, code = 1) {
  process.stderr.write(message.endsWith("\n") ? message : message + "\n");
  process.exit(code);
}

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value ?? "";
};
const has = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};

const confirm = has("--confirm");
const out = flag("--out");
const file = flag("--file");
const [name, inline] = args;

if (!name || name === "help" || name === "--help") {
  fail("Usage: node acad.mjs <tool> '<json params>' [--file params.json] [--out image.png] [--confirm]\n       node acad.mjs list", 2);
}
if (name === "list") {
  for (const t of tools) {
    const tags = [t.readOnly && "read-only", t.destructive && "destructive", t.image && "image"].filter(Boolean);
    console.log(tags.length ? `${t.name}  (${tags.join(", ")})` : t.name);
  }
  process.exit(0);
}

const tool = tools.find((t) => t.name === name);
if (!tool) fail(`Unknown tool '${name}'. Run 'node acad.mjs list'. Parameters are in reference.md.`, 2);
if (tool.destructive && !confirm) {
  fail(`'${name}' is destructive. Confirm with the user, then re-run with --confirm.`, 3);
}

let params = {};
try {
  const text = file !== undefined ? readFileSync(file === "-" ? 0 : file, "utf8") : inline;
  if (text && text.trim()) params = JSON.parse(text);
} catch (err) {
  fail(`Parameters must be a JSON object: ${err.message}`, 2);
}
if (params === null || typeof params !== "object" || Array.isArray(params)) fail("Parameters must be a JSON object.", 2);

const host = process.env.AUTOCAD_MCP_HOST || "localhost";
const port = process.env.AUTOCAD_MCP_PORT || "48885";
const timeoutMs = Number(process.env.AUTOCAD_MCP_TIMEOUT_MS || 60000);
const headers = { "Content-Type": "application/json" };
if (process.env.AUTOCAD_MCP_TOKEN) headers["X-AutoCAD-Mcp-Token"] = process.env.AUTOCAD_MCP_TOKEN;

let response;
try {
  response = await fetch(`http://${host}:${port}/`, {
    method: "POST",
    headers,
    body: JSON.stringify({ method: name, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
} catch (err) {
  if (err.name === "TimeoutError") {
    fail(`AutoCAD did not answer within ${timeoutMs} ms. It only runs requests when no command is active: press Esc in AutoCAD, close dialogs and retry.`);
  }
  fail(`Could not reach the AutoCadMcp plug-in at http://${host}:${port}/. Is AutoCAD open with the plug-in loaded? Type MCPSTATUS / MCPSTART in AutoCAD. (${err.cause?.code ?? err.message})`);
}

let body;
try {
  body = await response.json();
} catch {
  fail(`The plug-in returned a non-JSON response (HTTP ${response.status}).`);
}
if (!response.ok || !body.ok) fail(body.error ?? `The plug-in returned HTTP ${response.status}.`);

let result = body.result;
if (tool.image && result && typeof result.base64 === "string") {
  const path = resolve(out || join(tmpdir(), `autocad-view-${Date.now()}.png`));
  writeFileSync(path, Buffer.from(result.base64, "base64"));
  const { base64, ...rest } = result;
  result = { ...rest, imagePath: path };
}
console.log(JSON.stringify(result, null, 2));
