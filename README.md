# Attax vs Hoiko

Attax is a versus AI for the falling-block game, built to show — with reproducible numbers — that it
beats **Hoiko**, run as a byte-faithful port of the shipping Hoiko binary. The deliverable
is a static web page: the headline result, every benchmark game as a clickable square, and
a live arena where both AIs play the same seed in your browser and replay any benchmark
game move for move.

(Display names live in `src/brand.ts`; see "Renaming" below.)

## Result

Held-out seeds 1001–1200 (never used for tuning), Hoiko deterministic (`--adapt 0`), both
sides locking one piece per 120 ms. Each seed was played from both seats; the swapped game
replayed identically on all 200 seeds, so each seed counts once (N = 200 independent games).

| Matchup | N | W–L | Win rate (95% Wilson) | Attack/piece | Lines/game |
|---|---|---|---|---|---|
| Attax (this bot) vs Hoiko | 200 | 195–5 | 97.5% (94.3–98.9%) | 0.70 vs 0.46 | 25.1 vs 18.5 |
| Previous AI (pre-overhaul `a4f14d7` + rules fix) vs Hoiko | 200 | 155–45 | 77.5% (71.2–82.7%) | 0.44 vs 0.48 | 29.1 vs 19.6 |
| Attax limited to Hoiko's 2-piece preview vs Hoiko | 100 | 89–11 | 89.0% (81.4–93.7%) | 0.58 vs 0.46 | 28.9 vs 21.2 |

Source of truth: `bench-results/*.jsonl` → `src/data/results.json` (`bun run results`).

Reproduce:

```sh
bun install
bun scripts/benchmark.ts --seeds 1001-1200 --sides both --jobs 4 --out bench-results/bot-vs-hoiko.jsonl
bun scripts/audit-rules.ts --seeds 3001-3020 --out bench-results/rules-audit.json
bun scripts/build-results.ts      # -> src/data/results.json (what the page shows)
bun run build                     # -> dist/
```

The previous AI's row is reproduced at the pre-overhaul commit `a4f14d7` with
`bench-results/old-ai-rules-fix.patch` applied (the rules fix only):
`HOIKO_ADAPT=0 DSV2_RUST=1 HOIKO_SEEDS=1001,...,1200 bun scripts/gate-v2.ts`.

## Fairness

- **Hoiko is the real thing**: `rust/hoiko-core` reproduces the shipping executable's moves
  (500/500 and 200/200 moves in full games on three seeds, including its garbage-timing
  logic; see `evidence/hoiko-fullgame/`).
- **Rules audited**: `scripts/audit-rules.ts` checks that the engine awards Hoiko exactly the
  clear Hoiko's own search predicted for each move. Before the overhaul it did not — the
  T-spin front-corner table (commit `dcbe108`) had rotations 0 and 2 swapped, so every
  T-spin double Hoiko made (51 of 51 in the audit) was scored as a mini (attack 1 instead
  of 4). Fixed in `src/core/tspin.ts`; all numbers here are after the fix.
- **Same pace**: each side locks one piece per 120 ms of game time regardless of think time.
- **Same pieces, both seats, held-out seeds**: tuning only ever used seeds 2001+.
- **Every placement is legal**: the bot executes with `placeMinoAt`, so
  `tests/bot-movegen.test.ts` drives the real engine to prove each placement (and each
  claimed T-spin) is reachable with ordinary inputs, and that none are missed.

## The bot (`src/ai/bot/`)

- `movegen.ts` — breadth-first search over the engine's own inputs (shift, soft drop,
  rotate with first-fit SRS kicks) from the current position; returns every distinct
  resting placement and whether it can be entered by a rotation (T-spins classified with
  the engine's own function).
- `features.ts` — eleven named board terms: height, danger (height + incoming garbage
  above row 10, squared), holes, blocks over holes, rows with holes, bumpiness (plain and
  squared), row transitions, well depth, extra wells, T-slot readiness.
- `weights.ts` — the whole policy in one table: board weights, attack reward, per-clear
  shaping, back-to-back break penalty, wasted-T penalty.
- `search.ts` — beam search (width 48) over the current piece plus the 5-piece preview,
  with hold. A line's value is its discounted rewards plus the board score at its end;
  the first move of the best line is played. Incoming garbage cancels against attack and
  the remainder lands under the stack, as in the engine.
- `fighter.ts` — snapshot in, one `placeAt` move out.

## TBP

Attax also runs as a Tetris Bot Protocol (TBP) process for external match hosts.
With Bun installed, run from the repository root:

```sh
bun tbp/attax-tbp.ts
```

For hosts that take an executable path, use `tbp/attax-tbp.sh` (Bun must be on
`PATH`). The launcher works from any working directory. Stdin and stdout carry
newline-delimited TBP JSON; optional `ATTAX_TBP_LOG=/path/to/decisions.jsonl` records
decisions separately. The adapter calls the same `createBot().findBestMove` fighter
as the arena, with the default preview and beam width.

The worked example is the [intetrigence match report](tbp/intetrigence-match.md):
it describes the external-arena command, rules, timing and verification of the
original match. The adapter keeps its original coordinate translation and ranked
suggestions. It sees only the bottom 20 rows and receives no pending-garbage
information; hosts must resend `start` after garbage changes the board.

To smoke-test against an already-built intetrigence referee, without network access:

```sh
python3 tbp/smoke.py /path/to/intetrigence/target/release/intetrigence
```

This plays two games with seats swapped, checks every accepted Attax move against
its first suggestion, and runs the referee's replay verifier.
See [the recorded smoke result](tbp/SMOKE.md).

## Layout

```
src/core      rules engine (pure)          src/sim      live arena (same tick loop as bench)
src/versus    2-player controller          src/ui       DOM + canvas; arena runs in a Worker
src/ai/bot    the bot                      scripts      benchmark, audit, tune, build-results
src/ai/hoiko  Hoiko adapter + wasm         rust/        Hoiko replica source (wasm)
src/bench     headless match + summary     tools/       Hoiko oracle (needs Wine + the exe)
```

## Develop

`bun run dev` · `bun test` · `bun run lint` · `bun run build` (outputs `dist/` with relative
asset paths; it works from any subpath, e.g. `/tetris/`).

## Renaming

Change `src/brand.ts` (all on-page names), `index.html` (`<title>`, meta description) and
`package.json` `name`; rebuild. Internal module names (`bot`, `hoiko`) are neutral.
