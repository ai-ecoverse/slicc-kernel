#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
eval "$(bash "${INSTALL_WASIXCC:-install-wasixcc.sh}" "${WASIXCC_HOME:-$HOME/.wasixcc}")"
export WASIXCC_SYSROOT_PREFIX="${WASIX_SYSROOT_28:?the unpacked @ai-ecoverse/wasix-sysroot 2025.9.30-28 package}"
wasixcc -Oz "$here/linktest.c" -o "$here/bin/linktest.wasm"
ls -la "$here/bin/linktest.wasm"
