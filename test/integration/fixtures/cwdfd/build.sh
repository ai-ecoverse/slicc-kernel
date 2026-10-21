#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
sysroot="${WASIX_SYSROOT_41:?the unpacked @ai-ecoverse/wasix-sysroot 2025.9.30-41 package}/sysroot"
llvm="${WASIX_LLVM:?an LLVM 21 bin directory with clang and wasm-ld, e.g. ~/.wasixcc/llvm/bin}"
"$llvm/clang" --target=wasm32-wasip1 --sysroot="$sysroot" -Oz -matomics -mbulk-memory -mmutable-globals -pthread \
  -ftls-model=local-exec -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS \
  -fuse-ld="$llvm/wasm-ld" -nodefaultlibs \
  -Wl,--shared-memory,--max-memory=4294967296,--import-memory,--export=__stack_pointer,--export=__heap_base,--export=__data_end,--allow-undefined \
  "$here/cwdfd.c" -o "$here/.cwdfd.wasm" -lc "$sysroot/lib/wasm32-wasip1/libclang_rt.builtins-wasm32.a"
wasm-opt -Oz --strip-debug --strip-producers --enable-threads --enable-bulk-memory --enable-mutable-globals \
  --enable-sign-ext --enable-nontrapping-float-to-int "$here/.cwdfd.wasm" -o "$here/bin/cwdfd.wasm"
node "$here/relabel.mjs" "$here/bin/cwdfd.wasm" "$here/bin/cwdfd-old.wasm" 'wasix-sysroot 2025.9.30-40'
rm -f "$here/.cwdfd.wasm"
ls -la "$here/bin"
shasum -a 256 "$here/bin/"*.wasm
