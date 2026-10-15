#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v wasixcc >/dev/null; then
  eval "$(bash "${INSTALL_WASIXCC:-install-wasixcc.sh}" "${WASIXCC_HOME:-$HOME/.wasixcc}")"
fi
wasixcc -O2 "$here/udptest.c" -o "$here/bin/udptest.wasm"
ls -la "$here/bin/udptest.wasm"
shasum -a 256 "$here/bin/udptest.wasm"
