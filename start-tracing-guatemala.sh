#!/bin/sh
# Starts Tracing Guatemala (Live) on macOS or Linux and opens it in your browser.
# Press Ctrl+C in this window, or close it, to stop. Your data is saved as you go.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 22.12 or newer from https://nodejs.org, then run this again."
  exit 1
fi
if ! node -e "const [a, b] = process.versions.node.split('.').map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)"; then
  echo "Node.js $(node --version) is too old. Install Node.js 22.12 or newer from https://nodejs.org."
  exit 1
fi

if [ ! -f dist-web/server/main.mjs ]; then
  echo "Building Tracing Guatemala for the first time (this takes a minute)..."
  npm run web:build || { echo "The build failed. Run npm install, then try again."; exit 1; }
fi

node --disable-warning=ExperimentalWarning dist-web/server/main.mjs --open
status=$?
if [ "$status" -ne 0 ]; then
  echo
  echo "Tracing Guatemala did not start, or stopped with a problem (see above)."
  printf "Press Enter to close. "
  read -r _
fi
exit "$status"
