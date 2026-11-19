# AGENTS.md — working rules for this repo

## What this project is
A versus AI for the falling-block game ("the bot") and the evidence that it
beats Hoiko, run as a byte-faithful Rust/WASM port of the shipping Hoiko binary
(`rust/hoiko-core`, `src/ai/hoiko/`). The bot's engine is the GPU search in
`gpu/` (Vulkan), driven from the S2 lab (`tools/s2-lab/`); the TS and Rust
search implementations were removed in 2026-11-19 (see "Search engine rule").
The deliverable is a static web page (`dist/`) that shows the measured
head-to-head result.

## Layers (keep them separate)
- `src/core/` — rules engine. Pure, no DOM. The single source of truth for what a lock awards.
- `src/versus/` — two-player controller (garbage exchange, fair 120 ms-per-lock timing).
- `gpu/` — the bot: the Vulkan search host + shaders (the only engine; see below).
- `tools/s2-lab/` — the lab driver for the GPU engine (`gpu-player.ts`,
  `gpu-codec.ts`, `run-match.mjs`) plus the vendored evaluation shapes it
  needs (`features.ts`, `weights.ts`, `state.ts`, `search-types.ts`).
- `src/ai/hoiko/` — Hoiko adapter + wasm. Do not change Hoiko's behaviour.
- `src/bench/`, `src/sim/` — match record types/summary and the live arena (same tick loop).
- `src/ui/` — DOM/canvas only; the arena runs in a Web Worker (`arena-worker.ts`).
- `scripts/` — `build-results.ts` (bench-results -> the page's data).

## Rules of evidence
- Any number on the page comes from `bench-results/*.jsonl` via `bun run results`. Never type
  a number in by hand.
- Tuning uses seeds 2001+ only; the headline uses held-out seeds 1001-1200, both seats.
- Hoiko runs with `HOIKO_ADAPT=0` for reproducible games (the shipping wall-clock beam
  adaptation is measured separately).

## Search engine rule (2026-11-19, supersedes the 2026-11-16 Rust rule)
- The **GPU search** (`gpu/`, Vulkan serve host) is the only engine. Matches run
  through the S2 lab driver (`tools/s2-lab/gpu-player.ts`, wired into
  `run-match.mjs` via `lab-decision.ts`). There is **no fallback**: with no
  usable Vulkan device the driver stops at startup rather than silently
  degrading to a path tens of times slower.
- The TS search (`src/ai/bot`) and the Rust search (`rust/attax-search`,
  `attax-search-cli`) were **removed from the repo** (Phase C, 2026-11-19).
  The Rust search survives only as the identity-verification reference in
  the PC archive (`attax-rust-archive-2026-11-19` on the lab PC's storage);
  the removal record (kept with the GPU working papers outside this repo)
  holds the survey, the archive layout and its expiry condition.
- Every run record names the engine that produced it: match JSONL carries
  `settings.attaxEngine` (`{id: "gpu", device, tablesSha256}`) and
  `settings.attaxWeights` (the engine's fixed config O). A result that does
  not name its engine is not evidence.
- The GPU engine implements exactly config O (seed weights, stock Φ on,
  width 96, profile selected by `ATTAX_GPU_PROFILE`); the lab driver refuses
  any configuration that does not resolve to it.

## Gates
`bunx tsc --noEmit`, `bun test`, `bun run lint`, `bun run build`; `cargo test` for rust/
(the Hoiko workspace only).

## Naming
Display names live in `src/brand.ts` (+ `index.html` title/meta, `package.json` name).
The game must not be presented under a trademarked game name.
