@echo off
rem Starts Tracing Guatemala (Live) on Windows and opens it in your browser.
rem Press Ctrl+C in this window, or close it, to stop. Your data is saved as you go.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 22.12 or newer from https://nodejs.org, then run this again.
  pause
  exit /b 1
)
node -e "const [a, b] = process.versions.node.split('.').map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)"
if errorlevel 1 (
  echo Your Node.js is too old. Install Node.js 22.12 or newer from https://nodejs.org, then run this again.
  pause
  exit /b 1
)

if not exist "dist-web\server\main.mjs" (
  echo Building Tracing Guatemala for the first time, this takes a minute...
  call npm run web:build
  if errorlevel 1 (
    echo The build failed. Run npm install, then try again.
    pause
    exit /b 1
  )
)

node --disable-warning=ExperimentalWarning dist-web\server\main.mjs --open
if errorlevel 1 (
  echo.
  echo Tracing Guatemala did not start, or stopped with a problem. See the message above.
  pause
)
