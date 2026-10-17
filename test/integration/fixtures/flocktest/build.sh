#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v wasixcc >/dev/null; then
  eval "$(bash "${INSTALL_WASIXCC:-install-wasixcc.sh}" "${WASIXCC_HOME:-$HOME/.wasixcc}")"
fi
export WASIXCC_SYSROOT_PREFIX="${WASIX_SYSROOT_28:?the unpacked @ai-ecoverse/wasix-sysroot 2025.9.30-28 package}"
export WASIXCC_WASM_EXCEPTIONS=legacy
wasixcc -Oz -pthread "$here/flocktest.c" -o "$here/.flocktest.wasm" -Wl,--allow-undefined
wasm-opt --asyncify -Oz --strip-debug --strip-producers --pass-arg=asyncify-imports@wasix_32v1.proc_fork --enable-threads \
  --enable-bulk-memory --enable-mutable-globals --enable-sign-ext --enable-nontrapping-float-to-int \
  --enable-exception-handling "$here/.flocktest.wasm" -o "$here/bin/flocktest.wasm"
rm -f "$here/.flocktest.wasm"
ls -la "$here/bin/flocktest.wasm"
shasum -a 256 "$here/bin/flocktest.wasm"
