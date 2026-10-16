#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v wasixcc >/dev/null; then
  eval "$(bash "${INSTALL_WASIXCC:-install-wasixcc.sh}" "${WASIXCC_HOME:-$HOME/.wasixcc}")"
fi
sysroot_29="${WASIX_SYSROOT_29:?the unpacked @ai-ecoverse/wasix-sysroot 2025.9.30-29 package}"
sysroot_28="${WASIX_SYSROOT_28:?the unpacked @ai-ecoverse/wasix-sysroot 2025.9.30-28 package}"
WASIXCC_SYSROOT_PREFIX="$sysroot_29" wasixcc -Oz -pthread "$here/epolltest.c" -o "$here/bin/epolltest.wasm"
WASIXCC_SYSROOT_PREFIX="$sysroot_28" wasixcc -Oz -pthread "$here/epolltest.c" -o "$here/bin/epolltest-28.wasm"
ls -la "$here/bin/epolltest.wasm" "$here/bin/epolltest-28.wasm"
shasum -a 256 "$here/bin/epolltest.wasm" "$here/bin/epolltest-28.wasm"
