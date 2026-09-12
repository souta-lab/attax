# Beat-Hoiko playbook (research notes)

Goal: a fighter that beats the faithful Hoiko (PPT-style) port. Source review of the
strongest open-source Tetris bots, with the specific levers ranked by expected win-rate
gain. Hoiko is a deep beam search (~1.3M nodes/s, depth 14, beam 150, OffsetAI garbage
management). To beat it, the practical route is *hybrid*: keep a deep search, add
SRS-kick placement generation, opponent-aware attack timing, and garbage defense.

## Ranked levers

1. **Full reachable placements incl. SRS kicks / tucks.** v1 DeepSeek only hard-drops at
   rest positions and never uses kicks, so it cannot build or execute T-spins or tuck
   into overhangs. Reuse `src/core/srs.ts` + the kick BFS (`reachableLandings`,
   `enumerateKickPlacements` in `src/ai/search.ts`) and T-spin detection
   (`src/core/tspin.ts`). Biggest single gap.
2. **Garbage-aware evaluation + incoming defense.** Cold Clear's eval includes
   `combo_garbage` and a `pick_move` rule that forbids stacking past row 20 in the middle
   columns when incoming garbage is high. Concretely model `incoming + stack_height`.
3. **Opponent model driving attack timing.** `nana` models the opponent as
   CLEAN/COMBO/SPIN/MESSY layers, computes `can_attack()` per layer, and attacks when
   `garbage_height + stack_height > 15` or the opponent cannot cancel. Attack when the
   opponent is vulnerable; downstack when your own board is messy.
4. **Search shape.** Cold Clear uses an MCTS-inspired best-first DAG with probabilistic
   rank-weighted leaf selection `P(i) ∝ ((E_i − min E)² + 10) / ((i−1)² + 1)`, plus
   transposition merging and speculation over unknown bag pieces. `nana` uses MCTS+UCT
   (C = 1.507) with TDS. RIKU0804 shows a simple beam (width 24–32, depth 5–8) is already
   competitive; versus-tuned weights matter more than raw depth.
5. **Opening book.** PCO (84.6% PC with I hold), DT Cannon (most versatile, counters
   4-wide), TKI 3 (counters 4-wide), Albatross (99.99% PC after TSD but garbage-sensitive
   in PPT). Cold Clear ships a generator; a small static book is enough to start.
6. **Versus self-play weight tuning.** RIKU0804 reports versus-trained weights beat
   solo-tuned ~11-0. Tune on the versus gate, not solo survival.
7. **NN only if the above plateau.** RIKU0804 found a nonlinear MLP residual roughly
   *even* with a linear eval — the bottleneck is search + features, not linearity. No GPU
   is available, so distillation from the search bot is the only viable small-NN path.

## Reference implementations

- Cold Clear — https://github.com/MinusKelvin/cold-clear (Rust; best weights + eval).
  Default eval includes `b2b_clear`, `tslot[lines]`, `combo_garbage`, `max_well_depth`,
  `jeopardy`, `top_half/top_quarter`, and a T-slot pattern matcher.
- cold-clear-2 — https://github.com/MinusKelvin/cold-clear-2 (transposition-aware,
  MCTS-inspired; weights in `src/default.json`).
- MisaMino — https://github.com/misakamm/MisaMino (exhaustive reachable enumeration +
  recursive max; rewards *concentrated burst* attack `att*(att/clear − 0.7)`).
- nana — https://github.com/nightcrab/nana (MCTS+UCT+TDS for versus; full opponent model
  and garbage-blocking emulation — the best single versus reference).
- RIKU0804/tetris-ai — https://github.com/RIKU0804/tetris-ai (modern Rust beam; versus-
  tuned weights; beam width/depth results).
- Zetris — https://github.com/ZetrisAI/Zetris (PPT/TETR.IO wrapper feeding incoming
  garbage into MisaMino).

## Attack / cancel model (PPT)

Single 0, Double 1, Triple 2, Tetris 4, b2b +1, T-spin 1/2/3 = 2/4/6, Perfect Clear 10,
combo table `[0,0,1,1,2,2,3,3,4,4,4]`. Garbage cancel: outgoing attack cancels pending
garbage first, leftover is sent; leftover incoming is buried after a short delay
(engine option `garbageDelay`) with hole-aligned rows (`garbageAligned`, PPT-style).
PPT garbage changes hole column within an attack ~30% of the time.

## Current gate

`bun scripts/gate-v2.ts` — 32 fixed seeds, DeepSeek v2 (left) vs Rust Hoiko (right),
`TICK_MS=16`, `MAX_TICKS=12000`, JSONL `HOIKO-match` / `HOIKO-summary` (env `HOIKO_BEAM`,
`DSV2_RUST`, `DSV2_DEPTH`, `DSV2_BOOK`). This is the scoreboard; a change is only "an
improvement" if it raises the win count here. `bun scripts/hoiko-gate.ts` is the older
DeepSeek-v1 harness.

**Fair step model (issue #24).** The controller charges one `stepIntervalMs` per
**terminal** action (piece lock or hold); intermediate plan steps (rotate/move) are free.
Before this fix, DeepSeek's single `placeAt` locked in 1 interval while Hoiko's
`|Δx|+1`-step plan locked 3–7× slower, so the old win counts were an APM artifact. See
`evidence/fair-harness/README.md`.

## Results

> **Warning — the pre-#24 rows below are harness artifacts.** They were measured before
> the fair step model was fixed (issue #24): Hoiko locked 3–7× slower than DeepSeek, so
> the win counts reflect an APM handicap, not decision quality. The fair numbers are in
> "Fair-harness re-baseline (#24)" below.

### Pre-fix (unfair step model, historical)

| Fighter | Gate | Result |
|---|---|---|
| DeepSeek v1 | 32 seeds, Hoiko `we` beam500 | **23-9-0/0**, 1534 vs 1261 lines |
| DeepSeek v2 | 32 seeds, Hoiko `we` beam500 | **32-0-0/0**, 0 execution mismatches, 1075 vs 254 lines |
| DeepSeek v2 | presets `wo`/`wd` (6 seeds) | 6-0, 6-0 |
| DeepSeek v2 | presets `wr`/`ultra2`/`sprint` (4 seeds) | 4-0, 4-0, 4-0 |

Held-out robustness: v2 beat Hoiko **16-0** (541 vs 128 lines, 0 mismatches) on 16
seeds that are **not** in the tuning/gate corpus, and **64-0** (2302 vs 548 lines,
0 mismatches) on a further 64 unseen seeds — **80-0 on fresh seeds total**,
confirming the result is not overfit to the 32 fixed seeds. (All pre-#24/unfair; not yet
re-measured under the fair step model — treat these as an upper bound.)

Beam robustness: v2 beat Hoiko at **beam 1500** (3x the default) **12-0** (422 vs 101
lines). The gate accepts `HOIKO_BEAM` to sweep this.

DeepSeek v2 is wired as the app's versus fighter (`src/main.ts`). Reproduce the main
result with `bun scripts/gate-v2.ts`.

DeepSeek v2 is also ported to Rust (`rust/deepseek-rust`, `src/v2.rs` + `v2_score.rs` +
`kick.rs` + `tspin.rs`) with a differential parity test against the TS v2 and a bench
(`examples/bench_deepseek_v2.rs`). It is compiled to wasm (`rust/deepseek-wasm` ->
`src/ai/wasm/deepseek_v2.wasm`) and the app/gate run it (`src/main.ts`, `DSV2_RUST=1`).
It makes the same decisions as the TS v2 at **2.4x** the speed (24.6 vs 58.6 ms/move),
so future deeper/broader search is affordable.

## Fair-harness re-baseline (#24)

`src/versus/controller.ts` now charges one `stepIntervalMs` per terminal action (piece
lock or hold); intermediate plan steps are free. Every fighter therefore locks exactly one
piece per interval, removing the APM handicap that inflated the pre-fix numbers.
Regression test: `tests/versus-controller.test.ts` ("cosmetic execution steps do not delay
locks relative to a bare placeAt"). Raw records: `evidence/fair-harness/`.

| Fighter | Gate | Result | Hoiko lines / locks | Mismatches |
|---|---|---|---|---|
| DeepSeek v2 | TS, 32 seeds, `we` beam500 | **21-11-0/0** | 1073 / 2421 | 0 |
| DeepSeek v2 | Rust wasm, 32 seeds, `we` beam1500 | **21-11-0/0** | 1092 / 2417 | 0 |
| (pre-fix) DeepSeek v2 | TS, 32 seeds, `we` beam500 | 32-0-0/0 | 254 / 730 | 0 |

Beam 1500 is the shipping binary's adaptive ceiling, so the fair result is robust to beam
width. Hoiko's engine decisions are unchanged; only the harness step accounting was fixed.
**Caveat:** the binary's in-match adaptive beam (`SetNextOption`) and its ~107 ms
wall-clock search budget are not modeled by the wasm oracle and remain unverified (see
`evidence/scan/findings.md` F1/F6 and `tools/hoiko-oracle/diff/REPORT.md` §6).

## Faithful in-match config: beam 150 + `SetNextOption` adaptation

The gate/app used to override Hoiko to a fixed beam and disable adaptation. They now run
the shipping binary's **in-match** config via a single source of truth,
`src/ai/hoiko-faithful.ts` (`FAITHFUL_HOIKO`), used by the app and every harness:

| Field | Value | Provenance |
|---|---|---|
| `weightPreset` | `we` | `config.txt` `playStyle 0` |
| `maxBeamSize` | 50 | `config.txt` `beamSize 50` (was defaulted to 500) |
| `beamSizeLimit` | 150 | `min(1500, threads*50*3)` initial cap |
| `adapt` | true | binary `SetNextOption` time-budget beam adaptation |
| `depthLimit` / `viewNext` | 14 / 2 | `config.txt` |

`HOIKO_BEAM` (default 150) and `HOIKO_ADAPT=0` are the only overrides (stress/ablation and
deterministic runs). Raw records: `evidence/hoiko-faithful/`.

| Fighter | Hoiko config | Result | Hoiko lines / locks | Hoiko ms/decision |
|---|---|---|---|---|
| DeepSeek v2 | **faithful** (beam 150 + adapt) | **25-7-0/0** | 1182 / 2576 | 239.7 |
| DeepSeek v2 | beam 150, adapt off | 22-10-0/0 | 943 / 2158 | 33.9 |
| DeepSeek v2 | beam 1500, adapt off | 21-11-0/0 | 1092 / 2417 | 383.5 |

DeepSeek v2 wins under every configuration, including the faithful one. **Caveat:**
`SetNextOption` is driven by real elapsed search time, so the adaptive trajectory is
wall-clock/machine dependent (on this machine it reproduced: two 4-seed probes and a full
re-run agreed). The wasm engine also cannot model the binary's ~107 ms early-abort, so the
adaptive path is not oracle-verified (`tools/hoiko-oracle/diff/REPORT.md` §6).

## Strength vs search budget (fresh seeds)

`bun scripts/strength-sweep.ts` runs v2 (Rust wasm) against Rust Hoiko over a fixed
fresh seed set (`301,307,311,313,317,331,337,347,349,353,359,367`), sweeping v2
depth/width against Hoiko beam. Every configuration won **12-0**, so the tiebreak is
the margin (F = for, A = against). Full record in `evidence/strength/sweep.jsonl`.

| v2 depth | width | Hoiko beam | W-L-D/cap | lines F-A | sent F-A | v2 ms/mv | Hoiko ms/mv |
|---|---|---|---|---|---|---|---|
| 7 (default) | 24 | 500 | 12-0-0/0 | 406-92 | 231-46 | 34.4 | 170.8 |
| 7 (default) | 24 | 3000 | 12-0-0/0 | 457-119 | 270-57 | 36.3 | 1116.7 |
| 10 | 24 | 500 | 12-0-0/0 | 423-97 | 242-38 | 50.8 | 171.1 |
| 10 | 24 | 3000 | 12-0-0/0 | 327-62 | 204-29 | 51.9 | 1080.4 |
| 10 | 32 | 3000 | 12-0-0/0 | 439-114 | 266-53 | 65.4 | 1123.7 |
| 13 | 24 | 3000 | 12-0-0/0 | 404-93 | 237-43 | 61.0 | 1042.6 |

ms/move figures come from the 6-way parallel sweep and are contention-inflated; a
solo depth-7 run measures **27.0 ms/decision**. Deeper search does **not** help
against the strongest Hoiko: at beam 3000 the depth-7 default has the best line
margin (+338) and is tied-best on attacks sent (+213), while depth 10/13 are both
slower and worse. No default change was adopted; depth 7 / width 24 stays.
