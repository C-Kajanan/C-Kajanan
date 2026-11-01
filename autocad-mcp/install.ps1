<#
.SYNOPSIS
  Builds the AutoCAD MCP plug-in and the MCP server, and installs the plug-in
  as an autoloader bundle so AutoCAD loads it on startup.
.EXAMPLE
  ./install.ps1 -AcadVersion 2025
.EXAMPLE
  ./install.ps1 -AcadVersion 2024 -AllUsers    # run as administrator
.EXAMPLE
  ./install.ps1 -AcadVersion 2025 -Skill       # also install the Claude Code skill
#>
param(
    [ValidateSet("2021", "2022", "2023", "2024", "2025", "2026", "2027")]
    [string]$AcadVersion = "2025",
    # Install to %ProgramData% (a trusted location for every user) instead of %APPDATA%.
    [switch]$AllUsers,
    # Also install the "autocad" skill for Claude Code to %USERPROFILE%\.claude\skills\autocad.
    [switch]$Skill
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

$series = if ([int]$AcadVersion -lt 2025) { "R24" } elseif ([int]$AcadVersion -lt 2027) { "R25" } else { "R26" }

Write-Host "Building plug-in for AutoCAD $AcadVersion ($series)..."
dotnet build "$root\plugin\AutoCadMcp.csproj" -c Release -p:AcadVersion=$AcadVersion | Out-Host
if ($LASTEXITCODE -ne 0) { throw "Plug-in build failed." }

$base = if ($AllUsers) { $env:ProgramData } else { $env:APPDATA }
$bundle = Join-Path $base "Autodesk\ApplicationPlugins\AutoCadMcp.bundle"
$target = Join-Path $bundle "Contents\$series"
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item "$root\plugin\bin\Release\$series\*" $target -Recurse -Force
Copy-Item "$root\plugin\PackageContents.xml" $bundle -Force
Write-Host "Plug-in installed to $bundle"

Write-Host "Building MCP server..."
Push-Location "$root\server"
npm install | Out-Host
npm run build | Out-Host
Pop-Location

if ($Skill) {
    $skillTarget = Join-Path $env:USERPROFILE ".claude\skills\autocad"
    New-Item -ItemType Directory -Force -Path $skillTarget | Out-Null
    Copy-Item "$root\skill\autocad\*" $skillTarget -Recurse -Force
    Write-Host "Skill installed to $skillTarget"
}

$serverPath = (Resolve-Path "$root\server\build\index.js").Path -replace '\\', '/'
Write-Host ""
Write-Host "Done. Restart AutoCAD (choose 'Always Load' if it asks about AutoCadMcp.dll),"
Write-Host "then add this to your MCP client config (e.g. claude_desktop_config.json):"
Write-Host @"
{
  "mcpServers": {
    "autocad": {
      "command": "node",
      "args": ["$serverPath"]
    }
  }
}
"@
