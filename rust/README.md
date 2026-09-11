# Hoiko engine (Rust / WASM)

The canonical Hoiko engine: `hoiko-core` (board, expand, evaluate, search, OffsetAI)
plus `hoiko-wasm`, its wasm32 wrapper. The app and the headless harnesses run this
engine; the former TypeScript engine was deleted — see `../MIGRATION_RUST.md` and
`../tools/hoiko-oracle/` for the specs it was ported from.

## Status

Complete and oracle-verified against the shipping binary: 9/9 first-move + GetDelay
(depth 10), 2/2 depth-14, 9/9 two-search beam adaptation, and OffsetAI all-methods
md5-identical. Speed is documented in `PERF.md` (native ≈62–66 ms/move at depth 14,
~2.4x the original Rust and faster than the binary's ~101 ms).

## Build & verify

```bash
rustup target add wasm32-unknown-unknown     # once
cargo test                                  # native tests (debug the logic here)
cargo run --release -p hoiko-core --example bench_search
bash build.sh                                # -> src/ai/wasm/hoiko_core.wasm
bun verify.mjs                               # load the built .wasm from Bun
```

The differential gates against the binary live in `../tools/hoiko-oracle/diff/`
(`diff.ts` first move + GetDelay, `twosearch.ts` beam adaptation). Debug natively,
ship wasm: the code is pure and deterministic, so native and wasm behave identically.

## Notes

- Rust edition 2024: exported symbols need `#[unsafe(no_mangle)]`.
- When reading wasm linear memory from JS, (re)create the typed-array view **after**
  any allocation that may grow memory, or the view is detached.
- `target/` is gitignored. The built `src/ai/wasm/hoiko_core.wasm` **is checked in**
  because the browser app ships it; rebuild it with `bash build.sh`.
