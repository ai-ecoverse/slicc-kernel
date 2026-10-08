#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
eval "$(bash "${INSTALL_WASIXCC:-install-wasixcc.sh}" "${WASIXCC_HOME:-$HOME/.wasixcc}")"
wasixcc -O2 "$here/exectest.c" -o "$here/.exectest.wasm"
wasm-opt --asyncify -O2 --enable-threads --enable-bulk-memory --enable-mutable-globals \
  --enable-sign-ext --enable-nontrapping-float-to-int "$here/.exectest.wasm" -o "$here/bin/exectest.wasm"
rm -f "$here/.exectest.wasm"
ls -la "$here/bin/exectest.wasm"
