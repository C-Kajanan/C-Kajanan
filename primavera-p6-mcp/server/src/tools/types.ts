import type { z } from "zod";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  input: z.ZodRawShape;
  readOnly?: boolean;
  destructive?: boolean;
  /** True when the tool talks to a P6 server (as opposed to local files). */
  openWorld?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(args: any): Promise<unknown> | unknown;
}

export function page<T>(items: T[], limit: number, offset = 0) {
  return {
    total: items.length,
    offset,
    returned: Math.max(0, Math.min(limit, items.length - offset)),
    truncated: offset + limit < items.length,
    items: items.slice(offset, offset + limit),
  };
}
