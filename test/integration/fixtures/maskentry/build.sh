#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v wasixcc >/dev/null; then
  eval "$(bash "${INSTALL_WASIXCC:-install-wasixcc.sh}" "${WASIXCC_HOME:-$HOME/.wasixcc}")"
fi
export WASIXCC_SYSROOT_PREFIX="${WASIX_SYSROOT_29:?the unpacked @ai-ecoverse/wasix-sysroot 2025.9.30-29 package}"
export WASIXCC_WASM_EXCEPTIONS=legacy
wasixcc -Oz "$here/maskentry.c" -o "$here/.maskentry.wasm"
wasm-opt --asyncify -Oz --strip-debug --strip-producers --pass-arg=asyncify-imports@wasix_32v1.proc_fork --enable-threads \
  --enable-bulk-memory --enable-mutable-globals --enable-sign-ext --enable-nontrapping-float-to-int \
  --enable-exception-handling "$here/.maskentry.wasm" -o "$here/bin/maskentry.wasm"
rm -f "$here/.maskentry.wasm"
ls -la "$here/bin/maskentry.wasm"
shasum -a 256 "$here/bin/maskentry.wasm"
