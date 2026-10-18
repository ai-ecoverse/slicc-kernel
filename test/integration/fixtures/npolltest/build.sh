#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v wasixcc >/dev/null; then
  eval "$(bash "${INSTALL_WASIXCC:-install-wasixcc.sh}" "${WASIXCC_HOME:-$HOME/.wasixcc}")"
fi
export WASIXCC_SYSROOT_PREFIX="${WASIX_SYSROOT_37:?the unpacked @ai-ecoverse/wasix-sysroot 2025.9.30-37 package}"
export WASIXCC_WASM_EXCEPTIONS=legacy
wasixcc -Oz "$here/npolltest.c" -o "$here/bin/npolltest.wasm"
ls -la "$here/bin/npolltest.wasm"
shasum -a 256 "$here/bin/npolltest.wasm"
