<#
.SYNOPSIS
  Removes the Revit MCP add-in, the MCP server, and its Claude Desktop entry.
#>
$ErrorActionPreference = "Stop"

foreach ($version in "2023", "2024", "2025", "2026") {
    $addins = Join-Path $env:APPDATA "Autodesk\Revit\Addins\$version"
    $manifest = Join-Path $addins "RevitMcp.addin"
    if (Test-Path $manifest) {
        Remove-Item $manifest -Force
        Remove-Item (Join-Path $addins "RevitMcp") -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "Removed the Revit $version add-in"
    }
}

$serverDir = Join-Path $env:LOCALAPPDATA "RevitMCP"
if (Test-Path $serverDir) {
    Remove-Item $serverDir -Recurse -Force
    Write-Host "Removed $serverDir"
}

$configPath = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
if (Test-Path $configPath) {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    if ($config.mcpServers -and ($config.mcpServers.PSObject.Properties.Name -contains "revit")) {
        Copy-Item $configPath "$configPath.bak" -Force
        $config.mcpServers.PSObject.Properties.Remove("revit")
        $json = $config | ConvertTo-Json -Depth 32
        [System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "Removed 'revit' from Claude Desktop's config"
    }
}
Write-Host "Revit MCP is uninstalled. Restart Revit and Claude Desktop."
