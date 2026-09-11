#!/usr/bin/env bash
# Build the Rust DeepSeek v2 engine to wasm32 and copy the artifact to
# src/ai/wasm/. Mirrors rust/build.sh.
#
# The wasm target must be installed:
#   rustup target add wasm32-unknown-unknown
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../src/ai/wasm"
mkdir -p "$OUT"
cargo build --manifest-path "$HERE/Cargo.toml" --release --target wasm32-unknown-unknown -p deepseek-wasm
cp "$HERE/target/wasm32-unknown-unknown/release/deepseek_wasm.wasm" "$OUT/deepseek_v2.wasm"
echo "built $OUT/deepseek_v2.wasm ($(wc -c < "$OUT/deepseek_v2.wasm") bytes)"
