#!/bin/sh
if command -v lockf > /dev/null 2>&1; then
  exec lockf -k "${SLICC_HEAVY_LOCK:-/tmp/slicc-heavy.lock}" "$@"
fi
exec "$@"
