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

rem Never inherit NODE_OPTIONS. A wrapper that points it at a --require shim
rem changes how the app starts, and a bulk-delete guard in particular makes the
rem app's own temp cleanup fail. The launcher starts a plain node.
set "NODE_OPTIONS="

rem --- 1. Node.js present and new enough -------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [start-web] Node.js not found. Install Node.js 22.19+ or 24+ first.
  pause
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo [start-web] This tree needs Node.js 22.19+ or 24+. Found:
  node -v
  pause
  exit /b 1
)

rem --- 2. Dependencies -------------------------------------------------------
if not exist "node_modules" (
  where pnpm >nul 2>nul
  if errorlevel 1 (
    echo [start-web] node_modules is missing and pnpm was not found. Install pnpm first.
    pause
    exit /b 1
  )
  echo [start-web] node_modules is missing, running pnpm install...
  call pnpm install
  if errorlevel 1 goto failed
)

rem --- 3. Orphan profile writer lock -----------------------------------------
rem dsh serializes writes to the shared profile module tree through a wx-created
rem sibling lock at <home>\.dsh\profiles\node_modules.lock whose content is the
rem owner's PID. A process that dies before its finally block leaves the lock
rem behind, and the next boot then burns the whole wait window and fails with
rem   atomic-write: timed out waiting for the writer lock at ...node_modules.lock
rem The implementation deliberately never clears it: "file age cannot prove that
rem its owner stopped; orphan recovery is an operator action".
rem This script takes that action only on positive proof that the owner stopped:
rem the recorded PID parses, the liveness probe itself works, the PID is gone,
rem and the file still reads the same afterwards -- so a lock that a fresh boot
rem re-created during the check is never touched. The lock is moved aside, not
rem deleted: the path is printed and the file can simply be moved back.
set "PROFILE_LOCK=%USERPROFILE%\.dsh\profiles\node_modules.lock"
if not exist "%PROFILE_LOCK%" goto port_check

where powershell >nul 2>nul
if errorlevel 1 (
  echo [start-web] A profile writer lock exists and powershell is unavailable,
  echo [start-web] so its owner cannot be checked:
  echo [start-web]   "%PROFILE_LOCK%"
  echo [start-web] Delete that file by hand if no dsh process is running.
  pause
  exit /b 1
)

echo [start-web] Profile writer lock found, checking its owner...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$lock = Join-Path $env:USERPROFILE '.dsh\profiles\node_modules.lock'; if (-not (Test-Path -LiteralPath $lock)) { exit 0 }; if (-not (Get-Process -Id $PID -ErrorAction SilentlyContinue)) { Write-Host '[start-web]   the liveness probe is unavailable here - left in place'; exit 1 }; $raw = (Get-Content -LiteralPath $lock -Raw).Trim(); $owner = 0; [void][int]::TryParse($raw, [ref]$owner); if ($owner -le 0) { Write-Host '[start-web]   the lock names no PID - left in place'; exit 1 }; if (Get-Process -Id $owner -ErrorAction SilentlyContinue) { Write-Host ('[start-web]   owner PID ' + $owner + ' is still running - left in place'); exit 1 }; if (((Get-Content -LiteralPath $lock -Raw).Trim()) -ne $raw) { Write-Host '[start-web]   the lock changed while checking - left in place'; exit 1 }; $dest = $lock + '.stale-' + (Get-Date -Format 'yyyyMMdd-HHmmss'); Move-Item -LiteralPath $lock -Destination $dest -Force; Write-Host ('[start-web]   owner PID ' + $owner + ' is gone; orphan lock moved to ' + $dest)"
if errorlevel 1 (
  echo [start-web] The lock was left in place, so this boot would stall on it.
  echo [start-web] Fix the cause, then run this script again:
  echo [start-web]   - a live dsh holds it: close that instance first
  echo [start-web]   - it is a leftover: delete the file shown above
  pause
  exit /b 1
)

rem --- 4. Port ---------------------------------------------------------------
:port_check
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
    echo [start-web] Listening socket, PID last:
    netstat -ano | findstr /c:":3080 " | findstr /i /c:"LISTENING"
    echo [start-web] Close it, or start on a free port:  start-web.cmd --port 3090
    pause
    exit /b 1
  )
)

rem --- 5. Boot ---------------------------------------------------------------
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
