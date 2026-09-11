# Migration — retire the TypeScript Hoiko engine, keep Rust

The Rust engine (`rust/hoiko-core` + `rust/hoiko-wasm`) is a verified faithful port:
`cargo test` 45 pass, and a TS-vs-Rust differential is **42/42 identical** on first-move
output (depth 10 and 14), plus 7/7 on real mid-game boards against the Wine oracle.

Once the Rust-backed `VersusFighter` is wired into the app and re-verified, the
TypeScript Hoiko engine becomes dead weight and should be deleted.

## Delete ONLY after the Rust adapter is wired + verified
The whole app currently imports the TS engine, so deleting first breaks everything.

| Delete (Hoiko-TS engine) | |
|---|---|
| `src/ai/native/**` | board/shapes/mino/baby/gamepack/nextmino/expand*/evaluate*/search/offset/index/ffi-probe |
| `src/ai/hoiko.ts` | old approximate replica |
| `src/ai/hoiko-search.ts`, `src/ai/hoiko-eval.ts` | intermediate TS engine parts |
| `src/ai/hoiko-offset.ts`, `src/ai/hoiko-offset-driver.ts` | TS OffsetAI |
| `src/ai/hoiko-native.ts` | TS-backed adapter (replaced by the Rust adapter) |
| `tests/native-*.test.ts`, `tests/hoiko-*.test.ts` | engine tests; superseded by `cargo test` + the oracle differential |

## KEEP (do not delete)
| Keep | Why |
|---|---|
| `src/ai/hoiko-weights.ts` | weight data; needed to fill the `h_search` input buffer |
| `src/ai/beam.ts`, `features.ts`, `weights.ts`, `types.ts`, `search.ts` | **DeepSeek** dependencies, not Hoiko-specific |
| `src/ai/deepseek.ts`, `deepseek-score.ts` | the opponent |
| `tools/hoiko-oracle/**` | the runtime oracle + specs (frozen reference for re-verifying Rust) |
| `tools/hoiko-oracle/diff/positions.ts`, `verify/golden.ts` | golden fixtures usable WITHOUT the TS engine |

## Order
1. Land the Rust-backed adapter (`createRustHoiko`) and wire `src/main.ts` + scripts to it.
2. Prove equivalence: Rust adapter vs the oracle (9 positions, depth 10/14) and, where the
   TS engine still exists, TS-vs-Rust first-move 100%.
3. Re-run the headless gate with the Rust engine (and a larger beam, since Rust can afford
   it) — the binary's own `beamSizeLimit` adapts upward on a fast machine, so this is the
   faithful configuration, not a cheat.
4. THEN delete the TS engine files + their tests; update `biome`/`tsconfig` if needed.
5. Re-verify: `bunx tsc --noEmit`, `bun test`, `bun run build`, `cargo test`, oracle diff.

## Note on beam size
The shipping binary grows `beamSizeLimit` toward ~1500 on a fast machine (its
`SetNextOption` adapts to the time budget). Our TS port was fixed at 150 because it is
~4x slower; with Rust we can run the binary's larger beams, which is faithful behaviour
(the user's "32-0" target), not an artificial advantage.
