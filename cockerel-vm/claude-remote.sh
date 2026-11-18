#!/usr/bin/env bash
# Starts Claude Code so Raven can open it from the Claude app (Remote Control).
# Only runs while this window is open; nothing in the background.
cd "$HOME/cockerel" || exit 1
if claude remote-control --help >/dev/null 2>&1; then
  claude remote-control || true
else
  echo "This Claude Code version has no 'remote-control' command."
  echo "Starting Claude; type /remote-control inside it (or run 'claude update')."
  claude || true
fi
echo; read -r -p "Closed. Press Enter to close this window."
