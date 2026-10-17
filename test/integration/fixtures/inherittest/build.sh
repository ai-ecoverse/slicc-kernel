#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v wasixcc >/dev/null; then
  eval "$(bash "${INSTALL_WASIXCC:-install-wasixcc.sh}" "${WASIXCC_HOME:-$HOME/.wasixcc}")"
fi
export WASIXCC_SYSROOT_PREFIX="${WASIX_SYSROOT_33:?the unpacked @ai-ecoverse/wasix-sysroot 2025.9.30-33 package}"
export WASIXCC_WASM_EXCEPTIONS=legacy
wasixcc -Oz "$here/inherittest.c" -o "$here/.inherittest.wasm"
wasm-opt --asyncify -Oz --strip-debug --strip-producers --pass-arg=asyncify-imports@wasix_32v1.proc_fork --enable-threads \
  --enable-bulk-memory --enable-mutable-globals --enable-sign-ext --enable-nontrapping-float-to-int \
  --enable-exception-handling "$here/.inherittest.wasm" -o "$here/bin/inherittest.wasm"
rm -f "$here/.inherittest.wasm"
ls -la "$here/bin/inherittest.wasm"
shasum -a 256 "$here/bin/inherittest.wasm"
