#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
toolchain="${SLICC_EMSCRIPTEN:-$HOME/Developer/ai-ecoverse/slicc-emscripten}"
em="$toolchain/src/emscripten"
out="${SOCKTEST_BUILD:-$here/.build}"
export EM_CONFIG="$toolchain/emscripten-config" EM_CACHE="${EM_CACHE:-$out/cache}"
export EMSDK_PYTHON="${EMSDK_PYTHON:-/opt/homebrew/bin/python3.13}"
mkdir -p "$out"
[ -d "$EM_CACHE" ] || cp -R "$toolchain/cache" "$EM_CACHE"
for shim in slicc_socket slicc_select; do
  "$em/emcc" -O2 -c "$toolchain/slicc/lib/$shim.c" -o "$out/$shim.o"
done
"$em/emcc" -O2 "$here/socktest.c" "$out/slicc_socket.o" "$out/slicc_select.o" -o "$out/socktest.js" \
  -sALLOW_MEMORY_GROWTH=1 -sFORCE_FILESYSTEM=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain -sENVIRONMENT=web,worker,node
cp "$out/socktest.js" "$here/bin/socktest"
cp "$out/socktest.wasm" "$here/bin/socktest.wasm"
