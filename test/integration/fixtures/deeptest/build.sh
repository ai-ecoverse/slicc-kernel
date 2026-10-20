#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
home="${WASIXCC_HOME:-$HOME/.wasixcc}"
sysroot="$home/sysroot/sysroot"
lib="$sysroot/lib/wasm32-wasi"
"$home/llvm/bin/clang" --target=wasm32-wasi --sysroot="$sysroot" -O1 -nodefaultlibs \
  "$here/deeptest.c" "$lib/libc.a" "$lib/libclang_rt.builtins-wasm32.a" \
  -Wl,-z,stack-size=67108864,--strip-all -o "$here/bin/deeptest.wasm"
shasum -a 256 "$here/bin/deeptest.wasm"
