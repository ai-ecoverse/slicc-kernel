#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
: "${HOMESCOOP_ROOT:?a checkout of ai-ecoverse/homescoop, for its slicc shims and link flags}"
export HOMESCOOP_WORK="${HOMESCOOP_WORK:-$here/.build}"
source "$HOMESCOOP_ROOT/scripts/build-common.sh"
emcc --version | head -1 | grep -qE ' 4\.0\.23[ -]' || { echo "ebindtest needs emsdk 4.0.23, as the base set" >&2; exit 1; }
archive="$WORK/libslicc-cli.a"
homescoop_slicc_archive "$archive" cli
export HOMESCOOP_EM_CLI_LDFLAGS_EXTRA="-sINVOKE_RUN=0 -sEXPORTED_RUNTIME_METHODS=FS,callMain"
emcc -O2 -Wall -Wextra -Werror "$here/ebindtest.c" \
  $(homescoop_slicc_link_archive "$archive") $(homescoop_em_cli_ldflags) \
  -o "$WORK/ebindtest.js"
cp "$WORK/ebindtest.js" "$here/bin/ebindtest"
cp "$WORK/ebindtest.wasm" "$here/bin/ebindtest.wasm"
rm -rf "$HOMESCOOP_WORK"
ls -la "$here/bin"
