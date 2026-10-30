@echo off
rem Double-click to install Revit MCP for every Revit version found on this PC.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1" %*
echo.
pause
