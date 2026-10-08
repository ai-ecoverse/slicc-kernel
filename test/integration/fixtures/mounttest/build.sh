#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
zig cc -target wasm32-wasi -Os -s "$here/mounttest.c" -o "$here/bin/mounttest.wasm"
ls -la "$here/bin/mounttest.wasm"
