#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
llvm="${WASIXCC_LLVM:-$HOME/.wasixcc/llvm}"
sysroot="${WASIX_SYSROOT_28:?the unpacked @ai-ecoverse/wasix-sysroot 2025.9.30-28 package}/sysroot"
"$llvm/bin/clang" --target=wasm32-wasip1 --sysroot="$sysroot" -Oz -pthread -matomics -mbulk-memory -mmutable-globals \
  -nodefaultlibs "$here/nofollowtest.c" "$sysroot/lib/wasm32-wasip1/libc.a" \
  "$sysroot/lib/wasm32-wasip1/libclang_rt.builtins-wasm32.a" \
  -Wl,--shared-memory,--import-memory,--max-memory=67108864,--strip-all -o "$here/bin/nofollowtest.wasm"
ls -la "$here/bin/nofollowtest.wasm"
shasum -a 256 "$here/bin/nofollowtest.wasm"
