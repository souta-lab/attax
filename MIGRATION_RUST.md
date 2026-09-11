# Migration — retire the TypeScript Hoiko engine, keep Rust

**STATUS: DONE.** The TS engine is deleted; the app and all harnesses run the Rust
wasm engine. Verified: exe-vs-Rust 9/9 first-move + delay, 9/9 beam adaptation,
and OffsetAI all-methods identical to the exe (md5-equal probe output for exe/TS/Rust).

The Rust engine (`rust/hoiko-core` + `rust/hoiko-wasm`) is a verified faithful port:

## Deleted (executed)
`src/ai/native/**`, `src/ai/hoiko.ts`, `hoiko-search.ts`, `hoiko-eval.ts`,
`hoiko-offset.ts`, `hoiko-offset-driver.ts`, `hoiko-native.ts`,
`scripts/hoiko-native-solo.ts`, and their tests (`tests/native-*.test.ts`,
`tests/hoiko-*.test.ts`). Architecture archive: `/tmp/opencode/re/ts-native-snapshot/`.

## Kept
`src/ai/hoiko-weights.ts` (FFI weight data), `src/ai/mino-codes.ts` (MinoType mapping),
`src/ai/hoiko-rust-core.ts` (shared adapter) + `src/ai/hoiko-rust.ts` (browser wasm loader)
+ `tools/hoiko-rust/loader.ts` (bun loader), DeepSeek deps, `tools/hoiko-oracle/**`.

## Verification tools (repointed at Rust)
`tools/hoiko-oracle/diff/diff.ts` and `twosearch.ts` now compare the **exe against Rust**
directly (previously they compared exe against TS).
