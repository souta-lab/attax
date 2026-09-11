#!/usr/bin/env bash
# Build the Hoiko engine to wasm32 and copy the artifact to src/ai/wasm/.
#
# Uses rustup if present (recommended); the wasm target must be installed:
#   rustup target add wasm32-unknown-unknown
# Override the toolchain dirs with CARGO_HOME/RUSTUP_HOME/PATH as needed.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../src/ai/wasm"
mkdir -p "$OUT"
cargo build --manifest-path "$HERE/Cargo.toml" --release --target wasm32-unknown-unknown
cp "$HERE/target/wasm32-unknown-unknown/release/hoiko_wasm.wasm" "$OUT/hoiko_core.wasm"
echo "built $OUT/hoiko_core.wasm ($(wc -c < "$OUT/hoiko_core.wasm") bytes)"
