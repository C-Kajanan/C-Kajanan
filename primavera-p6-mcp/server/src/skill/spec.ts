// Argument spec for the skill's tools (scripts/tools.json) and the checker
// that applies it. Plain code with no dependencies, so the bundled skill script
// stays small and readable.

export interface ArgSpec {
  name: string;
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  required: boolean;
  description?: string;
  default?: unknown;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  items?: { type: "string"; enum?: string[] };
}

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  args: ArgSpec[];
}

export class ArgumentError extends Error {}

function checkValue(arg: ArgSpec, value: unknown): unknown {
  const fail = (expected: string) => {
    throw new ArgumentError(`"${arg.name}" must be ${expected} (got ${JSON.stringify(value)}).`);
  };
  switch (arg.type) {
    case "string":
      if (typeof value !== "string") fail("text");
      if (arg.enum && !arg.enum.includes(value as string)) fail(`one of ${arg.enum.join(", ")}`);
      return value;
    case "number":
    case "integer": {
      const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      if (typeof number !== "number" || !Number.isFinite(number)) fail("a number");
      const checked = number as number;
      if (arg.type === "integer" && !Number.isInteger(checked)) fail("a whole number");
      if (arg.minimum !== undefined && checked < arg.minimum) fail(`at least ${arg.minimum}`);
      if (arg.maximum !== undefined && checked > arg.maximum) fail(`at most ${arg.maximum}`);
      return checked;
    }
    case "boolean":
      if (value === "true") return true;
      if (value === "false") return false;
      if (typeof value !== "boolean") fail("true or false");
      return value;
    case "array": {
      const list = Array.isArray(value) ? value : [value];
      for (const item of list) {
        if (typeof item !== "string") fail("a list of text values");
        if (arg.items?.enum && !arg.items.enum.includes(item)) fail(`a list of: ${arg.items.enum.join(", ")}`);
      }
      return list;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) fail("an object");
      for (const entry of Object.values(value as object)) if (typeof entry !== "string") fail("an object of text values");
      return value;
    }
  }
}

/** Validate arguments against a tool spec and fill in defaults. Unknown arguments are rejected. */
export function checkArgs(tool: ToolSpec, input: Record<string, unknown>): Record<string, unknown> {
  const known = new Set(tool.args.map((arg) => arg.name));
  const unknown = Object.keys(input).filter((name) => !known.has(name));
  if (unknown.length) throw new ArgumentError(`Unknown argument${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. Valid: ${[...known].join(", ")}.`);
  const result: Record<string, unknown> = {};
  for (const arg of tool.args) {
    const value = input[arg.name];
    if (value === undefined) {
      if (arg.default !== undefined) result[arg.name] = arg.default;
      else if (arg.required) throw new ArgumentError(`Missing required argument "${arg.name}".`);
      continue;
    }
    result[arg.name] = checkValue(arg, value);
  }
  return result;
}
