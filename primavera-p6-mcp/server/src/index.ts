#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { p6, p6ReadTools, p6WriteTools, writesEnabled } from "./tools/p6Tools.js";
import { xerTools } from "./tools/xerTools.js";
import type { ToolDef } from "./tools/types.js";

const tools: ToolDef[] = [...xerTools, ...(process.env.P6_BASE_URL ? p6ReadTools : []), ...(process.env.P6_BASE_URL && writesEnabled() ? p6WriteTools : [])];

const server = new McpServer(
  { name: "primavera-p6-mcp", version: "0.1.0" },
  {
    instructions:
      "Tools for Oracle Primavera P6 schedules. xer_* tools analyse XER files exported from P6 and need only a file path; durations and floats there are working days. p6_* tools talk to a live P6 EPPM server; its durations, floats and lags are hours. To analyse a live project in depth, export it with p6_export_xer and use the xer_* tools on the file.",
  },
);

for (const tool of tools) {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input,
      annotations: {
        readOnlyHint: tool.readOnly ?? false,
        destructiveHint: tool.destructive ?? false,
        openWorldHint: tool.openWorld ?? false,
      },
    },
    async (args: Record<string, unknown>) => {
      try {
        const result = await tool.run(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text" as const, text: (err as Error).message }] };
      }
    },
  );
}

const shutdown = async () => {
  if (process.env.P6_BASE_URL) await p6().logout().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
console.error(
  `primavera-p6-mcp: ${tools.length} tools` +
    (process.env.P6_BASE_URL ? `, P6 server ${process.env.P6_BASE_URL}${writesEnabled() ? " (writes enabled)" : " (read-only)"}` : ", XER files only (set P6_BASE_URL for a live server)"),
);
