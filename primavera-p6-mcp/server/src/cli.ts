#!/usr/bin/env node
// Command-line front end to every tool the MCP server exposes, including the
// live P6 ones (installed as the `p6` command of this package). The skill uses
// its own offline entry point, src/skill/p6.ts.
//
//   p6 list                          tools available with the current environment
//   p6 help <tool>                   description and JSON schema of a tool's arguments
//   p6 <tool> '<json args>'          run a tool, e.g. p6 xer_project_summary '{"file":"a.xer"}'
//   p6 <tool> --file a.xer [--k v]   shorthand: --key value pairs become arguments

import { z } from "zod";
import { p6, p6ReadTools, p6WriteTools, writesEnabled } from "./tools/p6Tools.js";
import { xerTools } from "./tools/xerTools.js";
import type { ToolDef } from "./tools/types.js";

const available = (): ToolDef[] => [
  ...xerTools,
  ...(process.env.P6_BASE_URL ? p6ReadTools : []),
  ...(process.env.P6_BASE_URL && writesEnabled() ? p6WriteTools : []),
];
const all = [...xerTools, ...p6ReadTools, ...p6WriteTools];

function out(value: unknown) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function fail(message: string, code = 1): never {
  process.stderr.write(message + "\n");
  process.exit(code);
}

/** "--file a.xer --limit 5 --status Completed --status 'In Progress'" -> object; values parsed as JSON when they look like it. */
function flagsToArgs(argv: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([A-Za-z][\w]*)(?:=(.*))?$/.exec(argv[i]);
    if (!m) fail(`Unexpected argument "${argv[i]}". Use --name value, or one JSON object.`);
    const raw = m[2] ?? (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : "true");
    let value: unknown = raw;
    if (/^(true|false|null|-?\d+(\.\d+)?|[[{].*)$/s.test(raw)) {
      try {
        value = JSON.parse(raw);
      } catch {
        /* keep the string */
      }
    }
    const key = m[1];
    if (key in args) args[key] = ([] as unknown[]).concat(args[key], value);
    else args[key] = value;
  }
  return args;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h") {
    fail("Usage: p6 list | p6 help <tool> | p6 <tool> '<json args>' | p6 <tool> --name value ...", cmd ? 0 : 2);
  }

  if (cmd === "list") {
    const tools = available();
    return out({
      p6Server: process.env.P6_BASE_URL ?? null,
      writesEnabled: Boolean(process.env.P6_BASE_URL) && writesEnabled(),
      tools: tools.map((t) => ({ name: t.name, description: t.description })),
      notAvailable: all.filter((t) => !tools.includes(t)).map((t) => t.name),
    });
  }

  if (cmd === "help") {
    const t = all.find((x) => x.name === rest[0]);
    if (!t) fail(`Unknown tool "${rest[0] ?? ""}". Run "p6 list".`);
    return out({ name: t.name, title: t.title, description: t.description, arguments: z.toJSONSchema(z.object(t.input), { io: "input" }) });
  }

  const tool = all.find((t) => t.name === cmd);
  if (!tool) fail(`Unknown tool "${cmd}". Run "p6 list".`);
  if (!available().includes(tool)) {
    fail(
      tool.name.startsWith("p6_") && !process.env.P6_BASE_URL
        ? `${tool.name} needs a P6 server: set P6_BASE_URL and credentials.`
        : `${tool.name} changes data in P6 and needs P6_ALLOW_WRITES=1.`,
    );
  }

  let raw: unknown;
  if (rest.length === 1 && rest[0].trim().startsWith("{")) {
    try {
      raw = JSON.parse(rest[0]);
    } catch (err) {
      fail(`Arguments are not valid JSON: ${(err as Error).message}`);
    }
  } else {
    const args = flagsToArgs(rest);
    // A single --flag value for a list argument becomes a one-item list.
    const props = (z.toJSONSchema(z.object(tool.input), { io: "input" }) as { properties?: Record<string, { type?: string }> }).properties ?? {};
    for (const [k, v] of Object.entries(args)) if (props[k]?.type === "array" && !Array.isArray(v)) args[k] = [v];
    raw = args;
  }

  const parsed = z.object(tool.input).safeParse(raw);
  if (!parsed.success) {
    fail(`Invalid arguments for ${tool.name}:\n${z.prettifyError(parsed.error)}\nRun "p6 help ${tool.name}" for the schema.`);
  }

  try {
    out(await tool.run(parsed.data));
  } catch (err) {
    fail((err as Error).message);
  } finally {
    if (process.env.P6_BASE_URL) await p6().logout().catch(() => undefined);
  }
}

await main();
