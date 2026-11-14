<div align="center">

# ⚔️ Attax

**A versus AI for the falling-block game, with reproducible head-to-head results.**

[![Play live](https://img.shields.io/badge/play-live%20arena-2ea44f)](https://s0u7a.f5.si/attax/)
[![vs Hoiko](https://img.shields.io/badge/vs%20Hoiko-195%E2%80%935%20(97.5%25)-blue)](#-result-hoiko)
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
> has won each matchup it has played — against Hoiko, clys and Cold Clear 2 (the official
> upstream build and chouhy's fork). See [Caveats](#%EF%B8%8F-caveats--not-measured)
> for what has *not* been measured.

## 📑 Contents

- [Results at a glance](#-results-at-a-glance)
- [Result: Hoiko](#-result-hoiko)
- [Result: clys](#result-clys)
- [Result: Cold Clear 2](#result-cold-clear-2)
- [Profiles](#-profiles)
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
| **clys** (by citrus610) | 100 | **88–12** | **88.0%** (80.2%–93.0%) | **0.7346** vs 0.7791 |
| **Cold Clear 2** (official upstream, `ed8b193`) | 100 | **79–21** | **79.0%** (70.0–85.8%) | 0.8951 vs **0.9279** |
| **Cold Clear 2 fork** (chouhy) | 40 | **27–13** | **67.5%** (52.0–79.9%) | **0.9218** vs 0.8298 |

All matchups use held-out seeds (never used for tuning), and every seed was played from
both seats. The Cold Clear 2 matches were played by the competition profile, **attax v2**
(see [Profiles](#-profiles)), under an external TBP rig; against the official build Attax
won on survival despite the lower attack rate. The details, conditions and limits follow.

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

- **2-preview control run.** The headline Attax reads 5 preview pieces; Hoiko is
  configured for 2. With Attax limited to 2 previews as well, it still wins 89–11.
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

## Result: Cold Clear 2

Cold Clear 2 is MinusKelvin's engine, the strongest open baseline in this class. Attax
played it twice through the external rig in `tools/cc2-rematch/` (guideline rules over
TBP, a strict 100 ms window with the child suspended during the local search, 5 PPS
paired turns), using the competition profile described under
[Profiles](#-profiles) — the field-40 view with exact 7-bag speculation. Both matches
were replay-verified in full.

Against the official upstream build at `ed8b193`, seeds 13001–13050 from both seats,
Attax won **79–21** with no draws (win rate 79.0%, Wilson 95% CI 70.0–85.8%). The
official build actually produced more attack per piece, 0.9279 to Attax's 0.8951;
Attax won on survival, the same pattern as the clys match. Against chouhy's fork of
the same upstream base, seeds 2701–2720 from both seats, Attax won **27–13** with no
draws (67.5%, CI 52.0–79.9%), this time also ahead on attack per piece, 0.9218 to
0.8298. Per-seed records and generated summaries live in
`bench-results/external/cc2/` and `bench-results/external/cc2-fork/`; as with the
external clys records, external attack per piece is pooled generated attack before
cancellation, and the game-level Wilson intervals are descriptive (the independent
units are the seat-swapped seed pairs).

## 👤 Profiles

One bot ships in three profiles. The guideline side shares a single weight table and
a single search; the profiles differ in what the bot is allowed to see and which
rules profile scores its locks.

The **published profile** is the default build: a 20-row view of the board, the
current piece plus a 5-piece preview, beam width 48, guideline rules. This is the
build the live page runs and the one the Hoiko and clys results above were measured
with.

The **competition profile** widens the view to the full 40-row board, widens the
beam to 96, and enables exact 7-bag speculation (SPECULATE): after the known queue,
the search plays one additional ply over the exact remaining-bag distribution
instead of a single guessed piece. It is env-gated in the rig adapter
(`tools/cc2-rematch/attax-tbp.ts`: `ATTAX_ROWS=40`, `ATTAX_WIDTH=96`,
`ATTAX_SPECULATE=1`) and is off by default everywhere else. This build is
**attax v2** — the one that played both Cold Clear 2 matches — and it is the state
`main` now carries. Attax versions count improvement iterations from this base:
a future league iteration *j* produces v(2+*j*). The number is provenance, not a
result claim.

The **S2 profile** is a separate rules profile (`tetrio-s2` in `src/core/`, harness
in `tools/s2-lab/`) for the S2 ruleset used by 61bi's bot lab, with its own weight
group in the shared table (including a conversion-shaping term the guideline search
never reads). A league-format tuning campaign against the lab's champion is in
progress. No results are claimed for this profile yet, and no learned weights are
part of this build: the profile ships with the same hand-set defaults as the
guideline side.

## 🚀 Why it is strong

- **Exact move generation.** A breadth-first search over the engine's real inputs (shift,
  soft drop, SRS rotation with kicks) finds every reachable resting placement and flags
  T-spin entries. Nothing reachable is missed, and nothing unreachable is played.
- **Deep lookahead.** A width-48 beam search over the current piece plus 5 previews,
  with hold, garbage cancellation and discounted rewards.
- **Versus-tuned evaluation.** Dellacherie-style board terms plus versus terms (danger
  from incoming garbage, T-slot readiness), plus a direct attack reward, a back-to-back
  break penalty and a wasted-T penalty.
- **Attack efficiency against Hoiko.** Attack per piece is 0.70 vs Hoiko's 0.46
  (about 50% more). Against clys, Attax instead won on survival despite lower attack
  per piece.

## ⚖️ Fairness

- **Seat swaps.** Every seed in both matchups was played from both seats, so each AI plays
  each piece sequence. Against Hoiko the swapped games are identical (both AIs are
  deterministic and the engine is seat-symmetric), so they are counted once.
- **Identical harness for both sides.** Against Hoiko, both AIs run in the same headless
  engine (`src/core`) and tick loop as the live page.
- **Time usage.** Against Hoiko, each side locks one piece per 120 ms of game time
  regardless of think time.
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
suggestions. By default it sees the bottom 20 rows of the board and receives no
pending-garbage information; setting `ATTAX_TBP_ROWS=40` exposes the full 40-row
board, for referees that spawn pieces above row 20.

The host contract is simple. The adapter tracks the piece queue from `start` and
`new_piece` messages only, so a host must keep the queue non-empty when it asks
for a suggestion: send `new_piece` as pieces are consumed, or resync with a fresh
`start` (a resync is also required after garbage changes the board, since TBP
carries no pending-garbage information). If the queue does run dry, the adapter
answers with an empty suggestion and stays alive; no host message, malformed or
otherwise, can make it throw or exit. Normal operation resumes on the next
`start` or `new_piece`.

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

## 🏷️ Renaming

Change `src/brand.ts` (all on-page names), `index.html` (`<title>`, meta description) and
`package.json` `name`; rebuild. Internal module names (`bot`, `hoiko`) are neutral.
