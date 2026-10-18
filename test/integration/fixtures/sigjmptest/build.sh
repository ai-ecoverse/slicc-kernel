#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v wasixcc >/dev/null; then
  eval "$(bash "${INSTALL_WASIXCC:-install-wasixcc.sh}" "${WASIXCC_HOME:-$HOME/.wasixcc}")"
fi
export WASIXCC_SYSROOT_PREFIX="${WASIX_SYSROOT_35:?the unpacked @ai-ecoverse/wasix-sysroot 2025.9.30-35 package}"
export WASIXCC_WASM_EXCEPTIONS=legacy
wasixcc -Oz "$here/sigjmptest.c" -o "$here/.sigjmptest.wasm"
wasm-opt --asyncify -Oz --strip-debug --strip-producers --pass-arg=asyncify-imports@wasix_32v1.proc_fork --pass-arg=asyncify-ignore-indirect --enable-threads \
  --enable-bulk-memory --enable-mutable-globals --enable-sign-ext --enable-nontrapping-float-to-int \
  --enable-exception-handling "$here/.sigjmptest.wasm" -o "$here/bin/sigjmptest.wasm"
rm -f "$here/.sigjmptest.wasm"
ls -la "$here/bin/sigjmptest.wasm"
shasum -a 256 "$here/bin/sigjmptest.wasm"
