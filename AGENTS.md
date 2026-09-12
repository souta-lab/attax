# AGENTS.md — Working Rules (user-directed)

## Do not stop with excuses
- Never stop work citing "insufficient permissions", "context limit", or similar as a reason to halt.
- If stuck or at capacity, USE A SUBAGENT (fresh context) to continue the task.
- The loop should keep making real progress; analysis-only cycles with no change are a waste.

## Priority order
1. **Keep the Hoiko replica faithful** (EvaluateAI + OffsetAI garbage management). The port is complete, oracle-verified in Rust/WASM, and now **end-to-end equivalent to the shipping exe — including garbage/OffsetAI**: the exe-driven solo differential matches 500/500 moves, and the exe-as-fighter versus differential shows full agreement on moves, `garbageWait` and all 15 carried OffsetAI fields (`evidence/hoiko-fullgame/`, `evidence/hoiko-fullgame/garbage/`). Fixes: beam-cutoff `std::partial_sort`, `Board::is_tspin` mini classification, and `DecisionOffsetOff` board/height seeding (`FirstMoveState`). Do not regress it.
2. **Beat Hoiko with DeepSeek** — validated under a fair harness (#24), the faithful in-match Hoiko opponent (beam 150 + `SetNextOption` adaptation), and a corrected versus input contract (see below): DeepSeek v2 wins **23-9** on the 32-seed gate (deterministic, adaptation off; 0 execution mismatches; `evidence/hoiko-inputs/audit/`). The earlier 32-0/80-0 numbers were an **APM artifact of the unfair step model**, and 21-11/25-7/27-5/24-8/26-6 were measured on the pre-input-audit replica. Every primary input is now exe-verified, so the remaining gap is DeepSeek being genuinely stronger — see `docs/BEAT_HOIKO.md`. Keep it winning; do not adopt changes that are not measurably better.

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
- Rust/WASM is canonical: `rust/hoiko-core` (expand/evaluate/search/OffsetAI) + `rust/hoiko-wasm`, built by `rust/build.sh` into `src/ai/wasm/hoiko_core.wasm`. The engine is ~2x the binary's speed with byte-identical moves (oracle diff 9/9 + beam-adaptation 9/9). **End-to-end exe equivalence**: the exe-driven solo differential (`tools/hoiko-oracle/diff/fullgame.ts`) matches 500/500 moves on seed 1 and 200/200 on seeds 2 and 7, and the full search arena matches the exe byte-for-byte (`evidence/hoiko-fullgame/`). Adapters: `src/ai/hoiko-rust.ts` (browser), `src/ai/hoiko-rust-core.ts` (shared), `tools/hoiko-rust/loader.ts` (Bun).
- DeepSeek: `src/ai/deepseek.ts` (v1) and `src/ai/deepseek-v2.ts` (**v2, the app's fighter** — SRS kicks, garbage defense, opponent timing). v2 is ported to Rust (`rust/deepseek-rust`) and to wasm (`rust/deepseek-wasm` -> `src/ai/wasm/deepseek_v2.wasm`, 2.4x faster) and the app runs it.
- Scoreboard: `bun scripts/gate-v2.ts` (env `HOIKO_BEAM` default 150, `HOIKO_ADAPT` default 1, `DSV2_RUST`, `DSV2_DEPTH`, `DSV2_BOOK`). The Hoiko opponent runs the faithful binary config via `src/ai/hoiko-faithful.ts` (app and all harnesses share it), with the exe-verified versus input contract (`src/ai/hoiko-next.ts` NextMino carry, `src/ai/hoiko-opponent.ts` opponent flags, carried weight row, combo sign). The step model is fair as of #24; the honest gate is **23-9** (deterministic, adaptation off), not 32-0 (`evidence/hoiko-inputs/audit/`).
- Gates: `bunx tsc --noEmit`, `bun test`, `bun run build`, `bun run lint`, `cargo test --manifest-path rust/Cargo.toml`, plus the oracle differentials in `tools/hoiko-oracle/diff/`.
- Hoiko config toggles: `src/ai/hoiko-faithful.ts` is the single source of truth for the default in-match config. Shipping-binary toggles ported + exe-verified: `usePCstack` (infinite-PC, `evidence/hoiko-config/pcstack/`), `useS4W` (binary `GetResource` body, `evidence/hoiko-config/s4w/`), `useOffsetOff` (offset), and the weight presets. **Opening templates (`useTDOpeners`/`loopTemplate`, only active when `viewNext>=5`) are HELD**: the logic is reconstructible but the shipping exe crashes in the `OpSearch`/`useHold` path (`ExpandAI` `expandedChild` 40×20 overrun, nondeterministic under Wine), so unpatched-exe equivalence is unmeasurable; the TemplateAI control plane is ported and exe-verified 25/25 and the remaining lambdas/`OpSearch` are scoped in `evidence/hoiko-config/tdopeners/ASSESSMENT.md`.
- Backlog: opening book is implemented but opt-in/off (mixed result, `evidence/opening-book/`); self-play weight tuner exists (`scripts/tune-vs.ts`); GitHub Actions parked until the account billing is fixed.
