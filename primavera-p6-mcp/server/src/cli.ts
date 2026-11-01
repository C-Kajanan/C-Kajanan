#!/usr/bin/env node
// Command-line front end to the same tools the MCP server exposes. The
// primavera-p6 skill bundles this file so the tools run without an MCP
// client or an npm install.
//
//   p6 list                          tools available with the current environment
//   p6 help <tool>                   description and JSON schema of a tool's arguments
//   p6 docs                          Markdown reference of every tool (used to build the skill)
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

  if (cmd === "docs") {
    const lines: string[] = [
      "# Tool reference",
      "",
      "Generated from the tool schemas by `p6.mjs docs`. Run `node scripts/p6.mjs help <tool>` for the JSON schema of one tool.",
      "",
    ];
    const groups: [string, ToolDef[]][] = [
      ["XER files (no P6 server needed)", xerTools],
      ["Live P6, read (needs P6_BASE_URL)", p6ReadTools],
      ["Live P6, write (needs P6_BASE_URL and P6_ALLOW_WRITES=1)", p6WriteTools],
    ];
    for (const [heading, tools] of groups) {
      lines.push(`## ${heading}`, "");
      for (const t of tools) {
        lines.push(`### \`${t.name}\``, "", t.description, "");
        const schema = z.toJSONSchema(z.object(t.input), { io: "input" }) as {
          properties?: Record<string, { type?: string; description?: string; default?: unknown; enum?: unknown[]; items?: { type?: string; enum?: unknown[] } }>;
          required?: string[];
        };
        const props = Object.entries(schema.properties ?? {});
        if (!props.length) {
          lines.push("No arguments.", "");
          continue;
        }
        lines.push("| Argument | Type | Notes |", "| --- | --- | --- |");
        for (const [name, p] of props) {
          const type = p.enum ? p.enum.map((e) => JSON.stringify(e)).join(" \\| ") : p.type === "array" ? `${p.items?.enum ? p.items.enum.map((e) => JSON.stringify(e)).join(" \\| ") : (p.items?.type ?? "any")}[]` : (p.type ?? "object");
          const notes = [schema.required?.includes(name) ? "**required**" : "", p.description ?? "", p.default !== undefined ? `default \`${JSON.stringify(p.default)}\`` : ""]
            .filter(Boolean)
            .join(". ")
            .replace(/\|/g, "\\|");
          lines.push(`| \`${name}\` | ${type} | ${notes} |`);
        }
        lines.push("");
      }
    }
    process.stdout.write(lines.join("\n"));
    return;
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
