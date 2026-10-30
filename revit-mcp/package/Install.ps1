<#
.SYNOPSIS
  Installs Revit MCP from this package: the Revit add-in, the MCP server,
  and the Claude Desktop configuration.
.PARAMETER RevitVersion
  Revit versions to install for (2023-2026). By default, every installed
  version that is detected.
.PARAMETER SkipClaudeDesktop
  Don't change claude_desktop_config.json.
.EXAMPLE
  ./Install.ps1
  ./Install.ps1 -RevitVersion 2024,2025
#>
param(
    [string[]]$RevitVersion,
    [switch]$SkipClaudeDesktop
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$supported = "2023", "2024", "2025", "2026"

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }

# Downloaded files are blocked by Windows and Revit refuses to load them.
try { Get-ChildItem $root -Recurse -File | Unblock-File -ErrorAction Stop } catch { }

# Accept "2024,2025" as one string too (that's how Install.cmd passes it).
$versions = @($RevitVersion | ForEach-Object { $_ -split '[,\s]+' } | Where-Object { $_ })
foreach ($version in $versions) {
    if ($supported -notcontains $version) { throw "Unsupported Revit version '$version'. Use one of: $($supported -join ', ')." }
}
if ($versions.Count -eq 0) {
    $versions = @($supported | Where-Object {
        (Test-Path (Join-Path $env:ProgramFiles "Autodesk\Revit $_\Revit.exe")) -or
        (Test-Path (Join-Path $env:APPDATA "Autodesk\Revit\Addins\$_"))
    })
    if ($versions.Count -eq 0) {
        throw "No Revit 2023-2026 installation found. Run again with -RevitVersion <year>."
    }
}

# 1. Revit add-in
foreach ($version in $versions) {
    Write-Step "Installing the Revit $version add-in"
    $source = Join-Path $root "addin\Revit$version"
    $addins = Join-Path $env:APPDATA "Autodesk\Revit\Addins\$version"
    New-Item -ItemType Directory -Force -Path (Join-Path $addins "RevitMcp") | Out-Null
    Copy-Item (Join-Path $source "RevitMcp\*") (Join-Path $addins "RevitMcp") -Recurse -Force
    Copy-Item (Join-Path $source "RevitMcp.addin") $addins -Force
    Write-Host "    $addins"
}

# 2. MCP server, copied to a fixed place so the zip folder can be deleted.
Write-Step "Installing the MCP server"
$serverDir = Join-Path $env:LOCALAPPDATA "RevitMCP"
New-Item -ItemType Directory -Force -Path $serverDir | Out-Null
Copy-Item (Join-Path $root "server\revit-mcp.mjs") $serverDir -Force
$serverPath = (Join-Path $serverDir "revit-mcp.mjs") -replace '\\', '/'
Write-Host "    $serverPath"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Warning "Node.js was not found. Install Node.js 18 or later from https://nodejs.org, then restart Claude."
}

# 3. Claude Desktop
if (-not $SkipClaudeDesktop) {
    Write-Step "Configuring Claude Desktop"
    $configDir = Join-Path $env:APPDATA "Claude"
    $configPath = Join-Path $configDir "claude_desktop_config.json"
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null

    if (Test-Path $configPath) {
        Copy-Item $configPath "$configPath.bak" -Force
        $raw = Get-Content $configPath -Raw
        if ([string]::IsNullOrWhiteSpace($raw)) { $config = New-Object PSObject }
        else { $config = $raw | ConvertFrom-Json }
    } else {
        $config = New-Object PSObject
    }
    if (-not ($config.PSObject.Properties.Name -contains "mcpServers")) {
        $config | Add-Member -NotePropertyName mcpServers -NotePropertyValue (New-Object PSObject)
    }
    $entry = [pscustomobject]@{ command = "node"; args = @($serverPath) }
    if ($config.mcpServers.PSObject.Properties.Name -contains "revit") { $config.mcpServers.revit = $entry }
    else { $config.mcpServers | Add-Member -NotePropertyName revit -NotePropertyValue $entry }

    $json = $config | ConvertTo-Json -Depth 32
    [System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "    $configPath (backup: claude_desktop_config.json.bak)"
}

Write-Host ""
Write-Host "Revit MCP is installed." -ForegroundColor Green
Write-Host " - Restart Revit. You'll find the bridge under Add-Ins > Revit MCP."
Write-Host " - Restart Claude Desktop so it loads the 'revit' tools."
Write-Host " - Claude Code: install the plugin from the 'plugin' folder, or run:"
Write-Host "     claude mcp add revit -- node `"$serverPath`""
Write-Host " - Optional: upload skill\revit-skill.zip in Claude (Settings > Capabilities > Skills)."
Write-Host "Then open a model and ask Claude: 'ping Revit'."
