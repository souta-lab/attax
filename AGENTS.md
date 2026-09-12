# AGENTS.md — Working Rules (user-directed)

## Do not stop with excuses
- Never stop work citing "insufficient permissions", "context limit", or similar as a reason to halt.
- If stuck or at capacity, USE A SUBAGENT (fresh context) to continue the task.
- The loop should keep making real progress; analysis-only cycles with no change are a waste.

## Priority order
1. **Keep the Hoiko replica faithful** (EvaluateAI + OffsetAI garbage management). The port is complete and oracle-verified in Rust/WASM; do not regress it.
2. **Beat Hoiko with DeepSeek** — validated under a fair harness (issue #24 fixed) and the faithful in-match Hoiko config (beam 150 + `SetNextOption` adaptation, `src/ai/hoiko-faithful.ts`): DeepSeek v2 wins **25-7** on the 32-seed gate, **21-11 at fixed beam 1500** (0 execution mismatches; raw records in `evidence/fair-harness/` and `evidence/hoiko-faithful/`). The earlier 32-0/80-0 numbers were an **APM artifact of the unfair step model**, not decision quality — see `docs/BEAT_HOIKO.md`. Keep it winning; do not adopt changes that are not measurably better.

## Use subagents
- Delegate large/parallel work to `deep`/`general` subagents; give them the exact source paths (HOME paths are readable, e.g. `/home/s0u7a/hoiko-src/`) and the current architecture (Rust/WASM is canonical; the TS engine is deleted — see `MIGRATION_RUST.md`).
- Verify subagent results strictly (tsc/test/build + the gate showing the intended outcome); revert broken results rather than accepting them.

## Engineering discipline
- Keep `bunx tsc --noEmit`, `bun test`, and `bun run build` green.
- Commit + push verified increments (atomic, meaningful messages). Do not commit unverified/speculative changes.
- Metric-verify changes where possible (lines, tetris, holes, maxHeight); avoid blind knob changes that show no measurable effect.
- No cheating: no seed rigging, no test weakening, no frozen-opponent re-creation, no `as any`/`ts-ignore`, no secrets.
- The **shipping binary is the authoritative** Hoiko reference (the provided `/home/s0u7a/hoiko-src` is an older/simplified revision). Match observable behavior against the binary via the Wine oracle; do not change `rust/hoiko-core`/`rust/hoiko-wasm` behavior.

## Current state
- Rust/WASM is canonical: `rust/hoiko-core` (expand/evaluate/search/OffsetAI) + `rust/hoiko-wasm`, built by `rust/build.sh` into `src/ai/wasm/hoiko_core.wasm`. The engine is ~2x the binary's speed with byte-identical moves (oracle diff 9/9 + beam-adaptation 9/9). Adapters: `src/ai/hoiko-rust.ts` (browser), `src/ai/hoiko-rust-core.ts` (shared), `tools/hoiko-rust/loader.ts` (Bun).
- DeepSeek: `src/ai/deepseek.ts` (v1) and `src/ai/deepseek-v2.ts` (**v2, the app's fighter** — SRS kicks, garbage defense, opponent timing). v2 is ported to Rust (`rust/deepseek-rust`) and to wasm (`rust/deepseek-wasm` -> `src/ai/wasm/deepseek_v2.wasm`, 2.4x faster) and the app runs it.
- Scoreboard: `bun scripts/gate-v2.ts` (env `HOIKO_BEAM` default 150, `HOIKO_ADAPT` default 1, `DSV2_RUST`, `DSV2_DEPTH`, `DSV2_BOOK`). The Hoiko opponent runs the faithful binary config via `src/ai/hoiko-faithful.ts` (app and all harnesses share it). The step model is fair as of #24 (one `stepIntervalMs` per terminal action); the honest gate is **25-7** under the faithful config (21-11 at fixed beam 1500), not 32-0 (`evidence/fair-harness/`, `evidence/hoiko-faithful/`).
- Gates: `bunx tsc --noEmit`, `bun test`, `bun run build`, `bun run lint`, `cargo test --manifest-path rust/Cargo.toml`, plus the oracle differentials in `tools/hoiko-oracle/diff/`.
- Backlog: opening book is implemented but opt-in/off (mixed result, `evidence/opening-book/`); self-play weight tuner exists (`scripts/tune-vs.ts`); GitHub Actions parked until the account billing is fixed.
