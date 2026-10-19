@echo off
setlocal
cd /d "%~dp0"
title XD Pool Claude Bridge
echo Starting WorkBuddy -> Claude Code bridge...
echo Press Ctrl+C to stop.
echo.
node --experimental-transform-types --no-warnings bridge.ts
echo.
echo Bridge stopped.
pause
