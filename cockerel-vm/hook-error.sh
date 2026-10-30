#!/bin/sh
# aria2 runs this when a download fails.
[ -n "$COCKEREL_JOB" ] || exit 0
exec node "$(dirname "$0")/tool.js" failed "$COCKEREL_JOB"
