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

`bun scripts/hoiko-gate.ts` — 32 fixed seeds, DeepSeek (left) vs Rust Hoiko (right),
`TICK_MS=16`, `MAX_TICKS=12000`, JSONL `HOIKO-match` / `HOIKO-summary`. This is the
scoreboard; a change is only "an improvement" if it raises the win count here.

## Results (verified)

| Fighter | Gate | Result |
|---|---|---|
| DeepSeek v1 | 32 seeds, Hoiko `we` beam500 | **23-9-0/0**, 1534 vs 1261 lines |
| DeepSeek v2 | 32 seeds, Hoiko `we` beam500 | **32-0-0/0**, 0 execution mismatches, 1075 vs 254 lines |
| DeepSeek v2 | presets `wo`/`wd` (6 seeds) | 6-0, 6-0 |
| DeepSeek v2 | presets `wr`/`ultra2`/`sprint` (4 seeds) | 4-0, 4-0, 4-0 |

Held-out robustness: v2 beat Hoiko **16-0** (541 vs 128 lines, 0 mismatches) on 16
seeds that are **not** in the tuning/gate corpus, confirming the result is not
overfit to the 32 fixed seeds.

Beam robustness: v2 beat Hoiko at **beam 1500** (3x the default) **12-0** (422 vs 101
lines). The gate accepts `HOIKO_BEAM` to sweep this.

DeepSeek v2 is wired as the app's versus fighter (`src/main.ts`). Reproduce the main
result with `bun scripts/gate-v2.ts`.
