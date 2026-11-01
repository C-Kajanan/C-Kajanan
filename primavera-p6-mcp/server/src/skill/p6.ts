#!/usr/bin/env node
// primavera-p6 skill: command-line entry point (bundled as scripts/p6.mjs).
//
// Reads Primavera P6 XER files from the paths you pass and prints the analysis
// as JSON. It does not use the network, does not read environment variables,
// does not run other programs and does not write files.
//
//   node scripts/p6.mjs list
//   node scripts/p6.mjs help <tool>
//   node scripts/p6.mjs <tool> --file schedule.xer [--name value ...]
//   node scripts/p6.mjs <tool> '{"file":"schedule.xer","maxFloat":0}'

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createXerHandlers } from "../tools/xerHandlers.js";
import { ArgumentError, checkArgs, type ToolSpec } from "./spec.js";

const specs: ToolSpec[] = JSON.parse(readFileSync(fileURLToPath(new URL("./tools.json", import.meta.url)), "utf8"));
const handlers = createXerHandlers(() => process.cwd());

function print(value: unknown) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function exitWith(message: string, code = 1): never {
  process.stderr.write(message + "\n");
  process.exit(code);
}

/** Turns "--file a.xer --limit 5 --status Completed --status 'In Progress'" into an object. */
function parseFlags(words: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (let index = 0; index < words.length; index++) {
    const match = words[index].match(/^--([A-Za-z]\w*)(?:=(.*))?$/s);
    if (!match) exitWith(`Unexpected argument "${words[index]}". Use --name value, or one JSON object.`);
    const [, name, inlineValue] = match;
    const next = words[index + 1];
    let value: unknown = inlineValue ?? (next !== undefined && !next.startsWith("--") ? words[++index] : "true");
    if (typeof value === "string" && /^[[{]/.test(value)) {
      try {
        value = JSON.parse(value);
      } catch {
        // keep it as text
      }
    }
    args[name] = name in args ? ([] as unknown[]).concat(args[name], value) : value;
  }
  return args;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    exitWith("Usage: p6.mjs list | p6.mjs help <tool> | p6.mjs <tool> --name value ... | p6.mjs <tool> '<json>'", command ? 0 : 2);
  }

  if (command === "list") {
    return print(specs.map((tool) => ({ name: tool.name, description: tool.description })));
  }

  if (command === "help") {
    const tool = specs.find((spec) => spec.name === rest[0]);
    if (!tool) exitWith(`Unknown tool "${rest[0] ?? ""}". Run "p6.mjs list".`);
    return print(tool);
  }

  const tool = specs.find((spec) => spec.name === command);
  const handler = handlers[command];
  if (!tool || !handler) exitWith(`Unknown tool "${command}". Run "p6.mjs list".`);

  let input: Record<string, unknown>;
  if (rest.length === 1 && rest[0].trim().startsWith("{")) {
    try {
      input = JSON.parse(rest[0]);
    } catch (error) {
      exitWith(`Arguments are not valid JSON: ${(error as Error).message}`);
    }
  } else {
    input = parseFlags(rest);
  }

  try {
    print(handler(checkArgs(tool, input)));
  } catch (error) {
    const prefix = error instanceof ArgumentError ? `Invalid arguments for ${tool.name}: ` : "";
    exitWith(prefix + (error as Error).message + (prefix ? `\nRun "p6.mjs help ${tool.name}" to see its arguments.` : ""));
  }
}

main();
