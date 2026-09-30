@echo off
setlocal
title ComfyUI Mobile Studio
cd /d "%~dp0"

rem Starts only the web app in this window (ComfyUI must already be running).
rem For ComfyUI + app + tunnel in one go, use start-demo.bat.
rem ASCII only on purpose - Korean messages are printed by scripts\say.mjs.

call "%~dp0scripts\check-setup.bat"
if errorlevel 1 goto :fail

node scripts\say.mjs app-only
node server\index.js

:fail
echo.
pause
