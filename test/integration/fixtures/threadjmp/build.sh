#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v wasixcc >/dev/null; then
  eval "$(bash "${INSTALL_WASIXCC:-install-wasixcc.sh}" "${WASIXCC_HOME:-$HOME/.wasixcc}")"
fi
export WASIXCC_SYSROOT_PREFIX="${WASIX_SYSROOT_28:?the unpacked @ai-ecoverse/wasix-sysroot 2025.9.30-28 package}"
features=(--enable-threads --enable-bulk-memory --enable-mutable-globals --enable-sign-ext --enable-nontrapping-float-to-int)
WASIXCC_WASM_EXCEPTIONS=no wasixcc -Oz -pthread "$here/threadjmp.c" -o "$here/.threadjmp.wasm"
wasm-opt -Oz --strip-debug --strip-producers "${features[@]}" "$here/.threadjmp.wasm" -o "$here/bin/threadjmp.wasm"
WASIXCC_WASM_EXCEPTIONS=legacy WASIXCC_PIC=yes wasixcc -Oz -pthread -DFORK_ONLY "$here/threadjmp.c" -o "$here/.threadjmp-pie.wasm"
wasm-opt --asyncify -Oz --strip-debug --strip-producers --pass-arg=asyncify-imports@wasix_32v1.proc_fork \
  "${features[@]}" --enable-exception-handling "$here/.threadjmp-pie.wasm" -o "$here/bin/threadjmp-pie.wasm"
rm -f "$here/.threadjmp.wasm" "$here/.threadjmp-pie.wasm"
ls -la "$here/bin"
shasum -a 256 "$here"/bin/*.wasm
