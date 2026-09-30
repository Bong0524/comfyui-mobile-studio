@echo off
setlocal
title ComfyUI Mobile Studio - tests
cd /d "%~dp0"

rem Runs the unit + end-to-end tests (mock ComfyUI, no GPU needed) and the workflow check.
rem ASCII only on purpose - Korean messages are printed by scripts\say.mjs.
where node >nul 2>nul
if errorlevel 1 goto :nonode

node --test
if errorlevel 1 goto :failed
node scripts\workflow-check.mjs
node scripts\say.mjs tests-passed
goto :end

:failed
node scripts\say.mjs tests-failed
goto :end

:nonode
echo [!] Node.js was not found. Install Node.js 22 LTS or newer: https://nodejs.org

:end
echo.
pause
