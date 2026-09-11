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

## Current phase: honest re-baseline and strength work

The faithful Hoiko port is **done** and oracle-verified: search (9/9 depth-10, 2/2
depth-14, 9/9 two-search beam), **OffsetAI garbage management** (all-methods md5-identical
to the binary), and the Rust/WASM port (`rust/hoiko-core`) that now runs the app and beats
the binary's ~101 ms/move on speed. What remains:

1. **Honest re-baseline (headless)**: faithful Hoiko vs current DeepSeek, many seeds, win
   rate + survival metrics. The earlier "DeepSeek beats Hoiko" result measured the port's
   defects, not DeepSeek (see below).
2. **Then** decide DeepSeek's fate from that true baseline.

## Correcting an invalid earlier claim

A prior "DeepSeek beats Hoiko 7-0-1" result is **not evidence**: that Hoiko was broken
(no OffsetAI, 4x-slow depth cutoff). It measured the port's defects, not DeepSeek's
strength. The true DeepSeek-vs-Hoiko baseline is unknown until the faithful Hoiko is done.

## Ordered plan

1. ~~Finish OffsetAI integration~~ — done (identical to the binary; Rust port verified).
2. ~~Depth-14 interim~~ — done; the Rust engine reaches depth 14 within the binary's budget.
3. ~~Rust core port~~ — done: one `rust/hoiko-core` serves native + wasm, differential-tested
   against the oracle; it now beats the binary on speed (`rust/PERF.md`).
4. **Honest re-baseline (headless)**: faithful Hoiko vs current DeepSeek, many seeds, win
   rate + survival metrics.
5. **Then** decide DeepSeek's fate (strengthen / port / rewrite) based on the true baseline
   — not before.

## Non-goals (for now)
- Rewriting DeepSeek before the faithful Hoiko baseline exists.
- Browser-first development.
- Chasing micro-optimizations in TS that a Rust core subsumes.
