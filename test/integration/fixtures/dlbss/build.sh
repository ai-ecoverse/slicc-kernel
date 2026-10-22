#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
sysroot="${WASIX_SYSROOT_42:?the unpacked @ai-ecoverse/wasix-sysroot 2025.9.30-42 package}/sysroot-ehpic"
llvm="${WASIX_LLVM:?an LLVM 21 bin directory with clang and wasm-ld, e.g. ~/.wasixcc/llvm/bin}"
flags=(--target=wasm32-wasip1 --sysroot="$sysroot" -O2 -fPIC -matomics -mbulk-memory -mmutable-globals -fwasm-exceptions -mllvm -wasm-enable-sjlj)
cd "$here"
"$llvm/clang" "${flags[@]}" -c bss.c -o /tmp/dlbss-bss.o
"$llvm/clang" "${flags[@]}" -c top.c -o /tmp/dlbss-top.o
"$llvm/wasm-ld" -shared --experimental-pic --shared-memory --export-dynamic -o lib/libzzybss.so /tmp/dlbss-bss.o
"$llvm/wasm-ld" -shared --experimental-pic --shared-memory --export-dynamic -o lib/libzzytop.so /tmp/dlbss-top.o -Llib -lzzybss
rm -f /tmp/dlbss-bss.o /tmp/dlbss-top.o
shasum -a 256 lib/*.so
