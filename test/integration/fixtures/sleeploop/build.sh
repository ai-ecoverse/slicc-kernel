#!/bin/bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
rustup run stable rustc --target wasm32-wasip1 -O -C strip=symbols "$here/sleeploop.rs" -o "$here/bin/sleeploop.wasm"
ls -la "$here/bin/sleeploop.wasm"
