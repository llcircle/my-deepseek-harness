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
rem Two paths, in this order on purpose:
rem   FAST  an instance already answers on the port -> open it and return.
rem         Costs a cmd start plus one curl probe: well under a second. It runs
rem         BEFORE every node invocation, because starting node at all costs
rem         100-300ms and the whole point of this path is not to pay that.
rem   SLOW  nothing is serving -> start one in its own window.
rem         A cold boot is dominated by module resolution, not by this script,
rem         so the script's job is to not add to it. Keep the server running and
rem         every later launch takes the fast path.
rem ---------------------------------------------------------------------------

rem Never inherit NODE_OPTIONS. A wrapper that points it at a --require shim
rem changes how the app starts, and a bulk-delete guard in particular makes the
rem app's own temp cleanup fail. The launcher starts a plain node.
set "NODE_OPTIONS="

rem Opt out of session telemetry before boot. apps/cli/src/profile-boot.ts reads
rem this and patches the telemetry row disabled, so the OTel SDK is never even
rem imported. Measured on this tree: importing it costs ~0.8s on every boot
rem (~1500 extra module resolutions, ~44% of all module work). Note that
rem DSH_TELEMETRY_MODE=DISABLED is NOT equivalent -- it short-circuits at
rem runtime, after the modules are already loaded. Set DSH_WEB_TELEMETRY=1 to
rem keep telemetry on.
if not "%DSH_WEB_TELEMETRY%"=="1" set "DSH_TELEMETRY_DISABLED=1"

rem === FAST PATH: an instance is already serving ==============================
rem Only for a bare "start-web.cmd". With arguments the port is unknown here and
rem the intent is not necessarily "give me whatever is already running", so the
rem slow path owns that case.
if not "%~1"=="" goto slow_path

rem Windows 10 1803+ ships curl. Without it, fall through: the probe is an
rem optimisation, never a prerequisite.
where curl >nul 2>nul
if errorlevel 1 goto slow_path

rem Any HTTP status counts, including 404: what matters is that something
rem answers, not what it answers with. Bounded so a half-dead listener cannot
rem hang the launcher.
curl -s -o nul -m 1 --connect-timeout 1 "http://127.0.0.1:3080/" 2>nul
if errorlevel 1 goto slow_path

echo [start-web] Port 3080 is already serving - opening the running instance.
start "" "http://127.0.0.1:3080/"
exit /b 0

rem === SLOW PATH: nothing is serving, so start one ============================
:slow_path

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
rem that never mentions the actual cause. Reached only when the port is held by
rem something that is not an answering dsh -- an answering one took the fast
rem path above and never got here.
if not defined HAS_PORT (
  netstat -ano | findstr /c:":3080 " | findstr /i /c:"LISTENING" >nul
  if not errorlevel 1 (
    echo [start-web] Port 3080 is listening but not answering HTTP - it is not a
    echo [start-web] ready dsh instance. Listening socket, PID last:
    netstat -ano | findstr /c:":3080 " | findstr /i /c:"LISTENING"
    echo [start-web] Close it, or start on a free port:  start-web.cmd --port 3090
    pause
    exit /b 1
  )
)

rem --- 5. Boot ---------------------------------------------------------------
echo [start-web] Starting DeepSeek Harness Web in its own window...
echo [start-web]   - the browser opens once the server is ready
echo [start-web]   - about 7s with a warm file cache, longer on a cold one
echo [start-web]   - LEAVE THAT WINDOW OPEN: it is the server. Closing it stops
echo [start-web]     dsh, and the next launch has to boot again.
rem Launch the repo's own source launcher, i.e. the "dsh" script from package.json.
rem Deliberately NOT "pnpm dsh": pnpm re-verifies dependencies before running a
rem script, so any install-time problem (lefthook lock, postinstall failure,
rem corepack shim path) would surface as "the web app failed to start" even
rem though the app itself is fine.
rem "start" detaches the server from this console, so the launcher returns at
rem once while dsh keeps running -- which is exactly what the fast path later
rem finds. The trailing "pause" is why a failed boot leaves its window readable
rem instead of flashing away. Set DSH_WEB_FOREGROUND=1 to stay attached instead
rem and watch the log in this window.
if "%DSH_WEB_FOREGROUND%"=="1" goto foreground
start "dsh web" cmd /c "node --import tsx/esm apps/cli/src/bin.ts --profile web %* & if errorlevel 1 pause"
exit /b 0

:foreground
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
