#!/usr/bin/env bash
# Opens a terminal with Claude Code in ~/claude-work. Used by the desktop launcher and at login.
# Closes with the window; nothing stays running afterwards.
[ "${1:-}" = "--delay" ] && sleep 3
mkdir -p "$HOME/claude-work"
exec xfce4-terminal --title=Claude --working-directory="$HOME/claude-work" -x "$HOME/.local/bin/claude"
