<div align="center">

# ⚔️ Attax

**A versus AI for the falling-block game — the strongest in guideline versus, measured head-to-head.**

[![Play live](https://img.shields.io/badge/play-live%20arena-2ea44f)](https://s0u7a.f5.si/attax/)
[![vs Cold Clear 2](https://img.shields.io/badge/vs%20Cold%20Clear%202-81%E2%80%9319%20(81.0%25)-blue)](#result-cold-clear-2)
[![vs Hoiko](https://img.shields.io/badge/vs%20Hoiko-195%E2%80%935%20(97.5%25)-blue)](#-result-hoiko)
![TypeScript](https://img.shields.io/badge/TypeScript-bun%20%2B%20vite-3178c6)
![Rust](https://img.shields.io/badge/Rust-WASM-dea584)

**[▶ Play / watch live: s0u7a.f5.si/attax](https://s0u7a.f5.si/attax/)**

</div>

Attax is a beam-search versus bot (no neural network, no opening book). The deliverable is
a static web page that shows the measured head-to-head result and every benchmark game as a
clickable square. (The live browser arena is unavailable for now: the engine moved to a
native GPU search in 2026-11 and a browser front-end for it does not exist yet.)

Essentials in this repo: the bot is the GPU search in [`gpu/`](gpu/) (lab driver in
[`tools/s2-lab/`](tools/s2-lab/)), raw benchmark records
are in [`bench-results/`](bench-results/), the Hoiko-replica fidelity evidence is in
[`evidence/hoiko-fullgame/`](evidence/hoiko-fullgame/), and the results builder
is in [`scripts/`](scripts/).

> **The world's strongest in guideline versus.** Across every matchup measured so far,
> Attax has won each matchup it has played: the official Cold Clear 2 **81–19** (measured
> again on the current build, attax v3, at beam width 96; the earlier build, attax v2, at
> width 48 measured **79–21**), chouhy's fork **79–16–5** (current build, attax v3, at
> beam width 96, over 100 games, details below), Hoiko **195–5** and clys **88–12**
> (conditions and details below). **Attax v3** (current
> `main`) unifies the bot into a single search core for the guideline and TETR.IO S2
> rulesets, with the rules differences carried as profile data; guideline play is
> unchanged from v2, so the record above stands. In S2, the latest measurement is still
> a foothold, not a win: against **Sold Slear**, the reigning champion of 61bi's bot lab
> and a bot still under active development, Attax's S2 configuration won **38.0%**
> (228–372) over 600 games at beam width 96 in the lab — the baseline measurement of
> current `main` (`6655fd7`, Rust engine, config O, seeds 90001–90300; details below).
> The previously listed 43.1% came from a different measurement (pre-kick-fix build,
> TS core) and is not directly comparable. See
> [Caveats](#%EF%B8%8F-caveats--not-measured) for what has *not* been measured.

## 📑 Contents

- [Results at a glance](#-results-at-a-glance)
- [Result: Hoiko](#-result-hoiko)
- [Result: clys](#result-clys)
- [Result: Cold Clear 2](#result-cold-clear-2)
- [Result: Sold Slear (S2)](#result-sold-slear-s2)
- [Profiles](#-profiles)
- [TBP](#tbp)
- [License](#license)
- [Why it is strong](#-why-it-is-strong)
- [GPU engine](#-gpu-engine)
- [Fairness](#%EF%B8%8F-fairness)
- [Caveats / not measured](#%EF%B8%8F-caveats--not-measured)
- [The bot](#-the-bot-gpu)
- [Layout](#%EF%B8%8F-layout)
- [Develop](#%EF%B8%8F-develop)
- [Reproducing the benchmarks](#-reproducing-the-benchmarks)
- [Renaming](#%EF%B8%8F-renaming)

## 📊 Results at a glance

| Opponent | Games | W–L | Win rate (95% Wilson) | Attack/piece (Attax vs opp.) |
|---|---|---|---|---|
| **Hoiko** (Rust/WASM replica of Hoiko.exe) | 200 | **195–5** | **97.5%** (94.3–98.9%) | **0.70** vs 0.46 |
| **clys** (by citrus610) | 100 | **88–12** | **88.0%** (80.2%–93.0%) | **0.7346** vs 0.7791 |
| **Cold Clear 2** (official upstream, `ed8b193`, beam width 96) | 100 | **81–19** | **81.0%** (72.2–87.5%) | 0.8844 vs **0.8989** |
| **Cold Clear 2** (official upstream, `ed8b193`, earlier build at beam width 48) | 100 | **79–21** | **79.0%** (70.0–85.8%) | 0.8951 vs **0.9279** |
| **Cold Clear 2 fork** (chouhy, beam width 96) | 100 | **79–16–5** | **79.0%** (70.0–85.8%) | **0.9218** vs 0.8101 |
| **Sold Slear** (S2 champion, s2-bot-lab) | 600 | 228–372 | **38.0%** | 1.1390 vs 1.2549 |

All guideline matchups use held-out seeds (never used for tuning), and every seed was
played from both seats. The width-48 official Cold Clear 2 match was played by the
competition profile, **attax v2** (see [Profiles](#-profiles)), under an external TBP
rig; Attax won on survival despite the lower attack rate. The width-96 matches
(official and fork) were played by **attax v3** (current `main`) under the same
external TBP rig. The Sold Slear row is the S2 profile's width-96 baseline measurement
of current `main` (`6655fd7`), played by **attax v3** with the Rust engine and config O
under the lab protocol detailed below; the earlier width-48 baseline is kept in that
section.
The details, conditions and limits follow.

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
Attax won on survival, the same pattern as the clys match.

Against the same fork build at `b20a92b` (allspin defaults), **attax v3** at `c83d339`
with beam width explicitly 96 played seeds 33001–33050 from both seats (replay-verified
in full) and won **79–16–5** (79.0%, Wilson 95% CI 70.0–85.8%), ahead on attack per
piece 0.9218 to 0.8101 (unlike the official match); all 5 draws reached the 1000-turn
cap. On this TBP path the TS reference search (`ts-reference`) executed the decisions,
which are bit-identical to the Rust engine on the verified corpora. This is a new
measurement on a different build, width, and seed block — not a re-roll of the closed
19–13–8 gate and not a same-conditions A/B against the earlier width-48 fork measurement.

Against the same official build at `ed8b193`, **attax v3** at `de66bf5` (search
byte-identical to `c83d339`) with beam width explicitly 96 played seeds 34001–34050
from both seats (replay-verified in full) and won **81–19** (81.0%, Wilson 95% CI
72.2–87.5%), with no draws. The official build again produced more attack per piece,
0.8989 to Attax's 0.8844; Attax won on survival, clearing 7,226 lines to Cold Clear 2's
6,229. On this TBP path the TS reference search (`ts-reference`) executed the decisions,
which are bit-identical to the Rust engine on the verified corpora. This is a new
measurement on a different build, width, and seed block — not a re-roll and not a
same-conditions A/B against the 79–21 record.

Per-seed records and generated summaries live in `bench-results/external/cc2/`,
`bench-results/external/cc2-w96/`, and `bench-results/external/cc2-fork-w96/`; as with
the external clys records, external
attack per piece is pooled generated attack before cancellation, and the game-level
Wilson intervals are descriptive (the independent units are the seat-swapped seed pairs).

## Result: Sold Slear (S2)

Sold Slear is the champion of 61bi's s2-bot-lab, the lab for the TETR.IO S2 ruleset:
the latest S2 champion, and still under active development. It is the opponent the
S2 profile exists to chase, and the first S2 opponent Attax has measured against.

**Conditions.** The current record is the baseline measurement of current `main`,
taken on 2026-11-18 to pin where the S2 profile stands: played in the lab
(s2-bot-lab) over 600 games, seeds **90001–90300**, every seed played from both
seats, against the champion's pinned WASM build under the lab protocol. Attax
played the unified **v3** search in its S2 configuration — config O as-is — at
beam width **96**, on `main` at `6655fd7` with the Rust engine. All 600 games
finished and none were excluded: **228 wins, 372 losses**, no draws. Attax's
pooled attack per piece was 1.1390 to the champion's 1.2549.

One disclosure on the headline rate: in 42 of the 600 games the champion could
not return a move (a public compat error on the champion side); under the
protocol those games are counted as Attax wins, and they are included in the
38.0% above. Excluding them, the win rate is **33.3%** (186 of 558).

| Matchup | N | W–L–D | Win rate |
|---|---|---|---|
| Attax (S2 profile, width 96, current main `6655fd7`, Rust engine, config O) vs Sold Slear | 600 | 228–372–0 | **38.0%** |
| Attax (S2 profile, width 48, earlier baseline) vs Sold Slear | 400 | 64–318–18 | **16.75%** of decided games |

The width-48 row is the earlier baseline measurement (seeds 9401–9600, both seats;
fixed driver, Φ on, veto off, hand-set weights), recorded before the width study.
The previously listed width-96 figure (43.1% of decided games over 120 games) came
from a different measurement — the item-101 fleet block on the pre-kick-fix tree
(`1f41806`) with the TS core — and is not directly comparable with the baseline
above. Even at width 96 this is a foothold, not a win: the champion still takes
the matchup. The baseline above is the reference point for further S2 tuning; no
newer result is claimed yet.

## 👤 Profiles

One bot ships in three profiles. The guideline side shares a single weight table and
a single search; the profiles differ in what the bot is allowed to see and which
rules profile scores its locks.

The **published profile** is the default configuration: a 20-row view of the board, the
current piece plus a 5-piece preview, beam width 96, guideline rules. (The Hoiko and clys
results above were measured with the previous width-48 default.) The live page no longer
runs the bot itself — since 2026-11-19 the engine is the native GPU search and no browser
front-end for it exists yet; the page shows the measured records and their replays.

The **competition profile** widens the view to the full 40-row board, widens the
beam to 96, and enables exact 7-bag speculation (SPECULATE): after the known queue,
the search plays one additional ply over the exact remaining-bag distribution
instead of a single guessed piece. It was env-gated in the TBP rig adapter
(`ATTAX_ROWS=40`, `ATTAX_WIDTH=96`, `ATTAX_SPECULATE=1`) that drove the TS
reference search; that adapter was removed with the CPU search on 2026-11-19, and
the matches it played stand as records. This build is
**attax v2** — the one that played the width-48 official Cold Clear 2 match; **attax v3**
(below) played the width-96 matches under the same profile settings.

**Attax v3** is the state `main` now carries: the unified tree. The guideline and
S2 rulesets share one search core (developed as the unified TS core; since
2026-11-19 it runs as the GPU engine in `gpu/`, and the TS implementation was
removed from the repo), and the rules differences are
carried as profile data — board size, attack table, garbage semantics — rather
than as separate code paths. Guideline play is unchanged from v2, so every
guideline result above stands as measured; what v3 changes is the architecture,
and what it adds is a working S2 side. The number is provenance, not a result
claim.

The **S2 profile** is the S2 rules profile (`tetrio-s2` in `src/core/`, harness
in `tools/s2-lab/`) for the S2 ruleset used by 61bi's bot lab, with its own weight
group in the shared table (including a conversion-shaping term the guideline search
never reads). Its latest measured result is the width-96 Sold Slear baseline
above: **38.0%** (228–372) over 600 games in the lab (seeds 90001–90300, both
seats), played by the Rust engine on current `main` (`6655fd7`) with config O
as-is. That baseline is the reference point for further S2 tuning.

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

## ⚡ GPU engine

The search runs as a native Vulkan engine in [`gpu/`](gpu/) — the step-26 host and
shader set, driven from the S2 lab (`tools/s2-lab/`) in serve mode. It is the only
engine: the TS and Rust CPU searches were removed from the repo on 2026-11-19, and
there is **no fallback** — the lab driver probes for a usable Vulkan device at
startup and stops if there is none, rather than silently degrading to a path tens
of times slower. The engine implements exactly config O (width 96, the evaluation
tables vendored in `tools/s2-lab/` and `gpu/tables.bin`).

The move generator — the breadth-first search over the engine's own inputs — runs
as a Vulkan compute kernel, measured on an AMD RX 6400:

- **1,205,713 BFS/s**, 23.6× the previous GPU implementation (51,115 BFS/s).
- **Equivalence, not approximation.** The kernel's output was cross-checked in full
  against the CPU reference implementation (the Rust search, since removed from
  this repo and kept in the lab PC archive): 38,611 positions, 851,287 placements
  and 5,355,062 discoverer-key pairs — **0 mismatches**. The GPU returns exactly
  what the CPU search returned.
- At the measured 2,299 movegen calls per decision, the kernel alone converts to
  ≈ **524 decisions/s (T1)**. This is a conversion from the movegen stage, **not** a
  measured end-to-end engine rate.

In the TBP arena Attax already holds the strongest measured record — official Cold
Clear 2 **81–19** and intetrigence **50–1**, both at beam width 96 under the
fair-conditions rigs described above (played by the TS reference search, removed
with the CPU path in 2026-11-19; see [TBP](#tbp)).

## ⚖️ Fairness

- **Seat swaps.** Every seed in both matchups was played from both seats, so each AI plays
  each piece sequence. Against Hoiko the swapped games are identical (both AIs are
  deterministic and the engine is seat-symmetric), so they are counted once.
- **Identical harness for both sides.** Against Hoiko, both AIs run in the same headless
  engine (`src/core`) and tick loop as the live page.
- **Time usage.** Against Hoiko, each side locks one piece per 120 ms of game time
  regardless of think time.
- **Rules audited.** The rules audit (run by the since-removed `scripts/audit-rules.ts`
  against the benchmark harness) checked that the engine awards Hoiko exactly
  the clear Hoiko's own search predicted for each move. Before the overhaul it did not:
  the T-spin front-corner table (commit `dcbe108`) had rotations 0 and 2 swapped, so every
  T-spin double Hoiko made (51 of 51 in the audit) was scored as a mini (attack 1
  instead of 4). Fixed in `src/core/tspin.ts`; all numbers here are after the fix.
- **Every placement is legal.** The removed TS implementation executed with
  `placeMinoAt`, and its movegen test drove the real engine to prove each placement
  (and each claimed T-spin) reachable with ordinary inputs, with none missed; the
  GPU engine's movegen is held to the full-corpus equivalence check described
  under [GPU engine](#-gpu-engine).
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
- **The 195–5 headline stands** until a fresh full benchmark supports a new one.
  A 100% result on a finite sample is a measurement, not a guarantee against every
  possible seed or opponent.

## 🤖 The bot (`gpu/`)

The bot is the Vulkan GPU search in [`gpu/`](gpu/): a single-file C host
(`gpu/host/vkrunner_s26.c`) plus the pinned shader set in `gpu/shaders/`, run in
serve mode and driven by the lab driver in [`tools/s2-lab/`](tools/s2-lab/).
It implements the unified search semantics — movegen, features, weights, beam
search (width 96) over the current piece plus the 5-piece preview, with hold —
with the evaluation tables vendored in `tools/s2-lab/` and `gpu/tables.bin`.
There is no CPU implementation of the search in this repo and no fallback: with
no usable Vulkan device the driver stops at startup.

The measured records above were produced by the unified TS core (`src/ai/bot/`),
removed from the repo on 2026-11-19 when the engine went GPU-only; the GPU
engine is gated bit-identical to that lineage on the verified corpora. The
removed implementation, kept here as the semantics record:

- `movegen.ts` — breadth-first search over the engine's own inputs (shift, soft drop,
  rotate with first-fit SRS kicks) from the current position; returns every distinct
  resting placement and whether it can be entered by a rotation (T-spins classified with
  the engine's own function).
- `features.ts` — eleven named board terms: height, danger (height + incoming garbage
  above row 10, squared), holes, blocks over holes, rows with holes, bumpiness (plain and
  squared), row transitions, well depth, extra wells, T-slot readiness.
- `weights.ts` — the whole policy in one table: board weights, attack reward, per-clear
  shaping, back-to-back break penalty, wasted-T penalty.
- `search.ts` — beam search (width 96 by default) over the current piece plus the 5-piece preview,
  with hold. A line's value is its discounted rewards plus the board score at its end;
  the first move of the best line is played. Incoming garbage cancels against attack and
  the remainder lands under the stack, as in the engine.
- `fighter.ts` — snapshot in, one `placeAt` move out.

## TBP

Attax previously ran as a Tetris Bot Protocol (TBP) process for external match
hosts, through an adapter (`tbp/attax-tbp.ts`) over the TS search. The adapter
was removed on 2026-11-19 (Phase C) when the engine went GPU-only, and there is
currently no TBP front-end for the GPU engine. The TBP matches it played —
including the Cold Clear 2 records above, played by the TS reference search on
this path — stand as measured records.

The [intetrigence match report](tbp/intetrigence-match.md) and the
[recorded smoke result](tbp/SMOKE.md) remain as the record of that setup: the
external-arena command, rules, timing, verification, and the host contract the
adapter implemented (queue tracking from `start`/`new_piece`, the 20-row
default view, `ATTAX_TBP_ROWS=40` for the full board).

## License

AGPL-3.0. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) for the Hoiko benchmark
carve-out.

## 🗂️ Layout

```
src/core      rules engine (pure)          src/sim      live arena (same tick loop as bench)
src/versus    2-player controller          src/ui       DOM + canvas; arena runs in a Worker
gpu/          the bot (Vulkan search)      scripts      build-results
src/ai/hoiko  Hoiko adapter + wasm         rust/        Hoiko replica source (wasm)
src/bench     match records + summary      tools/       Hoiko oracle; S2 lab (GPU driver)
```

## 🛠️ Develop

`bun run dev` · `bun test` · `bun run lint` · `bun run build` (outputs `dist/` with relative
asset paths; it works from any subpath, e.g. `/tetris/`). Rust: `bun run test:rust`.

## 🔁 Reproducing the benchmarks

### vs Hoiko

The Hoiko headline was produced by the in-repo benchmark harness
(`scripts/benchmark.ts`, with the rules audit in `scripts/audit-rules.ts`),
which was removed with the CPU search on 2026-11-19; it cannot be re-run from
this tree. The raw records in [`bench-results/`](bench-results/) are the
reproduction artifact. What still runs from this repo is the page pipeline:

```sh
bun install
bun scripts/build-results.ts      # -> src/data/results.json (what the page shows)
bun run build                     # -> dist/
```

### Current matches (S2 lab)

Current matches run through the GPU lab driver, which requires a machine with
a usable Vulkan device and stops at startup without one (no fallback):

```sh
bun tools/s2-lab/run-match.mjs --games 1 --seed 42 --out /tmp/attax-s2.jsonl
```

See [`tools/s2-lab/README.md`](tools/s2-lab/README.md) for the lab's own
requirements (the external lab checkout and the champion artifact).

## 🏷️ Renaming

Change `src/brand.ts` (all on-page names), `index.html` (`<title>`, meta description) and
`package.json` `name`; rebuild. Internal module names (`bot`, `hoiko`) are neutral.
