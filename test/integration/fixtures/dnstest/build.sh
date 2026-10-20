#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v wasixcc >/dev/null; then
  eval "$(bash "${INSTALL_WASIXCC:-install-wasixcc.sh}" "${WASIXCC_HOME:-$HOME/.wasixcc}")"
fi
wasixcc -O2 "$here/dnstest.c" -o "$here/bin/dnstest.wasm"
ls -la "$here/bin/dnstest.wasm"
shasum -a 256 "$here/bin/dnstest.wasm"
