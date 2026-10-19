#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
home="${WASIXCC_HOME:-$HOME/.wasixcc}"
sysroot="$home/sysroot/sysroot"
lib="$sysroot/lib/wasm32-wasi"
"$home/llvm/bin/clang" --target=wasm32-wasi --sysroot="$sysroot" -O2 -fno-builtin -pthread -matomics \
  -mbulk-memory -mmutable-globals -nodefaultlibs "$here/guestwrites.c" "$lib/libc.a" \
  "$lib/libclang_rt.builtins-wasm32.a" \
  -Wl,--shared-memory,--import-memory,--max-memory=1073741824,--strip-all \
  -o "$here/bin/guestwrites.wasm"
ls -la "$here/bin/guestwrites.wasm"
shasum -a 256 "$here/bin/guestwrites.wasm"
