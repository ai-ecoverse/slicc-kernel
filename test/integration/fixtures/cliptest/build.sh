#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
CARGO_TARGET_DIR="$here/.target" cargo build --release --target wasm32-wasip1 --manifest-path "$here/Cargo.toml"
cp "$here/.target/wasm32-wasip1/release/cliptest.wasm" "$here/bin/cliptest.wasm"
rm -rf "$here/.target"
ls -la "$here/bin/cliptest.wasm"
