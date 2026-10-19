#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
clang="${WASIXCC_HOME:-$HOME/.wasixcc}/llvm/bin/clang"
flags=(--target=wasm32 -O2 -nostdlib -fno-builtin -Wl,--no-entry,--strip-all)
"$clang" "${flags[@]}" "$here/jswasi.c" -o "$here/bin/jswasi.wasm"
"$clang" "${flags[@]}" -matomics -mbulk-memory "$here/jswasi.c" \
  -Wl,--import-memory,--shared-memory,--max-memory=1048576,--export=__stack_pointer -o "$here/bin/jswasi-shared.wasm"
shasum -a 256 "$here/bin/"*.wasm
