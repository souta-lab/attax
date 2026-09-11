# Hoiko engine (Rust / WASM) — foundation

This workspace is the fast path for the Hoiko engine. The TypeScript engine in
`src/ai/native/` is the verified reference (oracle-matched 9:9 against the shipping
binary); this crate reimplements the same logic in Rust so it can ship as WASM for
the browser, where JS object-churn is the bottleneck.

## Status

Foundation only: `Board` + bit primitives (`popcount`, `log2`, `get_column_height`)
with unit tests, plus a wasm32 wrapper (`h_alloc`/`h_dealloc`/`h_popcount`/`h_log2`/
`h_get_column_height`). The full engine (`expand`, `evaluate`, `search`, `offset`) is
the port target — see `../tools/hoiko-oracle/WASM_PLAN.md`.

## Build & verify

```bash
rustup target add wasm32-unknown-unknown     # once
cargo test -p hoiko-core                     # native tests (debug the logic here)
bash build.sh                                # -> src/ai/wasm/hoiko_core.wasm
bun verify.mjs                               # load the .wasm from Bun and check values
```

Debug natively (`cargo test` / `cargo run`), ship wasm. The code is pure and
deterministic, so native and wasm behave identically; only the target differs.

## Notes

- Rust edition 2024: exported symbols need `#[unsafe(no_mangle)]`.
- When reading wasm linear memory from JS, (re)create the typed-array view **after**
  any allocation that may grow memory, or the view is detached.
- The `target/` directory and the built `.wasm` are build artifacts (gitignored).
