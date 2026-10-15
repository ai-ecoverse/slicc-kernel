#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
: "${HOMESCOOP_ROOT:?a checkout of ai-ecoverse/homescoop, for its slicc shims and link flags}"
export HOMESCOOP_WORK="${HOMESCOOP_WORK:-$here/.build}"
source "$HOMESCOOP_ROOT/scripts/build-common.sh"
emcc --version | head -1 | grep -q ' 4\.0\.23 ' || { echo "locktest needs emsdk 4.0.23, as the base set" >&2; exit 1; }
archive="$WORK/libslicc-fork.a"
homescoop_slicc_archive "$archive" fork
export HOMESCOOP_EM_CLI_LDFLAGS_EXTRA="-sINVOKE_RUN=0 -sEXPORTED_RUNTIME_METHODS=FS,callMain,sliccRunMain,sliccForkChild $(homescoop_slicc_fork_js_flags)"
emcc -O2 -Wall -Wextra -Werror "$here/locktest.c" \
  $(homescoop_slicc_link_archive "$archive") $(homescoop_em_cli_ldflags) $(homescoop_slicc_keep_exports) \
  -o "$WORK/locktest.js"
cp "$WORK/locktest.js" "$here/bin/locktest"
cp "$WORK/locktest.wasm" "$here/bin/locktest.wasm"
rm -rf "$HOMESCOOP_WORK"
ls -la "$here/bin"
