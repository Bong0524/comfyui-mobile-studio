@echo off
setlocal
title ComfyUI Mobile Studio - launcher
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  One-click demo launcher (Windows)
rem    1. ComfyUI            only if it is not running and COMFYUI_DIR is set in .env
rem    2. Web app            new window
rem    3. Cloudflare Tunnel  new window, only if CLOUDFLARE_TUNNEL_TOKEN is set
rem    4. Opens the app in the browser
rem  Close the windows to stop everything.
rem
rem  This file stays ASCII on purpose. Korean messages live in scripts\say.mjs:
rem  UTF-8 text inside .bat files breaks on some cmd setups, and CP949 files show
rem  as garbled text on GitHub.
rem ---------------------------------------------------------------------------

call "%~dp0scripts\check-setup.bat"
if errorlevel 1 goto :fail

set "COMFYUI_DIR="
set "DOMAIN="
for /f "delims=" %%V in ('node scripts\env-get.mjs APP_PORT 8080') do set "APP_PORT=%%V"

rem ---- 1. ComfyUI -------------------------------------------------------------
node scripts\wait-for.mjs comfyui 2 >nul
if errorlevel 1 goto :startcomfy
node scripts\say.mjs comfy-running
goto :app

:startcomfy
for /f "delims=" %%V in ('node scripts\env-get.mjs COMFYUI_DIR') do set "COMFYUI_DIR=%%V"
for /f "delims=" %%V in ('node scripts\env-get.mjs COMFYUI_EXTRA_ARGS "--preview-method auto"') do set "COMFYUI_EXTRA_ARGS=%%V"
for /f "delims=" %%V in ('node scripts\env-get.mjs --comfy-port') do set "COMFYUI_PORT=%%V"

if defined COMFYUI_DIR goto :checkcomfydir
rem COMFYUI_DIR is empty: look for a ComfyUI portable folder and remember it in .env
node scripts\say.mjs comfy-searching
for /f "delims=" %%V in ('node scripts\env-get.mjs --find-comfy') do set "COMFYUI_DIR=%%V"
if not defined COMFYUI_DIR goto :nocomfydir
node scripts\env-get.mjs --set COMFYUI_DIR "%COMFYUI_DIR%"
node scripts\say.mjs comfy-found "%COMFYUI_DIR%"

:checkcomfydir
if not exist "%COMFYUI_DIR%\python_embeded\python.exe" goto :badcomfydir

node scripts\say.mjs comfy-starting %COMFYUI_PORT%
rem No --listen: ComfyUI stays on localhost. Only the web app is published through the tunnel.
start "ComfyUI" "%COMFYUI_DIR%\python_embeded\python.exe" -s "%COMFYUI_DIR%\ComfyUI\main.py" --windows-standalone-build --disable-auto-launch --port %COMFYUI_PORT% %COMFYUI_EXTRA_ARGS%
goto :waitcomfy

:nocomfydir
node scripts\say.mjs no-comfy-dir
goto :waitcomfy

:badcomfydir
node scripts\say.mjs bad-comfy-dir "%COMFYUI_DIR%"

:waitcomfy
node scripts\say.mjs comfy-waiting
node scripts\wait-for.mjs comfyui 180
if errorlevel 1 goto :comfydown
node scripts\say.mjs comfy-up
goto :app

:comfydown
node scripts\say.mjs comfy-down

rem ---- 2. Web app -------------------------------------------------------------
:app
node scripts\wait-for.mjs app 1 >nul
if errorlevel 1 goto :startapp
node scripts\say.mjs app-running %APP_PORT%
goto :tunnel

:startapp
node scripts\say.mjs app-starting
start "ComfyUI Mobile Studio - app" cmd /k node server\index.js
node scripts\wait-for.mjs app 20
if errorlevel 1 goto :appfailed
node scripts\say.mjs app-ok %APP_PORT%

rem ---- 3. Cloudflare Tunnel ---------------------------------------------------
:tunnel
node scripts\env-get.mjs --has CLOUDFLARE_TUNNEL_TOKEN
if errorlevel 1 goto :notunnel
node scripts\say.mjs tunnel-starting
start "ComfyUI Mobile Studio - tunnel" cmd /k node scripts\tunnel.mjs
for /f "delims=" %%V in ('node scripts\env-get.mjs DOMAIN') do set "DOMAIN=%%V"
if defined DOMAIN node scripts\say.mjs public-url %DOMAIN%
goto :browser

:notunnel
node scripts\say.mjs no-tunnel

rem ---- 4. Browser -------------------------------------------------------------
:browser
start "" "http://127.0.0.1:%APP_PORT%"
node scripts\say.mjs running
pause
exit /b 0

:appfailed
node scripts\say.mjs app-failed

:fail
echo.
pause
exit /b 1
