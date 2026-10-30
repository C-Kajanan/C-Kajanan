#!/usr/bin/env bash
# Builds the all-in-one release zip: dist/RevitMCP-v<version>.zip
# Needs: .NET 8 SDK, Node.js 18+, zip, git.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"                       # revit-mcp/
version="$(node -p "require('$root/.claude-plugin/plugin.json').version")"
name="RevitMCP-v$version"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
out="$work/$name"
mkdir -p "$out" "$here/dist"

echo "Add-in"
for v in 2023 2024 2025 2026; do
  dotnet build "$root/addin/RevitMcp.csproj" -c Release -p:RevitVersion=$v -p:Version=$version \
    -o "$work/addin-$v" -p:BaseIntermediateOutputPath="$work/obj-$v/" --nologo -v quiet
  mkdir -p "$out/addin/Revit$v/RevitMcp"
  cp "$work/addin-$v/RevitMcp.addin" "$out/addin/Revit$v/"
  cp "$work/addin-$v"/RevitMcp.{dll,pdb} "$out/addin/Revit$v/RevitMcp/"
  [ -f "$work/addin-$v/RevitMcp.deps.json" ] && cp "$work/addin-$v/RevitMcp.deps.json" "$out/addin/Revit$v/RevitMcp/"
done

echo "Server"
(cd "$root/server" && npm ci --silent && npm test --silent >/dev/null && npm run bundle --silent)
mkdir -p "$out/server"
cp "$root/server/dist/revit-mcp.mjs" "$out/server/"

echo "Plugin + skill"
mkdir -p "$out/plugin/plugin/server/dist" "$out/plugin/.claude-plugin" "$out/skill"
cp -r "$root/.claude-plugin" "$root/.mcp.json" "$root/skills" "$out/plugin/plugin/"
cp "$root/server/dist/revit-mcp.mjs" "$out/plugin/plugin/server/dist/"
cat > "$out/plugin/.claude-plugin/marketplace.json" <<JSON
{
  "name": "revit-mcp-local",
  "owner": { "name": "C-Kajanan" },
  "description": "Local copy of the Revit MCP plugin from the release zip.",
  "plugins": [{ "name": "revit", "source": "./plugin", "version": "$version" }]
}
JSON
cp -r "$root/skills/revit" "$out/skill/"
(cd "$out/skill" && zip -qr revit-skill.zip revit)

echo "Source"
mkdir -p "$out/source"
git -C "$root" archive --format=tar HEAD . | tar -x -C "$out/source"

echo "Installer + docs"
cp "$here"/Install.{cmd,ps1} "$here"/Uninstall.{cmd,ps1} "$root/LICENSE" "$out/"
sed "s/__VERSION__/$version/" "$here/README.md" > "$out/README.md"

rm -f "$here/dist/$name.zip"
(cd "$work" && zip -qr "$here/dist/$name.zip" "$name")
echo "Built $here/dist/$name.zip"
