@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem KEEP THIS FILE PURE ASCII.
rem cmd.exe tracks its position in a batch file by byte offset, so once a UTF-8
rem code page is active (see chcp above) any multi-byte character makes it lose
rem sync and re-read from the middle of a line -- comment fragments then get
rem executed as commands. All messages and comments here must stay ASCII.
rem ---------------------------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 (
  echo [start-web] Node.js not found. Install Node.js 22.19+ or 24+ first.
  pause
  exit /b 1
)

if not exist "node_modules" (
  where pnpm >nul 2>nul
  if errorlevel 1 (
    echo [start-web] node_modules is missing and pnpm was not found. Install pnpm first.
    pause
    exit /b 1
  )
  echo [start-web] node_modules is missing, running pnpm install...
  pnpm install
  if errorlevel 1 goto failed
)

rem Respect an explicit --port: only guess at the default when the user gave none.
rem Matches both "--port 3090" and "--port=3090".
set "HAS_PORT="
for %%A in (%*) do (
  echo %%~A| findstr /b /i /c:"--port" >nul
  if not errorlevel 1 set "HAS_PORT=1"
)

rem Without this check a busy port surfaces as a 40-line plugin-tree stack trace
rem that never mentions the actual cause.
if not defined HAS_PORT (
  netstat -ano | findstr /c:":3080 " | findstr /i /c:"LISTENING" >nul
  if not errorlevel 1 (
    echo [start-web] Port 3080 is already in use - another instance is probably running.
    echo [start-web] Close it, or start on a free port:  start-web.cmd --port 3090
    pause
    exit /b 1
  )
)

echo [start-web] Starting DeepSeek Harness Web...
rem Launch the repo's own source launcher, i.e. the "dsh" script from package.json.
rem Deliberately NOT "pnpm dsh": pnpm re-verifies dependencies before running a
rem script, so any install-time problem (lefthook lock, postinstall failure,
rem corepack shim path) would surface as "the web app failed to start" even
rem though the app itself is fine.
node --import tsx/esm apps/cli/src/bin.ts --profile web %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo [start-web] dsh exited with code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%

:failed
echo [start-web] Startup failed.
pause
exit /b 1
