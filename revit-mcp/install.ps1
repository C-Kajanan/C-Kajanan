<#
.SYNOPSIS
  Builds the Revit MCP add-in and the MCP server, and installs the add-in for one Revit version.
.EXAMPLE
  ./install.ps1 -RevitVersion 2025
#>
param(
    [ValidateSet("2023", "2024", "2025", "2026")]
    [string]$RevitVersion = "2025"
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Write-Host "Building add-in for Revit $RevitVersion..."
dotnet build "$root\addin\RevitMcp.csproj" -c Release -p:RevitVersion=$RevitVersion | Out-Host
if ($LASTEXITCODE -ne 0) { throw "Add-in build failed." }

$addins = Join-Path $env:APPDATA "Autodesk\Revit\Addins\$RevitVersion"
$target = Join-Path $addins "RevitMcp"
New-Item -ItemType Directory -Force -Path $target | Out-Null
$output = "$root\addin\bin\Release\$RevitVersion"
Copy-Item "$output\*" $target -Recurse -Force -Exclude "RevitMcp.addin"
Copy-Item "$output\RevitMcp.addin" $addins -Force
Write-Host "Add-in installed to $addins"

Write-Host "Building MCP server..."
Push-Location "$root\server"
npm install | Out-Host
npm run build | Out-Host
Pop-Location

$serverPath = (Resolve-Path "$root\server\build\index.js").Path -replace '\\', '/'
Write-Host ""
Write-Host "Done. Restart Revit, then add this to your MCP client config (e.g. claude_desktop_config.json):"
Write-Host @"
{
  "mcpServers": {
    "revit": {
      "command": "node",
      "args": ["$serverPath"]
    }
  }
}
"@
