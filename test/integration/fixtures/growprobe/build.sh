#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
sysroot="${WASIX_SYSROOT:?the wasixcc sysroot (sysroot/sysroot of wasixcc 2025.9.30)}"
clang="${WASIX_CLANG:-$HOME/.wasixcc/llvm/bin/clang}"
"$clang" --target=wasm32-wasi --sysroot="$sysroot" -O2 -pthread -matomics -mbulk-memory -mmutable-globals -msign-ext \
  -nodefaultlibs "$here/grow.c" -o "$here/bin/grow.wasm" -lc "$sysroot/lib/wasm32-wasi/libclang_rt.builtins-wasm32.a" \
  -Wl,--shared-memory,--import-memory,--export-memory,--max-memory=1073741824
ls -la "$here/bin/grow.wasm"
shasum -a 256 "$here/bin/grow.wasm"
