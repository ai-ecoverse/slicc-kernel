#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
eval "$(bash "${INSTALL_WASIXCC:-install-wasixcc.sh}" "${WASIXCC_HOME:-$HOME/.wasixcc}")"
export WASIXCC_SYSROOT_PREFIX="${WASIX_SYSROOT_28:?the unpacked @ai-ecoverse/wasix-sysroot 2025.9.30-28 package}"
export WASIXCC_WASM_EXCEPTIONS=legacy WASIXCC_PIC=yes
wasixcc -Oz -s "$here/dlfork.c" -o "$here/.dlfork.wasm"
WASIXCC_MODULE_KIND=shared-library wasixcc -O2 "$here/side.c" -o "$here/lib/libdlside.so"
wasm-opt --asyncify -Oz --strip-debug --strip-producers --pass-arg=asyncify-imports@wasix_32v1.proc_fork --enable-threads \
  --enable-bulk-memory --enable-mutable-globals --enable-sign-ext --enable-nontrapping-float-to-int \
  --enable-exception-handling "$here/.dlfork.wasm" -o "$here/bin/dlfork.wasm"
rm -f "$here/.dlfork.wasm"
ls -la "$here/bin/dlfork.wasm" "$here/lib/libdlside.so"
