#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
eval "$(bash "${INSTALL_WASIXCC:-install-wasixcc.sh}" "${WASIXCC_HOME:-$HOME/.wasixcc}")"
wasixcc -O2 "$here/httptest.c" -o "$here/bin/httptest.wasm"
ls -la "$here/bin/httptest.wasm"
