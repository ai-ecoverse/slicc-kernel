#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v wasixcc >/dev/null; then
  eval "$(bash "${INSTALL_WASIXCC:-install-wasixcc.sh}" "${WASIXCC_HOME:-$HOME/.wasixcc}")"
fi
wasixcc -O2 -Wl,--allow-undefined "$here/ttyprobe.c" -o "$here/bin/ttyprobe.wasm"
ls -la "$here/bin/ttyprobe.wasm"
shasum -a 256 "$here/bin/ttyprobe.wasm"
