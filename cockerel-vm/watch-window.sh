#!/usr/bin/env bash
# Opens the live page full screen in Chromium; falls back to the text window.
if command -v chromium >/dev/null 2>&1; then
  exec chromium --app=http://127.0.0.1:7070/live --start-fullscreen --user-data-dir="$HOME/.cache/cockerel-live" --no-first-run --disable-features=Translate
fi
exec xfce4-terminal --maximize --title="Cockerel live" --command=/opt/cockerel/watch.sh
