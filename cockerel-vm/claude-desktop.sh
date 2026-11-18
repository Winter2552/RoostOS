#!/usr/bin/env bash
# Opens a terminal with Claude Code in ~/claude-work. Used by the desktop icon, the menu and at login.
# Closes with the window; nothing stays running afterwards. If Claude is missing or stops with an
# error, the window stays open and says so instead of vanishing.
[ "${1:-}" = "--delay" ] && sleep 3
mkdir -p "$HOME/claude-work"
exec xfce4-terminal --title=Claude --working-directory="$HOME/claude-work" -x bash -c '
export PATH="$HOME/.local/bin:$PATH"
if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code is not installed for $USER yet. Trying now..."
  curl -fsSL https://claude.ai/install.sh | bash
  hash -r
fi
if command -v claude >/dev/null 2>&1; then
  claude
  code=$?
  [ "$code" = 0 ] && exit 0
  echo; echo "Claude stopped with an error ($code)."
else
  echo; echo "Could not install Claude Code (is the VPN up?). Run Update all in Roost to try again."
fi
read -r -p "Press Enter to close this window."
'
