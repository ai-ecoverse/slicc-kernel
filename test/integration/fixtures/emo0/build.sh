#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="${EMO0_BUILD:-$(mktemp -d)}"
mkdir -p "$work"
if ! command -v emcc >/dev/null; then
  (cd "$work" && npm install --no-save --no-package-lock --ignore-scripts emsdk@0.4.0 >/dev/null)
  (cd "$work" && node node_modules/emsdk/dist/postinstall.js)
  eval "$(cd "$work" && node -e 'const e=require("emsdk"); for (const [k,v] of Object.entries(e.env())) console.log(`export ${k}=${JSON.stringify(String(v))}`)')"
fi
emcc --version | head -1
emcc -O0 "$here/emo0.c" -o "$work/emo0.js" \
  -sALLOW_MEMORY_GROWTH=1 -sFORCE_FILESYSTEM=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain -sENVIRONMENT=web,worker,node
grep -q 'shell environment detected' "$work/emo0.js"
cp "$work/emo0.js" "$here/bin/emo0"
cp "$work/emo0.wasm" "$here/bin/emo0.wasm"
rm -rf "$work"
