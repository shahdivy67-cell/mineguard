@echo off
rem MineGuard Control Room - one-click start (server + serial bridge + browser).
rem Double-click me, or run: node start.js
title MineGuard Control Room
cd /d "%~dp0"
echo Starting MineGuard — server + dashboard + browser...
echo.
node start.js
echo.
pause
