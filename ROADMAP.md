# Roadmap — Hoiko fidelity, then honest benchmarking

## Decision: headless-first, Rust core, browser is display-only

The project's purpose is **strength research** (faithful Hoiko, then measure/beat it),
not a web app. So:

| Purpose | Environment |
|---|---|
| Strength research, win-rate measurement, regression gates | **headless (Bun/Node CLI)** |
| Engine speed | **Rust core**, native addon (napi) for headless; wasm for the browser |
| Demo / visualization / distribution | browser (thin wasm wrapper over the same core) |

One Rust core serves all three. The browser is a *viewing layer*, not where the research
happens.

## Current phase: finish the faithful Hoiko port (app-wide 1:1)

The **search is oracle-matched** (9/9 depth-10, 2/2 depth-14, 9/9 two-search beam) against
the shipping binary via the Wine runtime oracle. Remaining gaps:

1. **OffsetAI (garbage management)** — in progress. Without it HOIKO ignores incoming
   garbage and gets buried. This is the dominant strength defect. See `SPEC_OffsetOffAI.md`.
2. **Time budget / depth** — the binary reaches depth 14 within its ~107 ms in-match timer
   (101 ms measured); the TS engine is ~4.3x slower and gets cut at the minDepth floor.
   Interim fix: run to depth 14 deterministically (`timeLimitMs: Infinity`, `adapt: false`)
   = the binary's "fast machine" behaviour (oracle-verified). Real fix: Rust/WASM speed.

## Correcting an invalid earlier claim

A prior "DeepSeek beats Hoiko 7-0-1" result is **not evidence**: that Hoiko was broken
(no OffsetAI, 4x-slow depth cutoff). It measured the port's defects, not DeepSeek's
strength. The true DeepSeek-vs-Hoiko baseline is unknown until the faithful Hoiko is done.

## Ordered plan

1. **Finish OffsetAI integration** (in flight) and re-verify: tsc/test/build + oracle 9/9.
2. **Depth-14 interim** (`Infinity` + `adapt:false`) to remove the speed-induced weakness.
3. **Honest re-baseline (headless)**: faithful Hoiko vs current DeepSeek, many seeds, win
   rate + survival metrics. Expect Hoiko to win now.
4. **Rust core port**: move the oracle-matched engine (and later the rule primitives shared
   with DeepSeek) into `rust/hoiko-core`; ship native addon (headless) + wasm (browser).
   Verify with differential tests (TS vs Rust-native vs WASM) + the oracle.
5. **Then** decide DeepSeek's fate (strengthen / port / rewrite) based on the true baseline
   — not before.

## Non-goals (for now)
- Rewriting DeepSeek before the faithful Hoiko baseline exists.
- Browser-first development.
- Chasing micro-optimizations in TS that a Rust core subsumes.
