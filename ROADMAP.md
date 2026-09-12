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

A prior "DeepSeek beats Hoiko 7-0-1" result was **not evidence**: that Hoiko was broken
(no OffsetAI, 4x-slow depth cutoff). It measured the port's defects, not DeepSeek's
strength. Now that the faithful Hoiko is oracle-verified, the measured baseline is
DeepSeek v1 **23-9** (pre-fix), and DeepSeek v2 **32-0** on the fixed 32-seed gate — a
number later invalidated by a harness fairness bug (#24). Under the fair step model the
honest result is **21-11** (`evidence/fair-harness/`, `docs/BEAT_HOIKO.md`).

## Ordered plan

1. ~~Finish OffsetAI integration~~ — done (identical to the binary; Rust port verified).
2. ~~Depth-14 interim~~ — done; the Rust engine reaches depth 14 within the binary's budget.
3. ~~Rust core port~~ — done: one `rust/hoiko-core` serves native + wasm, differential-tested
   against the oracle; it now beats the binary on speed (`rust/PERF.md`).
4. ~~Honest re-baseline (headless)~~ — done: on the fixed 32-seed gate vs the faithful
   Hoiko (beam 500), DeepSeek v1 won **23-9**.
5. ~~Strengthen DeepSeek~~ — done: **DeepSeek v2** (SRS kicks/tucks, incoming-garbage
   defense, opponent-aware attack timing, downstack/burst selection, deeper beam) is now
   the app's versus fighter. Under the **fair** step model (#24) it wins **21-11** on the
   32-seed gate (and 21-11 at Hoiko beam 1500), 0 execution mismatches.
   See `docs/BEAT_HOIKO.md`, `evidence/fair-harness/`, `src/ai/deepseek-v2.ts`.

## Next

- **Fair-harness re-baseline of the held-out corpora**: the 16-0/64-0/80-0 fresh-seed
  claims are pre-#24 (unfair step model); re-measure them with `bun scripts/gate-v2.ts`.
- **Higher-fidelity Hoiko**: model the binary's in-match adaptive beam (`SetNextOption`)
  and its ~107 ms wall-clock budget; oracle-diff at high beam (500/1500) and preset `we`
  beyond the 9 synthetic positions (`tools/hoiko-oracle/diff/REPORT.md` §6).
- Wider robustness testing: Hoiko across all weight presets (`we/wo/wd/wr/ultra2/sprint`),
  longer corpora, and non-aligned garbage, to confirm the margin is not configuration-specific.
- Versus self-play weight tuning on top of v2 (`overnight/tuner` harness).
- Optional: keep the faithful Rust `hoiko-core` frozen as the reference opponent; do not
  change its observable behavior.

## Non-goals (for now)
- Changing Hoiko engine observable behavior (it is the faithful reference).
- Browser-first development.
- Chasing micro-optimizations in TS that a Rust core subsumes.
