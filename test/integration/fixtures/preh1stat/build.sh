#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="${PREH1STAT_BUILD:-$here/.build}"
mkdir -p "$work"
if ! command -v emcc >/dev/null; then
  (cd "$work" && npm install --no-save --no-package-lock --ignore-scripts emsdk@0.4.0 >/dev/null)
  (cd "$work" && node node_modules/emsdk/dist/postinstall.js)
  eval "$(cd "$work" && node -e 'const e=require("emsdk"); for (const [k,v] of Object.entries(e.env())) console.log(`export ${k}=${JSON.stringify(String(v))}`)')"
fi
emcc --version | head -1
emcc -O2 "$here/preh1stat.c" -o "$work/preh1stat.js" \
  -sALLOW_MEMORY_GROWTH=1 -sFORCE_FILESYSTEM=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain -sENVIRONMENT=web,worker,node
if grep -q slicc_cred_js "$work/preh1stat.js"; then
  echo "preh1stat: the glue carries the credential library; this fixture must not" >&2
  exit 1
fi
cp "$work/preh1stat.js" "$here/bin/preh1stat"
cp "$work/preh1stat.wasm" "$here/bin/preh1stat.wasm"
shasum -a 256 "$here/bin/preh1stat" "$here/bin/preh1stat.wasm"
