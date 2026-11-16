# AGENTS.md — working rules for this repo

## What this project is
A versus AI for the falling-block game ("the bot", `src/ai/bot/`) and the evidence that it
beats Hoiko, run as a byte-faithful Rust/WASM port of the shipping Hoiko binary
(`rust/hoiko-core`, `src/ai/hoiko/`). The deliverable is a static web page (`dist/`) that
shows the measured head-to-head result and lets anyone replay any benchmark game live.

## Layers (keep them separate)
- `src/core/` — rules engine. Pure, no DOM. The single source of truth for what a lock awards.
- `src/versus/` — two-player controller (garbage exchange, fair 120 ms-per-lock timing).
- `src/ai/bot/` — the bot: `movegen.ts` (exact engine-input BFS), `features.ts`,
  `weights.ts` (the whole policy in one table), `search.ts` (beam search), `fighter.ts`.
- `src/ai/hoiko/` — Hoiko adapter + wasm. Do not change Hoiko's behaviour.
- `src/bench/`, `src/sim/` — headless match runner and the live arena (same tick loop).
- `src/ui/` — DOM/canvas only; the arena runs in a Web Worker (`arena-worker.ts`).
- `scripts/` — `benchmark.ts`, `audit-rules.ts`, `tune.ts`, `build-results.ts`.

## Rules of evidence
- Any number on the page comes from `bench-results/*.jsonl` via `bun run results`. Never type
  a number in by hand. Re-run the benchmark after any change to `src/core`, `src/versus`
  or `src/ai/bot`, then rebuild `dist/`.
- Tuning uses seeds 2001+ only; the headline uses held-out seeds 1001-1200, both seats.
- Hoiko runs with `HOIKO_ADAPT=0` for reproducible games (the shipping wall-clock beam
  adaptation is measured separately).
- `bun run audit` must show the engine awarding Hoiko exactly the clears Hoiko predicts.
  A disagreement means the rules engine is judging Hoiko unfairly (this happened: commit
  dcbe108 turned Hoiko's TSDs into minis).
- `tests/bot-movegen.test.ts` proves every bot placement is reachable with real engine
  inputs. The bot executes via `placeMinoAt`, which only checks free cells, so never
  weaken that test.

## Search engine rule (2026-11-16)
- Matches and benchmarks run on the **Rust search** (`rust/attax-search`, driven through
  the `attax-agree` CLI). The TS search (`src/ai/bot/search.ts`) is the **reference
  implementation**: it exists for agreement checking, never for producing match records.
- The S2 lab driver (`tools/s2-lab/attax-player.ts`) defaults to the Rust engine. Running
  on TS requires the explicit opt-in `ATTAX_ENGINE=ts-reference`. There is **no fallback**:
  a missing or failing Rust binary aborts the run at startup (the driver handshakes the
  binary before the first decision).
- Every run record names the engine that produced it (engine id + build commit): match
  JSONL carries `settings.attaxEngine`, corpus runs write a `<output>.engine.json`
  sidecar, bench outputs carry an `engine` field. A result that does not name its engine
  is not evidence.
- The TS↔Rust agreement harness and the S2 corpus digest pin run in CI (job `agreement`)
  and fail on divergence. Case expectations are dumped from the TS reference only
  (`tools/search-port/dump-s2-cases.ts` refuses any other engine).

## Gates
`bunx tsc --noEmit`, `bun test`, `bun run lint`, `bun run build`; `cargo test` for rust/.
Note: `bun test` exercises the lab driver on its default (Rust) engine — build the
release CLI first (`cargo build --release --manifest-path rust/Cargo.toml -p attax-search-cli`),
or opt into the reference with `ATTAX_ENGINE=ts-reference bun test`.

## Naming
Display names live in `src/brand.ts` (+ `index.html` title/meta, `package.json` name).
The game must not be presented under a trademarked game name.
