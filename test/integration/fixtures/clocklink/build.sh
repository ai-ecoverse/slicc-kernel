#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="${CLOCKLINK_BUILD:-$here/.build}"
mkdir -p "$work"
if ! command -v emcc >/dev/null; then
  (cd "$work" && npm install --no-save --no-package-lock --ignore-scripts emsdk@0.4.0 >/dev/null)
  (cd "$work" && node node_modules/emsdk/dist/postinstall.js)
  eval "$(cd "$work" && node -e 'const e=require("emsdk"); for (const [k,v] of Object.entries(e.env())) console.log(`export ${k}=${JSON.stringify(String(v))}`)')"
fi
emcc --version | head -1
emcc -O2 -Wall -Wextra -Werror "$here/clocklink.c" -o "$work/clocklink.js" \
  -sALLOW_MEMORY_GROWTH=1 -sFORCE_FILESYSTEM=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain -sENVIRONMENT=web,worker,node
cp "$work/clocklink.js" "$here/bin/clocklink"
cp "$work/clocklink.wasm" "$here/bin/clocklink.wasm"
shasum -a 256 "$here/bin/clocklink" "$here/bin/clocklink.wasm"
