#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
toolchain="${WASIX_RUST:?the unpacked wasix-org/rust v2026-09-18.1+rust-1.97 toolchain}"
sysroot="${WASIX_SYSROOT_28:?the unpacked @ai-ecoverse/wasix-sysroot 2025.9.30-28 package}/sysroot/lib/wasm32-wasi"
export RUSTC="$toolchain/bin/rustc"
export CARGO_TARGET_DIR="${TOKIOTEST_BUILD:-$here/.build}"
export RUSTFLAGS="-C link-self-contained=no -L native=$sysroot -C link-arg=$sysroot/crt1-command.o"
cd "$here"
cargo build --locked --release --target wasm32-wasmer-wasi
cp "$CARGO_TARGET_DIR/wasm32-wasmer-wasi/release/tokiotest.wasm" "$here/bin/tokiotest.wasm"
ls -la "$here/bin/tokiotest.wasm"
shasum -a 256 "$here/bin/tokiotest.wasm"
