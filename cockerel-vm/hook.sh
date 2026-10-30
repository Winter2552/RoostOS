#!/bin/sh
# aria2 runs this when a download finishes. The job id comes from the
# environment tool.js started aria2 with.
[ -n "$COCKEREL_JOB" ] || exit 0
exec node "$(dirname "$0")/tool.js" done "$COCKEREL_JOB"
