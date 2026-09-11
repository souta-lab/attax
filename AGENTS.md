# AGENTS.md — Working Rules (user-directed)

## Do not stop with excuses
- Never stop work citing "insufficient permissions", "context limit", or similar as a reason to halt.
- If stuck or at capacity, USE A SUBAGENT (fresh context) to continue the task.
- The loop should keep making real progress; analysis-only cycles with no change are a waste.

## Priority order
1. **Keep the Hoiko replica faithful** (EvaluateAI + OffsetAI garbage management). The port is complete and oracle-verified in Rust/WASM; do not regress it.
2. **Then beat Hoiko** with DeepSeek (the goal: a stronger AI that wins vs Hoiko).

## Use subagents
- Delegate large/parallel work to `deep`/`general` subagents; give them the exact source paths (HOME paths are readable, e.g. `/home/s0u7a/hoiko-src/`) and the current architecture (Rust/WASM is canonical; the TS engine is deleted — see `MIGRATION_RUST.md`).
- Verify subagent results strictly (tsc/test/build + the gate showing the intended outcome); revert broken results rather than accepting them.

## Engineering discipline
- Keep `bunx tsc --noEmit`, `bun test`, and `bun run build` green.
- Commit + push verified increments (atomic, meaningful messages). Do not commit unverified/speculative changes.
- Metric-verify changes where possible (lines, tetris, holes, maxHeight); avoid blind knob changes that show no measurable effect.
- No cheating: no seed rigging, no test weakening, no frozen-opponent re-creation, no `as any`/`ts-ignore`, no secrets.
- Reverse-engineering artifacts are obsolete now that Hoiko's real C++ source is available at `/home/s0u7a/hoiko-src/` (do not re-derive from decompiled binaries).

## Current state
- Rust/WASM is canonical: `rust/hoiko-core` (expand/evaluate/search/OffsetAI) + `rust/hoiko-wasm`, built by `rust/build.sh` into the checked-in `src/ai/wasm/hoiko_core.wasm`. Adapters: `src/ai/hoiko-rust.ts` (browser), `src/ai/hoiko-rust-core.ts` (shared), `tools/hoiko-rust/loader.ts` (Bun). The TypeScript engine is deleted (`MIGRATION_RUST.md`).
- `src/ai/deepseek.ts`: DeepSeek is the AI to strengthen and use to beat Hoiko.
- Gates: `bunx tsc --noEmit`, `bun test`, `bun run build`, `bun run lint`, plus the oracle differentials in `tools/hoiko-oracle/diff/`.
