#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v wasixcc >/dev/null; then
  eval "$(bash "${INSTALL_WASIXCC:-install-wasixcc.sh}" "${WASIXCC_HOME:-$HOME/.wasixcc}")"
fi
export WASIXCC_SYSROOT_PREFIX="${WASIX_SYSROOT_28:?the unpacked @ai-ecoverse/wasix-sysroot 2025.9.30-28 package}"
export WASIXCC_WASM_EXCEPTIONS=legacy WASIXCC_PIC=yes
wasixcc -Oz "$here/forkrelocs.c" -o "$here/.forkrelocs.wasm"
WASIXCC_MODULE_KIND=shared-library wasixcc -O2 "$here/side.c" -o "$here/lib/libforkrelocs.so"
wasm-opt --asyncify -Oz --strip-debug --strip-producers --pass-arg=asyncify-imports@wasix_32v1.proc_fork --enable-threads \
  --enable-bulk-memory --enable-mutable-globals --enable-sign-ext --enable-nontrapping-float-to-int \
  --enable-exception-handling "$here/.forkrelocs.wasm" -o "$here/bin/forkrelocs.wasm"
rm -f "$here/.forkrelocs.wasm"
ls -la "$here/bin/forkrelocs.wasm" "$here/lib/libforkrelocs.so"
shasum -a 256 "$here/bin/forkrelocs.wasm" "$here/lib/libforkrelocs.so"
