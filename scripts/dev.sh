#!/usr/bin/env bash
# Start Expo Metro and, on exit (ctrl-c), shut the iOS Simulator down too.
# So one ctrl-c kills both — no more manual cmd-q on the Simulator.

set -euo pipefail

cleanup() {
  echo ""
  echo "→ Shutting down iOS Simulator…"
  # Power off every booted simulator (harmless if none are booted).
  xcrun simctl shutdown all 2>/dev/null || true
  # Quit the Simulator.app window itself.
  osascript -e 'tell application "Simulator" to quit' 2>/dev/null || true
}

# Run cleanup whenever this script exits — ctrl-c (INT), TERM, or normal exit.
trap cleanup EXIT

# Pass through any extra args, e.g. `npm run dev -- --ios`.
npx expo start "$@"
