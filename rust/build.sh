#!/usr/bin/env bash
# Build the Hoiko engine to wasm32 and copy the artifact to src/ai/hoiko/.
#
# Uses rustup if present (recommended); the wasm target must be installed:
#   rustup target add wasm32-unknown-unknown
# Override the toolchain dirs with CARGO_HOME/RUSTUP_HOME/PATH as needed.
#
# When binaryen's `wasm-opt` is installed the artifact is post-processed with
# `-O4` (smaller + a little faster); without it the raw cargo output is copied.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../src/ai/hoiko/"
WASM="$HERE/target/wasm32-unknown-unknown/release/hoiko_wasm.wasm"
mkdir -p "$OUT"

# Some distro rustc packages ship a wasm32 `std` built by a different compiler
# (E0514); prefer a rustup toolchain when one is available and RUSTC is unset.
if [[ -z "${RUSTC:-}" ]] && compgen -G "$HOME/.rustup/toolchains/*/bin/rustc" >/dev/null; then
  export RUSTC="$(ls -d "$HOME"/.rustup/toolchains/*/bin/rustc | sort -V | tail -1)"
fi

cargo build --manifest-path "$HERE/Cargo.toml" --release --target wasm32-unknown-unknown

if command -v wasm-opt >/dev/null 2>&1 && \
   wasm-opt -O4 --strip-debug "$WASM" -o "$OUT/hoiko_core.wasm.tmp" 2>/dev/null; then
  mv "$OUT/hoiko_core.wasm.tmp" "$OUT/hoiko_core.wasm"
  echo "built $OUT/hoiko_core.wasm (wasm-opt -O4, $(wc -c < "$OUT/hoiko_core.wasm") bytes)"
else
  rm -f "$OUT/hoiko_core.wasm.tmp"
  cp "$WASM" "$OUT/hoiko_core.wasm"
  echo "built $OUT/hoiko_core.wasm ($(wc -c < "$OUT/hoiko_core.wasm") bytes)"
fi
