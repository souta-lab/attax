<div align="center">

# ⚔️ Attax

**A versus AI for the falling-block game, with reproducible head-to-head results.**

[![Play live](https://img.shields.io/badge/play-live%20arena-2ea44f)](https://s0u7a.f5.si/attax/)
[![vs Hoiko](https://img.shields.io/badge/vs%20Hoiko-195%E2%80%935%20(97.5%25)-blue)](#-result-hoiko)
[![vs intetrigence](https://img.shields.io/badge/vs%20intetrigence-100%E2%80%930%20(100%25)-blue)](#-result-intetrigence)
![TypeScript](https://img.shields.io/badge/TypeScript-bun%20%2B%20vite-3178c6)
![Rust](https://img.shields.io/badge/Rust-WASM-dea584)

**[▶ Play / watch live: s0u7a.f5.si/attax](https://s0u7a.f5.si/attax/)**

</div>

Attax is a beam-search versus bot (no neural network, no opening book). The deliverable is
a static web page that shows the measured head-to-head result, every benchmark game as a
clickable square, and a live arena where Attax and a Rust/WASM replica of the Hoiko AI play
the same seed in your browser. Any benchmark game can be replayed move for move.

Essentials in this repo: the bot is in [`src/ai/bot/`](src/ai/bot/), raw benchmark records
are in [`bench-results/`](bench-results/), the Hoiko-replica fidelity evidence is in
[`evidence/hoiko-fullgame/`](evidence/hoiko-fullgame/), and the benchmark and audit scripts
are in [`scripts/`](scripts/).

> **Scoped claim:** in guideline versus rules, across every matchup measured so far, Attax
> has won each matchup against Hoiko, intetrigence (derived from MinusKelvin's Cold Clear 2),
> and clys; no opponent tested comes close. See [Caveats](#%EF%B8%8F-caveats--not-measured)
> for what has *not* been measured.

## 📑 Contents

- [Results at a glance](#-results-at-a-glance)
- [Result: Hoiko](#-result-hoiko)
- [Result: intetrigence](#-result-intetrigence)
- [Result: clys](#result-clys)
- [TBP](#tbp)
- [License](#license)
- [Why it is strong](#-why-it-is-strong)
- [Fairness](#%EF%B8%8F-fairness)
- [Caveats / not measured](#%EF%B8%8F-caveats--not-measured)
- [The bot](#-the-bot-srcaibot)
- [Layout](#%EF%B8%8F-layout)
- [Develop](#%EF%B8%8F-develop)
- [Reproducing the benchmarks](#-reproducing-the-benchmarks)
- [Renaming](#%EF%B8%8F-renaming)

## 📊 Results at a glance

| Opponent | Games | W–L | Win rate (95% Wilson) | Attack/piece (Attax vs opp.) |
|---|---|---|---|---|
| **Hoiko** (Rust/WASM replica of Hoiko.exe) | 200 | **195–5** | **97.5%** (94.3–98.9%) | **0.70** vs 0.46 |
| **intetrigence** (derived from MinusKelvin's Cold Clear 2) | 100 | **100–0** | **100%** (96.3–100%) | **0.559** vs 0.317 |
| **clys** (by citrus610) | 100 | **88–12** | **88.0%** (80.2%–93.0%) | **0.7346** vs 0.7791 |

All three matchups use held-out seeds (never used for tuning), and every seed was played from
both seats. In guideline versus rules, across everything measured so far, Attax has won
every matchup and no opponent tested is close. The details, conditions and limits follow.

## 🥊 Result: Hoiko

**Conditions.** These were identical for every row below:

- **Seeds:** held-out seeds 1001–1200. Tuning only ever used seeds 2001 and up.
- **Pieces:** both sides draw the same seeded piece sequence.
- **Rules:** the corrected T-spin rules; the rules audit agrees on 843 of 843 locks.
- **Pace:** each side locks one piece per 120 ms of game time, however long it thinks.
- **Hoiko settings:** preset `we`, beam 150, depth 14, 2-piece preview. Wall-clock
  adaptation was off (`--adapt 0`), so games are deterministic.
- **Game length:** cap of 12,000 ticks. No game reached the cap and there were no draws.

Each seed was played from both seats. The swapped game replayed identically on all 200
seeds, so each seed counts once (N = 200 independent games).

| Matchup | N | W–L | Win rate (95% Wilson) | Attack/piece | Lines/game |
|---|---|---|---|---|---|
| **Attax vs Hoiko** | 200 | **195–5** | **97.5% (94.3–98.9%)** | **0.70 vs 0.46** | 25.1 vs 18.5 |
| Attax limited to Hoiko's 2-piece preview vs Hoiko (seeds 1001–1100) | 100 | 89–11 | 89.0% (81.4–93.7%) | 0.58 vs 0.46 | 28.9 vs 21.2 |
| Previous AI (pre-overhaul `a4f14d7` + rules fix) vs Hoiko | 200 | 155–45 | 77.5% (71.2–82.7%) | 0.44 vs 0.48 | 29.1 vs 19.6 |

- **2-preview control run.** The headline Attax reads 5 preview pieces; Hoiko is
  configured for 2. With Attax limited to 2 previews as well, it still wins 89–11.
- **Previous AI.** The pre-overhaul AI sent *less* garbage per piece than Hoiko and won by
  outlasting it. Attax cuts losses from 45 to 5 and out-attacks Hoiko by about 50%.
- **Live replay check.** The in-browser arena reproduced benchmark game 1001 exactly
  (tick 293, garbage 20–8, matching the JSONL record), so the page runs the code that
  was benchmarked.

**What "Hoiko" means here.** Hoiko itself is a Windows .NET `.exe`. The benchmark plays
`rust/hoiko-core`, a Rust/WASM replica of it. On a machine with Wine, the replica was
checked move for move against the real `.exe` on 3 seeds: 500 of 500 moves identical in a
full game on seed 1, 200 of 200 on seeds 2 and 7 (900/900 in total), and its garbage-timing
logic also agreed (`evidence/hoiko-fullgame/`). That is strong fidelity evidence, but it
covers those 3 seeds; Attax has not played the real `.exe` directly.

Source of truth for every number on the page: `bench-results/*.jsonl` →
`src/data/results.json` (`bun run results`).

## 🧠 Result: intetrigence

**What intetrigence is.** intetrigence is a versus engine derived from MinusKelvin's Cold Clear 2
(MCTS search). In its own published 100-game evaluations against the official Cold Clear 2
(`results/comparisons/cold-clear2/` in the intetrigence repo), it won:

| intetrigence eval profile | intetrigence vs CC2 |
|---|---|
| retained tree, 10 ms / 40 PPS | 73–27 |
| retained tree, **100 ms / 5 PPS** (the profile used here) | **77–23** |
| strict time window, 100 ms / 5 PPS | 82–18 |
| guideline, strict, 10 ms / 40 PPS | 69–31 |
| guideline, strict, 10 ms / 40 PPS (v2) | 77–23 |

**Result.** Attax 100 – 0 intetrigence: 100 games = 50 held-out seeds (5001–5050) × both
seats, 0 draws. Win rate 100%, Wilson 95% CI 96.3–100%. Attax won both games on all 50
seeds. Counted as 50 correlated pairs instead, 50–0 gives a per-pair CI of 92.9–100%.

| Side | Attack/piece | Lines/game | Pieces/game | Garbage rows received (total) |
|---|---|---|---|---|
| Attax | **0.559** | 83.5 | 142.3 | 3,146 |
| intetrigence | 0.317 | 96.2 | 141.3 | 6,573 |

**Conditions.**

- **Referee:** intetrigence's own `external-arena` (commit `e816913`), `--rules guideline`:
  public multiplayer attack table (Single 0 / Double 1 / Triple 2 / Tetris 4, T-Spin S/D/T
  2/4/6, B2B +1), no combo or perfect-clear attack, SRS legality, 7-bag. The referee
  checks every move with `Game::legal` and plays it itself.
- **Attax** joins as an external bot over TBP (Tetris Bot Protocol) through a thin
  adapter that calls Attax's own fighter; no Attax logic is reimplemented. Fixed beam
  search, width 48, current piece + 5 previews, default weights; depth 6 on 98.7% of moves.
- **intetrigence** runs at `--ms 100` with default workers and default weights, at
  `--pps 5`: the same 100 ms / 5 PPS profile as its published 77–23 win over CC2.
- **Both** get 5 previews and hold. Seeds 5001–5050 are used by neither project's docs or
  benchmarks.

**Settings audit verdict: fair.** Before trusting the result, the harness was audited:

- Attax was never starved. Its first choice was accepted on 14,230 of 14,230 moves, with
  0 fallbacks and 0 errors.
- intetrigence was not starved either. It got its 100 ms target and actually used more
  (median 151 ms, p95 406 ms). There was no CPU contention, because Attax does not ponder
  and shards ran one at a time.
- `intetrigence verify-replay` re-executes the replays and confirms all 100 matches.

If anything, the time budget favoured intetrigence, which used about 5× Attax's median
think time per move.

## Result: clys

clys, by citrus610, is a Monte Carlo beam search bot. With its shipped default
configuration (width 500, depth 32, branch 3, one search thread), Attax won **88–12**
over 100 games: seeds **7001–7050**, both seats. Win rate **88.0%**, Wilson 95% CI
**80.2%–93.0%**. Attax's seat split was **46/42**, with no draws.

| Side | Attack/piece | Lines cleared (total) |
|---|---|---|
| Attax | 0.7346 | 7,948 |
| clys | 0.7791 | 6,267 |

clys had the higher firepower. Attax won on survival.

**Conditions.** The external-bot harness uses the intetrigence referee's guideline
attack table without combo or perfect-clear attack. Both bots get 5 previews and hold,
with 5 PPS paired turns and a 1,000-turn cap (no game reached it). clys gets a 100 ms
wall-clock search window; Attax completes fixed work without a deadline. Each lane
runs on a dedicated CPU core, with only one bot thinking at a time within it.
Neither bot receives pending-garbage information over TBP. All counted games were
replay-verified. Source: the clys section of the local
`~/workspace/attax-gauntlet/REPORT.md`.

## 🚀 Why it is strong

- **Exact move generation.** A breadth-first search over the engine's real inputs (shift,
  soft drop, SRS rotation with kicks) finds every reachable resting placement and flags
  T-spin entries. Nothing reachable is missed, and nothing unreachable is played.
- **Deep lookahead.** A width-48 beam search over the current piece plus 5 previews,
  with hold, garbage cancellation and discounted rewards.
- **Versus-tuned evaluation.** Dellacherie-style board terms plus versus terms (danger
  from incoming garbage, T-slot readiness), plus a direct attack reward, a back-to-back
  break penalty and a wasted-T penalty.
- **Attack efficiency against Hoiko and intetrigence.** Attack per piece is 0.70 vs Hoiko's 0.46
  (about 50% more) and 0.559 vs intetrigence's 0.317 (about 1.75×). intetrigence received
  6,573 garbage rows against Attax's 3,146. Against clys, Attax instead won on survival
  despite lower attack per piece.

## ⚖️ Fairness

- **Seat swaps.** Every seed in all three matchups was played from both seats, so each AI plays
  each piece sequence. Against Hoiko the swapped games are identical (both AIs are
  deterministic and the engine is seat-symmetric), so they are counted once.
- **Identical harness for both sides.** Against Hoiko, both AIs run in the same headless
  engine (`src/core`) and tick loop as the live page. Against intetrigence, intetrigence's
  own referee hosts both sides under the same rules.
- **Time usage.**
  - vs Hoiko: each side locks one piece per 120 ms of game time regardless of think time.
  - vs intetrigence: median think time was 35 ms for Attax and 151 ms for intetrigence.
    Attax's per-move time is not capped (the referee waits for its answer), but its search
    is fixed-work and it used far less time than its opponent.
- **Garbage-blindness works against Attax.** TBP has no garbage message, so against
  intetrigence Attax never sees pending garbage, while intetrigence does. (Under guideline
  rules garbage is inserted right after each lock, so the pending queue is usually empty.)
- **Rules audited.** `scripts/audit-rules.ts` checks that the engine awards Hoiko exactly
  the clear Hoiko's own search predicted for each move. Before the overhaul it did not:
  the T-spin front-corner table (commit `dcbe108`) had rotations 0 and 2 swapped, so every
  T-spin double Hoiko made (51 of 51 in the audit) was scored as a mini (attack 1
  instead of 4). Fixed in `src/core/tspin.ts`; all numbers here are after the fix.
- **Every placement is legal.** The bot executes with `placeMinoAt`, so
  `tests/bot-movegen.test.ts` drives the real engine to prove each placement (and each
  claimed T-spin) is reachable with ordinary inputs, and that none are missed.
- **Held-out seeds.** Tuning only ever used seeds 2001+.

## ⚠️ Caveats / not measured

- **Real Hoiko.exe, direct play:** not measured (no Wine on the benchmark VM). All Hoiko
  numbers come from the replica, whose fidelity evidence covers 3 seeds (see above).
- **Hoiko with wall-clock adaptation on (`--adapt 1`):** not measured.
- **Official Cold Clear 2, direct play:** not measured. The CC2 comparison goes through
  intetrigence's own published wins over CC2.
- **intetrigence at longer budgets:** only 100 ms / 5 PPS, default workers on a 4-CPU VM
  was tested. Longer budgets or more cores might help intetrigence.
- **Arena rules (combo / perfect-clear attack):** untested against intetrigence; the
  result covers guideline rules only.
- **clys scope:** only default configuration, a 100 ms window and this guideline profile.
  Its evaluator values combo/perfect clears that the referee does not score. This is
  not an equal-compute ranking. Attax sees only the bottom 20 rows and ignores bag state;
  clys sees 40 rows and can use bag state. The game-level Wilson interval is descriptive:
  the independent units are 50 seat-swapped seed pairs. Stochastic search and time slicing
  mean fresh runs can differ. Realtime input execution and network latency were not measured.
- **One weight set.** All results are for a single, fixed set of hand-set weights.

## 🤖 The bot (`src/ai/bot/`)

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

## License

AGPL-3.0. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) for the Hoiko benchmark
carve-out.

## 🗂️ Layout

```
src/core      rules engine (pure)          src/sim      live arena (same tick loop as bench)
src/versus    2-player controller          src/ui       DOM + canvas; arena runs in a Worker
src/ai/bot    the bot                      scripts      benchmark, audit, tune, build-results
src/ai/hoiko  Hoiko adapter + wasm         rust/        Hoiko replica source (wasm)
src/bench     headless match + summary     tools/       Hoiko oracle (needs Wine + the exe)
```

## 🛠️ Develop

`bun run dev` · `bun test` · `bun run lint` · `bun run build` (outputs `dist/` with relative
asset paths; it works from any subpath, e.g. `/tetris/`). Rust: `bun run test:rust`.

## 🔁 Reproducing the benchmarks

### vs Hoiko (in this repo)

```sh
bun install
# headline: 200 seeds × both seats (seats replay identically)
bun scripts/benchmark.ts --seeds 1001-1200 --sides both --jobs 4 --out bench-results/bot-vs-hoiko.jsonl
# control: Attax limited to 2 previews
bun scripts/benchmark.ts --seeds 1001-1100 --sides both --preview 2 --jobs 4 --out bench-results/bot-vs-hoiko.preview2.jsonl
# rules audit: the engine awards Hoiko exactly what Hoiko's search predicted
bun scripts/audit-rules.ts --seeds 3001-3020 --out bench-results/rules-audit.json
# page data + site
bun scripts/build-results.ts      # -> src/data/results.json (what the page shows)
bun run build                     # -> dist/
```

The previous AI's row is reproduced at the pre-overhaul commit `a4f14d7` with
`bench-results/old-ai-rules-fix.patch` applied (the rules fix only), once per seed parity,
then concatenated:

```sh
HOIKO_ADAPT=0 DSV2_RUST=1 HOIKO_SEEDS=1001,1003,...,1199 bun scripts/gate-v2.ts
HOIKO_ADAPT=0 DSV2_RUST=1 HOIKO_SEEDS=1002,1004,...,1200 bun scripts/gate-v2.ts
```

### vs intetrigence (external harness)

The packaged TBP adapter is in [tbp/](tbp/). The original benchmark launcher
and `analyze.py` live in a separate harness directory. With intetrigence
`e816913` built (`cargo build --release`) next to them, one shard looks like:

```sh
ATTAX_TBP_LOG=$PWD/runs/main-5024.attax.log ./intetrigence/target/release/intetrigence external-arena \
  --rules guideline --opponent ./attax-tbp.sh --games 28 --seed 5024 --ms 100 --pps 5 --turns 1000 \
  --output runs/main-5024.json --replay runs/main-5024.jsonl
# combine the shards (5001–5023, 5024–5037, 5038–5050), then analyse and verify
python3 -I analyze.py runs/final-5001-5050.jsonl runs/final-5001-5050.attax.log
./intetrigence/target/release/intetrigence verify-replay --input runs/main-5024.jsonl
```

In the shard JSON files, `wins`/`losses` are counted from intetrigence's side, and the
replay labels the external bot `cold_clear_2` (hard-coded in intetrigence); in these runs
that label means Attax. intetrigence's search is stochastic, so exact replays of the
match will differ; `verify-replay` re-checks the recorded games.

## 🏷️ Renaming

Change `src/brand.ts` (all on-page names), `index.html` (`<title>`, meta description) and
`package.json` `name`; rebuild. Internal module names (`bot`, `hoiko`) are neutral.
