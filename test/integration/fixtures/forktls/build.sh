#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v wasixcc >/dev/null; then
  eval "$(bash "${INSTALL_WASIXCC:-install-wasixcc.sh}" "${WASIXCC_HOME:-$HOME/.wasixcc}")"
fi
export WASIXCC_SYSROOT_PREFIX="${WASIX_SYSROOT_28:?the unpacked @ai-ecoverse/wasix-sysroot 2025.9.30-28 package}"
export WASIXCC_WASM_EXCEPTIONS=legacy
for kind in pie static; do
  pic=no
  if [ "$kind" = pie ]; then pic=yes; fi
  WASIXCC_PIC=$pic wasixcc -Oz "$here/forktls.c" "$here/tlsvars.c" -o "$here/.forktls-$kind.wasm"
  wasm-opt --asyncify -Oz --strip-debug --strip-producers --pass-arg=asyncify-imports@wasix_32v1.proc_fork --enable-threads \
    --enable-bulk-memory --enable-mutable-globals --enable-sign-ext --enable-nontrapping-float-to-int \
    --enable-exception-handling "$here/.forktls-$kind.wasm" -o "$here/bin/forktls-$kind.wasm"
  rm -f "$here/.forktls-$kind.wasm"
done
mkdir -p "$here/lib"
WASIXCC_PIC=yes WASIXCC_MODULE_KIND=shared-library wasixcc -O2 "$here/tlsside.c" -o "$here/lib/libtlsside.so"
ls -la "$here/bin" "$here/lib"
shasum -a 256 "$here"/bin/*.wasm "$here"/lib/*.so
