@echo off
rem Shared pre-flight checks for the Windows launchers. Exit code 1 = cannot start.
rem This file stays ASCII; Korean messages are printed by scripts\say.mjs.
pushd "%~dp0.."

where node >nul 2>nul
if errorlevel 1 goto :nonode
node -e "process.exit(+process.versions.node.split('.')[0] >= 22 ? 0 : 1)"
if errorlevel 1 goto :oldnode

if exist ".env" goto :envok
node scripts\say.mjs first-run
node scripts\init-env.mjs
node scripts\say.mjs review-env
notepad ".env"
goto :stop

:envok
node scripts\env-get.mjs --has ACCESS_TOKEN
if errorlevel 1 goto :notoken
if not exist "config\models.json" node scripts\init-env.mjs
popd
exit /b 0

:nonode
rem Node is missing, so Korean output via say.mjs is not possible here.
echo [!] Node.js was not found. Install Node.js 22 LTS or newer: https://nodejs.org
goto :stop

:oldnode
for /f "delims=" %%V in ('node -v') do node scripts\say.mjs old-node %%V
goto :stop

:notoken
node scripts\say.mjs no-token
notepad ".env"
goto :stop

:stop
popd
exit /b 1
