#!/usr/bin/env bash
# Starts Claude Code so Raven can open it from the Claude app (Remote Control).
# Only runs while this window is open; nothing in the background.
mkdir -p "$HOME/claude-work"; cd "$HOME/claude-work" || exit 1
export PATH="$HOME/.local/bin:$PATH"
if claude remote-control --help >/dev/null 2>&1; then
  claude remote-control || true
else
  echo "This Claude Code version has no 'remote-control' command."
  echo "Starting Claude; type /remote-control inside it (or run 'claude update')."
  claude || true
fi
echo; read -r -p "Closed. Press Enter to close this window."
