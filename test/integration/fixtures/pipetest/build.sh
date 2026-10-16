#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v wasixcc >/dev/null; then
  eval "$(bash "${INSTALL_WASIXCC:-install-wasixcc.sh}" "${WASIXCC_HOME:-$HOME/.wasixcc}")"
fi
export WASIXCC_SYSROOT_PREFIX="${WASIX_SYSROOT_29:?the unpacked @ai-ecoverse/wasix-sysroot 2025.9.30-29 package}"
wasixcc -Oz -pthread "$here/pipetest.c" -o "$here/bin/pipetest.wasm"
ls -la "$here/bin/pipetest.wasm"
shasum -a 256 "$here/bin/pipetest.wasm"
