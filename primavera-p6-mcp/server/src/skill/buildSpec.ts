// Build step for the primavera-p6 skill. Writes, from the zod schemas the MCP
// server uses:
//   <skillDir>/scripts/tools.json   argument spec that scripts/p6.mjs checks against
//   <skillDir>/references/tools.md  human-readable tool reference
// Usage: node build/skill/buildSpec.js <skillDir>

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { xerTools } from "../tools/xerTools.js";
import type { ArgSpec, ToolSpec } from "./spec.js";

interface JsonSchemaProperty {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  items?: { type?: string; enum?: string[] };
}

function toArgSpec(name: string, property: JsonSchemaProperty, required: boolean): ArgSpec {
  const spec: ArgSpec = { name, type: (property.type ?? "object") as ArgSpec["type"], required };
  if (property.description) spec.description = property.description;
  if (property.default !== undefined) spec.default = property.default;
  if (property.enum) spec.enum = property.enum;
  if (property.minimum !== undefined) spec.minimum = property.minimum;
  if (property.maximum !== undefined) spec.maximum = property.maximum;
  if (property.items) {
    spec.items = { type: (property.items.type ?? "string") as "string" };
    if (property.items.enum) spec.items.enum = property.items.enum;
  }
  return spec;
}

export function buildToolSpecs(): ToolSpec[] {
  return xerTools.map((tool) => {
    const schema = z.toJSONSchema(z.object(tool.input), { io: "input" }) as {
      properties?: Record<string, JsonSchemaProperty>;
      required?: string[];
    };
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      args: Object.entries(schema.properties ?? {}).map(([name, property]) => toArgSpec(name, property, schema.required?.includes(name) ?? false)),
    };
  });
}

function typeLabel(arg: ArgSpec): string {
  const quoteAll = (values: string[]) => values.map((value) => JSON.stringify(value)).join(" \\| ");
  if (arg.enum) return quoteAll(arg.enum);
  if (arg.type === "array") return `${arg.items?.enum ? quoteAll(arg.items.enum) : (arg.items?.type ?? "string")}[]`;
  if (arg.type === "object") return "object of strings";
  return arg.type;
}

export function toMarkdown(specs: ToolSpec[]): string {
  const lines = [
    "# Tool reference",
    "",
    "Generated from the tool definitions. Run `node scripts/p6.mjs help <tool>` to print one tool's arguments.",
    "",
    "Durations and floats are working days. Dates are as P6 exported them.",
    "",
  ];
  for (const tool of specs) {
    lines.push(`## \`${tool.name}\``, "", tool.description, "");
    if (!tool.args.length) {
      lines.push("No arguments.", "");
      continue;
    }
    lines.push("| Argument | Type | Notes |", "| --- | --- | --- |");
    for (const arg of tool.args) {
      const range = arg.minimum !== undefined || arg.maximum !== undefined ? `${arg.minimum ?? ""}–${arg.maximum ?? ""}` : "";
      const notes = [arg.required ? "**required**" : "", arg.description ?? "", range ? `range ${range}` : "", arg.default !== undefined ? `default \`${JSON.stringify(arg.default)}\`` : ""]
        .filter(Boolean)
        .join(". ")
        .replace(/\|/g, "\\|");
      lines.push(`| \`${arg.name}\` | ${typeLabel(arg)} | ${notes} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

const skillDir = process.argv[2];
if (skillDir) {
  const specs = buildToolSpecs();
  writeFileSync(join(skillDir, "scripts", "tools.json"), JSON.stringify(specs, null, 2) + "\n");
  writeFileSync(join(skillDir, "references", "tools.md"), toMarkdown(specs));
}
