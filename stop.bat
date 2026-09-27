@echo off
rem MineGuard stop - kills launcher, bridge, server and dashboard.
rem Double-click me, or run: powershell -File stop.ps1
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
echo MineGuard stopped.
pause
