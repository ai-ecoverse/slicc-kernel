#!/usr/bin/env bash
set -eu
here="$(dirname "$0")"
rustup run stable rustc --edition=2021 --target wasm32-wasip1 -C opt-level=z -C strip=symbols "$here/probe.rs" -o "$here/probe.wasm"
