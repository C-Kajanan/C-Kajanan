#!/usr/bin/env bash
# Builds dist/revit-mcp-<version>.mcpb (MCP Bundle for Claude Desktop's extension directory).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
server="$here/../server"
(cd "$server" && npm ci --silent && npm test --silent >/dev/null && npm run bundle --silent)

mkdir -p "$here/server" "$here/dist"
cp "$server/dist/revit-mcp.mjs" "$here/server/index.mjs"

# Fill manifest "tools" from the server's tool list so they never drift.
node --input-type=module -e "
  import { readFileSync, writeFileSync } from 'node:fs';
  const { tools } = await import('$server/build/tools.js');
  const path = '$here/manifest.json';
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.tools = tools.map(t => ({ name: t.name, description: t.description }));
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
"

npx --yes @anthropic-ai/mcpb@2.1.2 validate "$here/manifest.json"
version="$(node -p "require('$here/manifest.json').version")"
npx --yes @anthropic-ai/mcpb@2.1.2 pack "$here" "$here/dist/revit-mcp-$version.mcpb"
