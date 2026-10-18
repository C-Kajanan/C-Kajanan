#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RevitClient } from "./revitClient.js";
import { tools } from "./tools.js";

const client = RevitClient.fromEnv();

const server = new McpServer({ name: "revit-mcp", version: "0.1.0" });

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
        openWorldHint: false,
      },
    },
    async (args: Record<string, unknown>) => {
      try {
        const result = await client.call(tool.name, args);
        if (tool.image) {
          const { mimeType, base64, ...rest } = result as { mimeType: string; base64: string };
          return {
            content: [
              { type: "image" as const, data: base64, mimeType },
              { type: "text" as const, text: JSON.stringify(rest) },
            ],
          };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text" as const, text: (err as Error).message }] };
      }
    },
  );
}

await server.connect(new StdioServerTransport());
console.error(`revit-mcp: ${tools.length} tools, forwarding to Revit on port ${process.env.REVIT_MCP_PORT ?? "48884"}`);
