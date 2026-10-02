@echo off
setlocal
title ComfyUI Mobile Studio - models
cd /d "%~dp0"

rem Lists the checkpoints/LoRAs ComfyUI can see (ComfyUI must be running) and
rem marks the ones the app publishes (default: models in the "portfolio"
rem sub-folder), then opens config\models.json for optional labels/defaults.
rem ASCII only on purpose - Korean messages are printed by the Node scripts.

where node >nul 2>nul
if errorlevel 1 goto :nonode
if not exist "config\models.json" node scripts\init-env.mjs

node scripts\list-models.mjs
echo.
pause
notepad "config\models.json"
goto :end

:nonode
echo [!] Node.js was not found. Install Node.js 22 LTS or newer: https://nodejs.org
pause

:end
