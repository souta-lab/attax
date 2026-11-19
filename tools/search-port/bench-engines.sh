#!/bin/bash
# TS-vs-Rust engine benchmark: memory, CPU, speed — before/after table.
#
# Configurations:
#   ts                 the TS reference search (in-process, bun)
#   rust-plain         release build with LTO off / codegen-units 16
#   rust-opt           workspace release profile (fat LTO, codegen-units 1)
#                      + target-cpu=native (the fleet build)
# Driver transports for the corpus/smoke cells: oneshot (a process per
# decision) vs server (one long-lived engine process).
#
# Method: same machine, interleaved rounds (ts, rust-plain, rust-opt, ...),
# per-case minima across rounds, medians reported. Every Rust corpus run must
# reproduce the pinned S2 digest or the bench aborts (the guardrail).
#
# Usage: tools/search-port/bench-engines.sh [--out DIR] [--rounds N]
# Env:   SMOKE_GAMES (default 4), SMOKE_SEED (default 777001),
#        CASES (default: dumped fresh to the out dir).
set -euo pipefail
export PATH="/opt/hatch-image/bin:$HOME/.cargo/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
OUT=/tmp/bench-engines
ROUNDS=2
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --rounds) ROUNDS="$2"; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$OUT"
PIN=d12375f7935ca9f94b0fedeee96877b2ef6c6118be6fac1bd5110cf12297f286
SMOKE_GAMES="${SMOKE_GAMES:-4}"
SMOKE_SEED="${SMOKE_SEED:-777001}"
# /usr/bin/time -v equivalent (this VM has no GNU time): wall, child CPU, peak RSS.
timed() {
  local out="$1"; shift
  python3 tools/search-port/run-timed.py --out "$out" -- "$@"
}

# --- machine / build metadata -------------------------------------------------
{
  echo "date: $(date -Is)"
  echo "host: $(hostname)  cores: $(nproc)"
  grep -m1 "model name" /proc/cpuinfo || true
  echo "bun: $(bun --version)  cargo: $(cargo --version)"
  echo "git: $(git rev-parse HEAD) (branch $(git branch --show-current))"
  echo "rust-plain flags: --config profile.release.lto=false --config profile.release.codegen-units=16"
  echo "rust-opt flags: workspace profile (opt-level 3, lto=fat, codegen-units=1) + RUSTFLAGS=-C target-cpu=native"
} > "$OUT/meta.txt"

# --- builds -------------------------------------------------------------------
PLAIN_DIR="$ROOT/rust/target-plain"
OPT_DIR="$ROOT/rust/target-native"
if [ ! -x "$PLAIN_DIR/release/attax-agree" ]; then
  CARGO_TARGET_DIR="$PLAIN_DIR" cargo build --release --manifest-path rust/Cargo.toml \
    -p attax-search-cli --config 'profile.release.lto=false' \
    --config 'profile.release.codegen-units=16' 2> "$OUT/build-plain.log"
fi
if [ ! -x "$OPT_DIR/release/attax-agree" ]; then
  RUSTFLAGS="-C target-cpu=native" CARGO_TARGET_DIR="$OPT_DIR" cargo build --release \
    --manifest-path rust/Cargo.toml -p attax-search-cli 2> "$OUT/build-opt.log"
fi
PLAIN="$PLAIN_DIR/release/attax-agree"
OPT="$OPT_DIR/release/attax-agree"

# --- cases --------------------------------------------------------------------
CASES="${CASES:-$OUT/cases.jsonl}"
if [ ! -f "$CASES" ]; then
  ATTAX_ENGINE=ts-reference bun tools/search-port/dump-s2-cases.ts "$CASES" 2> "$OUT/dump.log"
fi

# --- agreement guardrail per binary -------------------------------------------
"$PLAIN" "$CASES" --show 0 > "$OUT/agreement-plain.log" 2>&1
"$OPT" "$CASES" --show 0 > "$OUT/agreement-opt.log" 2>&1

# --- per-width engine bench (interleaved) --------------------------------------
for w in 48 96; do
  for r in $(seq 1 "$ROUNDS"); do
    timed "$OUT/bench-ts-w$w-r$r.time" bun tools/search-port/bench-s2.ts "$CASES" \
      --width "$w" --out "$OUT/bench-ts-w$w-r$r.json"
    timed "$OUT/bench-rust-plain-w$w-r$r.time" "$PLAIN" "$CASES" --width "$w" \
      --repeat 3 --jobs 1 --show 0 --out "$OUT/bench-rust-plain-w$w-r$r.jsonl" || true
    timed "$OUT/bench-rust-opt-w$w-r$r.time" "$OPT" "$CASES" --width "$w" \
      --repeat 3 --jobs 1 --show 0 --out "$OUT/bench-rust-opt-w$w-r$r.jsonl" || true
  done
done

# --- corpus wall (720 decisions through the lab driver, workers=1) -------------
corpus_run() {
  local name="$1"; shift
  local tsv="$OUT/corpus-$name.tsv"
  env ATTAX_CORPUS_WORKERS=1 "$@" python3 tools/search-port/run-timed.py \
    --out "$OUT/corpus-$name.time" -- bun tools/s2-lab/decision-corpus.ts "$tsv" \
    --profile default --profile tools/s2-lab/profiles/s2-tuned.json \
    --profile tools/s2-lab/profiles/s2-ports.json \
    --profile tools/s2-lab/profiles/league/snap-L60.json
  local got
  got="$(sha256sum "$tsv" | cut -d' ' -f1)"
  if [ "$got" != "$PIN" ]; then
    echo "GUARDRAIL FAILURE: corpus-$name digest $got != $PIN" >&2
    exit 1
  fi
}
corpus_run ts ATTAX_ENGINE=ts-reference
corpus_run rust-plain-oneshot ATTAX_ENGINE=rust ATTAX_RUST_CLI="$PLAIN" ATTAX_RUST_MODE=oneshot
corpus_run rust-plain-server ATTAX_ENGINE=rust ATTAX_RUST_CLI="$PLAIN"
corpus_run rust-opt-server ATTAX_ENGINE=rust ATTAX_RUST_CLI="$OPT"
# Production corpus shape: server mode with the default worker parallelism.
env ATTAX_RUST_CLI="$OPT" python3 tools/search-port/run-timed.py \
  --out "$OUT/corpus-prod.time" -- bun tools/s2-lab/decision-corpus.ts \
  "$OUT/corpus-prod-rust-opt-server.tsv" \
  --profile default --profile tools/s2-lab/profiles/s2-tuned.json \
  --profile tools/s2-lab/profiles/s2-ports.json \
  --profile tools/s2-lab/profiles/league/snap-L60.json
test "$(sha256sum "$OUT/corpus-prod-rust-opt-server.tsv" | cut -d' ' -f1)" = "$PIN"

# --- smoke games wall (fixed set vs Sold Slear) --------------------------------
# run-match resolves the lab root relative to the CWD (default ../s2-bot-lab-ref);
# pin it explicitly so the bench works from any checkout depth.
export S2_LAB_ROOT="${S2_LAB_ROOT:-$ROOT/../s2-bot-lab-ref}"
smoke_run() {
  local name="$1"; shift
  (cd tools/s2-lab && env "$@" python3 ../search-port/run-timed.py \
    --out "$OUT/smoke-$name.time" -- bun run-match.mjs --games "$SMOKE_GAMES" \
    --seed "$SMOKE_SEED" --out "$OUT/smoke-$name.jsonl")
}
smoke_run ts ATTAX_ENGINE=ts-reference
smoke_run rust-plain-oneshot ATTAX_ENGINE=rust ATTAX_RUST_CLI="$PLAIN" ATTAX_RUST_MODE=oneshot
smoke_run rust-opt-server ATTAX_ENGINE=rust ATTAX_RUST_CLI="$OPT"

python3 tools/search-port/bench-report.py "$OUT"
