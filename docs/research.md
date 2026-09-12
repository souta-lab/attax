# Research: beating a strong PPT-style bot (sources & playbook)

Full report from the external-bot research pass. Companion to `docs/BEAT_HOIKO.md`
(the short, project-specific playbook + measured results).

I cloned and read the actual source of the strongest relevant bots (`cold-clear`,
`cold-clear-2`, `MisaMino`, `nana`, plus `RIKU0804/tetris-ai` and `Zetris`). Every
parameter below is pulled from code, with permalinks to the exact commit inspected.
Ranked by expected win-rate gain per unit of engineering effort for `rust/deepseek-rust`.

---

## Ranked action plan (highest expected gain first)

| # | Technique | Why it beats a depth-14 beam bot | Effort |
|---|-----------|----------------------------------|--------|
| 1 | **Full reachable-placement generation incl. SRS kicks/tucks** | DeepSeek originally had *no kicks*. Plain beam bots miss spin slots and tucks, so they cannot build T-spin setups or dig efficiently. Biggest single gap. | Med |
| 2 | **Garbage-aware evaluation + incoming-garbage defense clause** | Cold Clear's eval includes `combo_garbage` and an explicit "don't stack past row 20 with incoming garbage" pick rule. | Low |
| 3 | **Opponent model (Markov stack-layer model) driving attack timing** | `nana` models the opponent as CLEAN/COMBO/SPIN/MESSY layers and attacks when they can't cancel. Converts equal stacking into a win-rate edge. | Med |
| 4 | **Replace plain beam with MCTS/best-first DAG + transposition merging** | Cold Clear wins with ~30 features + probabilistic leaf selection, not brute depth. | High |
| 5 | **Opening book (PCO / DT Cannon / TKI / Gamushiro) as a hard override** | Free early damage spike + PC loops; Cold Clear ships an `opening-book` generator. | Low |
| 6 | **Versus-self-play weight tuning (GA), not solo tuning** | RIKU proved this: versus-trained weights beat solo-tuned ~11–0. | Med |
| 7 | Small NN only if 1–6 plateau | RIKU found MLP ≈ linear; `nana` uses a tiny CNN. Compute cost flagged below. | High |

---

## 1. State-of-the-art classical bots and their architectures

### Cold Clear (knowing / MinusKelvin) — the reference versus bot
Repo: https://github.com/MinusKelvin/cold-clear (Rust). Commit `279edd7c3177ff8077f6a930193397814b281f27`.

- **Search = MCTS-inspired best-first on a DAG** (not beam). Repeatedly picks an unexpanded leaf, expands all placements, backpropagates `max(R_i + E_i)` ([`bot/src/dag.rs`](https://github.com/MinusKelvin/cold-clear/blob/279edd7c3177ff8077f6a930193397814b281f27/bot/src/dag.rs) `find_and_mark_leaf` L218, `backpropogate` L415).
- **Node selection is probabilistic, rank-weighted**: `P(i) ∝ ((E_i − min_j E_j)² + 10) / ((i−1)² + 1)` ([`Value::weight`](https://github.com/MinusKelvin/cold-clear/blob/279edd7c3177ff8077f6a930193397814b281f27/bot/src/evaluation/standard.rs#L743-L746)). Good-ranked moves are sampled more; the `(i-1)²+1` denominator keeps #2/#3 moves alive.
- **Speculation over unknown next pieces**: branch over all bag pieces equally, resolve when revealed ([`modes/normal.rs` L200–243](https://github.com/MinusKelvin/cold-clear/blob/279edd7c3177ff8077f6a930193397814b281f27/bot/src/modes/normal.rs#L200-L243)).
- **Evaluation = 30+ hand features, GA-tuned** ([`standard.rs` L49–90](https://github.com/MinusKelvin/cold-clear/blob/279edd7c3177ff8077f6a930193397814b281f27/bot/src/evaluation/standard.rs#L49-L90)). Default weights:

```
back_to_back 52, bumpiness -24, bumpiness_sq -7, row_transitions -5,
height -39, top_half -150, top_quarter -511, jeopardy -11,
cavity_cells -173, cavity_cells_sq -3, overhang_cells -34, overhang_cells_sq -1,
covered_cells -17, covered_cells_sq -1, tslot [8,148,192,407],
well_depth 57, max_well_depth 17, well_column [20,23,20,50,59,21,59,10,-10,24],
b2b_clear 104, clear1 -143, clear2 -100, clear3 -58, clear4 390,
tspin1 121, tspin2 410, tspin3 602, mini_tspin1 -158, mini_tspin2 -93,
perfect_clear 999, combo_garbage 150, move_time -3, wasted_t -152
```
  Fast variant at L94–132. The **T-slot pattern matcher** ([`sky_tslot_left/right`, `tst_twist`, `cave_tslot`, `fin_left/right`](https://github.com/MinusKelvin/cold-clear/blob/279edd7c3177ff8077f6a930193397814b281f27/bot/src/evaluation/standard.rs#L448-L577)) looks for future T-spin cavities and adds `tslot[lines]` (Japanese walkthrough: https://komorinfo.com/blog/cold-clear-search-algorithm/).
- **Attack model in eval**: `garbage_sent` per clear ([`lock_data.rs` L35–44](https://github.com/MinusKelvin/cold-clear/blob/279edd7c3177ff8077f6a930193397814b281f27/libtetris/src/lock_data.rs#L35-L44)): `Clear2=1, Clear3=2, Clear4=4, Tspin1=2, Tspin2=4, Tspin3=6`; B2B +1; `COMBO_GARBAGE = [0,0,1,1,2,2,3,3,4,4,4]` ([L123–128](https://github.com/MinusKelvin/cold-clear/blob/279edd7c3177ff8077f6a930193397814b281f27/libtetris/src/lock_data.rs#L123-L128)); PC = 10.
- **Opening-book override** when columns ≤10, plus a PC-loop mode ([`modes/mod.rs can_pc_loop`](https://github.com/MinusKelvin/cold-clear/blob/279edd7c3177ff8077f6a930193397814b281f27/bot/src/modes/mod.rs#L229-L241)). Openers shipped: `honey-cup`, `gamushiro`, `mko`, `okey-cannon`, `new-dt-cannon-loop`, `mountainous-stacking-2`, `sakanas-first`, `pc-spin-okey`, `low-priority-c-spin`.
- **Options** ([`bot/src/lib.rs` L72–85](https://github.com/MinusKelvin/cold-clear/blob/279edd7c3177ff8077f6a930193397814b281f27/bot/src/lib.rs#L72-L85)): `speculate=true`, `min_nodes=0`, `max_nodes=4e9`, configurable `threads` (any-time).
- **Weights GA-optimized by versus self-play** ([`optimizer/src/main.rs` L100–133](https://github.com/MinusKelvin/cold-clear/blob/279edd7c3177ff8077f6a930193397814b281f27/optimizer/src/main.rs#L100-L133): top-5 survive, rest crossover).

### Cold Clear 2
Repo: https://github.com/MinusKelvin/cold-clear-2 (commit `ed8b19327b6bd1410ddd873d8611485bd45d8fae`).
- **Column-major bitboards, multithreaded, transposition-aware game tree, MCTS-inspired expansion** (README).
- Weights in [`src/default.json`](https://github.com/MinusKelvin/cold-clear-2/blob/ed8b19327b6bd1410ddd873d8611485bd45d8fae/src/default.json): `holes -1.5, cell_coveredness -0.2, row_transitions -0.2, height -0.4, height_upper_half -1.5, height_upper_quarter -5.0, tetris_well_depth 0.3, tslot [0.1,1.5,2.0,4.0], normal_clears [0,-2,-1.5,-1,3.5], spin_clears [0,1,4,6], back_to_back_clear 1.0, combo_attack 1.5, perfect_clear 15.0`; `freestyle_exploitation = ln(2) ≈ 0.693`. Eval: [`src/bot/freestyle.rs` L100–251](https://github.com/MinusKelvin/cold-clear-2/blob/ed8b19327b6bd1410ddd873d8611485bd45d8fae/src/bot/freestyle.rs#L100-L251).

### MisaMino (misakamm) — the original open-source stacker AI
Repo: https://github.com/misakamm/MisaMino (commit `3c6ebb03c62dd7e48099d0d1dc33bafcb718f62b`); wiki: https://tetris.wiki/MisaMino.
- **Exhaustive reachable-placement enumeration + recursive max** ([`dllai/ai.cpp AISearch` L104–167](https://github.com/misakamm/MisaMino/blob/3c6ebb03c62dd7e48099d0d1dc33bafcb718f62b/dllai/ai.cpp#L104-L167)); `GenMoving` dedupes via a 64×4×W hash.
- **Open-source DLL caps at `AI_MAX_DEPTH = 2`** ([`dllai/ai.h` L6](https://github.com/misakamm/MisaMino/blob/3c6ebb03c62dd7e48099d0d1dc33bafcb718f62b/dllai/ai.h#L6)); the standalone "level 6" is the full-game build.
- **Tiny linear eval** ([`ai.cpp Evaluate` L4–96](https://github.com/misakamm/MisaMino/blob/3c6ebb03c62dd7e48099d0d1dc33bafcb718f62b/dllai/ai.cpp#L4-L96)):
```
depth 0: {hole -50, h_change -5, y_factor -10, h_variance -10, att 40, noattclear -30}
depth 1: {hole -50, h_change -5, y_factor -10, h_variance -10, att 30, noattclear -35}
depth 2+: {hole -50, h_change -5, y_factor -10, h_variance -10, att 20, noattclear -35}
```
  Attack term `att * ai_factor.att * (att/clear − 0.7)` rewards *concentrated burst damage*.
- **Attack table** [`dllai/gamefield.h getAttack` L247–292](https://github.com/misakamm/MisaMino/blob/3c6ebb03c62dd7e48099d0d1dc33bafcb718f62b/dllai/gamefield.h#L247-L292): doubles/triples `n-1`, Tetris 4 (+1 B2B), T-spins `clearfull+1` (mini −1), PC +6.
- Config [`tetris_ai/bin/misamino.ini`](https://github.com/misakamm/MisaMino/blob/3c6ebb03c62dd7e48099d0d1dc33bafcb718f62b/tetris_ai/bin/misamino.ini): `level=4`, `GarbageCancel=1`, `GarbageBuffer=1`, `GarbageBlocking=1`, `samesequence=1`.

### nana (nightcrab) — the most relevant *versus* search engine
Repo: https://github.com/nightcrab/nana (C++, commit `a74a0c8cdb255d28ecc6c09b3fa68246004e7aaa`).
- **MCTS + Transposition-Driven Scheduling (TDS)** with a "Work Withholding" load-balancer; targets two-player stacking games with hidden info and any-time planning.
- **UCT `C = 1.507`** ([`cpp/Tetris/bot/UCT.cpp` L114–145](https://github.com/nightcrab/nana/blob/a74a0c8cdb255d28ecc6c09b3fa68246004e7aaa/cpp/Tetris/bot/UCT.cpp#L114-L145)); PUCT variant at L146+. Has a `search_style == CC` mode mimicking Cold Clear.
- Ships a **small bitboard CNN** ([`cpp/Tetris/nn/NN.hpp`](https://github.com/nightcrab/nana/blob/a74a0c8cdb255d28ecc6c09b3fa68246004e7aaa/cpp/Tetris/nn/NN.hpp)); classical eval in `bot/Eval.cpp` (`height -46`, `well_columns [31,16,-41,...]`, `clears [0,-1700,-100,-50,490]`, `tspins [0,126,434,220]`, `perfect_clear 200`).
- **Best single reference for opponent modeling + deep versus search in one codebase.**

### RIKU0804/tetris-ai — a modern Rust beam bot
Repo: https://github.com/RIKU0804/tetris-ai (commit `d3f92d289a24e09ec72679d8ce653bfd8a98679e`).
- **Beam search** ([`core-rs/src/main.rs` L319–378](https://github.com/RIKU0804/tetris-ai/blob/d3f92d289a24e09ec72679d8ce653bfd8a98679e/core-rs/src/main.rs#L319-L378)). Defaults `width=32, depth=5`; width 24/depth 6 → APP 0.90; versus champion depth 6–8 beats shallow weights ~11–0.
- **20-feature linear eval** ([`core-rs/src/eval.rs`](https://github.com/RIKU0804/tetris-ai/blob/d3f92d289a24e09ec72679d8ce653bfd8a98679e/core-rs/src/eval.rs)); weights in [`weights/champion-vs.json`](https://github.com/RIKU0804/tetris-ai/blob/d3f92d289a24e09ec72679d8ce653bfd8a98679e/weights/champion-vs.json).
- **Findings**: Rust port ~25× "broke the plateau"; **versus-trained beats solo-tuned**; MLP residual ≈ linear → "bottleneck isn't eval linearity."

### Others
- **Zetris** (mat1jaczyyy): MisaMino-based PPT + TETR.IO wrapper feeding `garbage_left` ([`Zetris.PPT/PPTBot.cs` L171–180](https://github.com/ZetrisAI/Zetris/blob/f2cfbe17a2c778f8d01e86e06f1fbe2dc8a9df82/Zetris.PPT/PPTBot.cs#L171-L180)).
- **knewjade**: `solution-finder`, `sfinder-cpp`, `bitris`, and a 289-line NN PC solver gist.
- **BetaTetris**: NN + 3.5B-board tablebase (NES; search/tablebase beats NN data point).
- Historical: `ahelwer/BattleTetrisAI` (BFS + 19-criteria linear, Harmony Search), `amjltc295/TetrisBattleAI`.

---

## 2. Versus / garbage mechanics

- **Attack + combo (PPT)**: Single 0, Double 1, Triple 2, Tetris 4, b2b +1, T-spin 1/2/3 = 2/4/6, PC 10, combo 1→4 by chain. Cold Clear hard-codes it in [`lock_data.rs`](https://github.com/MinusKelvin/cold-clear/blob/279edd7c3177ff8077f6a930193397814b281f27/libtetris/src/lock_data.rs#L35-L44).
- **Cancel/delay differs per game**:
  - Cold Clear ([`battle/src/game.rs deal_garbage` L404–431](https://github.com/MinusKelvin/cold-clear/blob/279edd7c3177ff8077f6a930193397814b281f27/battle/src/game.rs#L404-L431)): attack cancels queue first; leftover sent; leftover incoming buried in blocks with `garbage_messiness`.
  - nana ([`EmulationGame.cpp` L80–125](https://github.com/nightcrab/nana/blob/a74a0c8cdb255d28ecc6c09b3fa68246004e7aaa/cpp/Tetris/game/EmulationGame.cpp#L80-L125)): cancel from the back of the meter; insert in 8-line blocks.
  - RIKU ([`vs.rs` L14–85](https://github.com/RIKU0804/tetris-ai/blob/d3f92d289a24e09ec72679d8ce653bfd8a98679e/core-rs/src/vs.rs#L14-L85)): one-turn delay; `MAX_GARBAGE_PER_TURN = 8`.
  - TETR.IO ~333 ms travel window (locked out during travel); Jstris ~500 ms.
- **PPT-specific**: 30% chance of changing hole column *within* an attack, 90% between (https://harddrop.com/wiki/Opener). Albatross is garbage-sensitive.
- **Downstacking**: flat non-jagged stacks maximise combos; when garbage is clean upstack+spike, when dirty downstack-combo; L/J best, S/Z jagged, O worst (https://howtotetris.com/advanced-downstacking/).
- **4-wide**: https://harddrop.com/wiki/4-Wide_Setups; from combo 9 each single sends 4.

### nana's versus policy (steal this)
[`cpp/Tetris/game/Opponent.hpp`](https://github.com/nightcrab/nana/blob/a74a0c8cdb255d28ecc6c09b3fa68246004e7aaa/cpp/Tetris/game/Opponent.hpp#L234-L330):
- States `BUILD_SPIN/BUILD_COMBO/BUILD_CLEAN/ATTACK`; next-build 50% spin, 40% clean, else combo (L201–209).
- Constants (L90–107): `ATTACK_PROB=80%`, `MISTAKE_DOWNSTACK_PROB=5%`, `WASTE_I_PROB=10%`, `COMBO_GARBAGE_PROB=40%`, `OPEN_SPIN_PROB=40%`.
- `can_attack()`: SPIN ≥2, CLEAN ≥4, COMBO height+combo ≥5, MESSY ≥1.
- `should_cancel()`: attack if possible **or `garbage_height + stack_height > 15`** (L267–274).
- `nextState()`: stack ≥10 → downstack; top MESSY → downstack; attacking & can attack → keep; else 80% roll.

---

## 3. Openers / perfect clears

Index: https://harddrop.com/wiki/Opener.

| Opener | PC rate / payload | Notes |
|---|---|---|
| **PCO** | 84.64% with I hold, 61.19% otherwise | Covers ~92.46% of opening bags. |
| **Grace** | 88.57% if T held | Slightly higher than PCO. |
| **TKI 3** | many ≥85%, some 100% | 2×TSD then PC; counters 4-wide. |
| **DT Cannon** | TSD→TST; PC 36.11%→79.05%; C-Spin 99.72% | Most versatile; counters 4-wide; fast to execute. |
| **Albatross** | 99.99% PC after TSD | Garbage-sensitive (10%), needs early O. |
| **MKO / Gamushiro / Yamaha** | 26–45% 4-line PC | Strong Triple-Double fallbacks. |

Cold Clear ships an **opening-book generator** (graph + DP, `MemoryBook`) plus a **PC solver** (`pcf`/`PcLooper`, up to 11 pieces) ([`can_pc_loop`](https://github.com/MinusKelvin/cold-clear/blob/279edd7c3177ff8077f6a930193397814b281f27/bot/src/modes/mod.rs#L229-L241)).

**Recommendation**: hard-code PCO + TKI-3 + DT Cannon for bags 1–3; bail to search if incoming garbage would spoil it.

---

## 4. Opponent modeling & counters

1. **Markov stack-layer model (nana)** — layers {CLEAN, COMBO, SPIN, MESSY}, height, `open`; predict via `can_attack`/`should_cancel`/`ATTACK_PROB`; send un-cancellable bursts when they are in BUILD or `garbage_height + stack_height > 15`.
2. **Incoming-garbage defense (Cold Clear [`pick_move`](https://github.com/MinusKelvin/cold-clear/blob/279edd7c3177ff8077f6a930193397814b281f27/bot/src/evaluation/standard.rs#L150-L173))**: prefer the first candidate where `incoming − garbage_sent + min(height[3..6]) ≤ 20`; else the largest `spike` (running attack sum).
3. **Burst concentration (MisaMino)** — reward damage-per-line and B2B chains, not raw clears.
4. **Target the top-out** — stack a spike while the opponent is high (PPT 30% intra-attack hole randomness limits deterministic garbage exploits).

RIKU: GA fitness = `attack diff + 50·win` gives stronger, more robust weights than solo APP.

---

## 5. Search improvements (ranked)

1. **Transposition merging on a DAG** (cold-clear, cold-clear-2, RIKU, nana TDS) — do before widening beam.
2. **MCTS/best-first leaf selection** with `P(i) ∝ ((E_i−min)²+10)/((i−1)²+1)` + `max(R_i+E_i)`; MCTS 3200 iters ≫ depth-limited (https://thawsitt.me/files/Tetris_AI_CS221_final_paper.pdf).
3. **Speculation over unknown pieces** (branch over the bag).
4. **Rank decay** as soft move-ordering.
5. **Anytime search + node budget**, not fixed depth.
6. **Expected-value search over the 7-bag** (Dom Slee): +13% score but 132× slower; use at the root only.
7. **PC-specific solver** for the empty board.
8. **Evaluate after pending garbage lands** (quiescence analogue).

MisaMino is the counterexample: exhaustive depth-2 + tiny linear eval plays near-perfectly — **movegen + depth beats a fancy eval**.

---

## 6. Accessible weights / datasets (non-NN)

- Cold Clear default + fast_config; Cold Clear 2 `default.json`.
- RIKU `champion-vs.json` / `solo-attack.json` / `balanced.json`.
- MisaMino `ai_factor_l[3]`; nana `Eval.cpp`.
- `ahelwer/BattleTetrisAI` (Harmony Search).
- knewjade `sfinder-cpp` / `solution-finder` (PC/B2B/combo databases).
- Kaggle TETR.IO top-player replays; `a-cory-k/Tetris_RL` CSVs.
- GA reference: Cold Clear `optimizer/`, RIKU `tune.py`/`vs-tune`.

---

## 7. Neural nets — smallest viable + honest compute

**Evidence says don't bother yet**: RIKU found an MLP residual ≈ linear.

- **Feature-vector MLP residual** (RIKU): `score = linear + MLP(features)`, hidden 16–64, warm-start MLP zeroed; **CPU-trainable by neuroevolution**.
- **Tiny bitboard CNN** (nana): depthwise 3×3 + pointwise 1×1 over `32×W`; CPU inference microseconds, training needs GPU.
- **20×20 CNN, 44 actions**: ~1M records (180 MB), trained on a GTX-era GPU.
- **Tiny 10×10 neuroevolution**: CPU only (tiny nets).
- **Distillation from a strong search bot**: label millions of positions with the teacher's move/value, fit a small MLP/CNN (~CPU-hours for the teacher; MLP CPU-trainable, CNN needs a modest GPU).
- **Avoid on CPU**: BetaTetris-scale (1.5 TB tablebase, 8 GB CUDA).

**Compute flag**: distillation data generation is the real cost (~1M–10M labeled positions).

---

## 8. Concrete port checklist for `rust/deepseek-rust`

1. **Movegen**: SRS + kicks + tucks; enumerate all reachable locks; flag spin/mini via 3-corner + kick rule.
2. **Eval**: start from Cold Clear default (30 features incl. `tslot`, `cavity`, `overhang`, `covered`, `well_column`, `combo_garbage`, `wasted_t`) or RIKU champion-vs (20); add `garbage_sent` + T-slot bonus.
3. **Search**: transposition-merged DAG + probabilistic leaf selection + speculation + anytime node budget; keep beam as fallback.
4. **Book**: PCO / TKI-3 / DT Cannon for bags 1–3.
5. **Opponent model**: port nana's `StackLayer`/`TacticState`; `can_attack`/`should_cancel`.
6. **Garbage mechanics**: match the sim exactly; add Cold Clear's incoming-defense clause + `spike` tiebreak.
7. **Weights**: GA-tune by versus self-play vs Hoiko (fitness `50·win + attack_diff`); 2000+ games per config for 1–2% resolution.
8. **Optional NN**: only after 1–7 — distill a 16–64 hidden MLP residual.

---

### Key source links
- Cold Clear: https://github.com/MinusKelvin/cold-clear · Cold Clear 2: https://github.com/MinusKelvin/cold-clear-2
- MisaMino: https://github.com/misakamm/MisaMino · https://tetris.wiki/MisaMino
- nana: https://github.com/nightcrab/nana
- RIKU0804/tetris-ai: https://github.com/RIKU0804/tetris-ai
- knewjade: https://github.com/knewjade/solution-finder
- Hard Drop: [Opener](https://harddrop.com/wiki/Opener), [Garbage](https://harddrop.com/wiki/Garbage), [Multiplayer Techniques](https://harddrop.com/wiki/Multiplayer_Techniques), [4-Wide](https://harddrop.com/wiki/4-Wide_Setups), [DT Cannon](https://harddrop.com/wiki/Double_Triple_Cannon_Opener), [PCO](https://harddrop.com/wiki/Perfect_Clear_Opener), [TKI 3](https://harddrop.com/wiki/TKI_3_Perfect_Clear), [Albatross](https://harddrop.com/wiki/Albatross_Special)
- TETR.IO garbage timing: https://github.com/tetrio/issues/issues/435
- TGM versus: https://www.tetris.wiki/TGM_Versus_Mode_Guide
