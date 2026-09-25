@echo off
title MineGuard Control Room
cd /d "%~dp0"
echo Starting MineGuard — server + dashboard + browser...
echo.
node start.js
echo.
pause
