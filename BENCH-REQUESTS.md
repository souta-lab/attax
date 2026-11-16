# Bench requests — AI-improvement lane (improve/cc2-rematch)

Written 2026-11-13 ~23:55 by the improvement lane. The orchestrator runs these; this lane
does not run match batches. Never use seeds 12001–12020 and never touch
`tools/cc2-rematch/runs/final-12001-12020/`.

## Hypothesis under test: H1 horizon extension (exact 7-bag chance ply) on field40

The frozen policy is attack-saturated within its 6 visible pieces. Recorded-board checks
on the frozen profile's own draw and loss boards (FIX-REPORT "Post-freeze improvement
lane") show this. Doubling the attack weight and cutting the height terms raises
planned attack by only +0.7%. A bonus for packing attack into consecutive locks raises
planned 3-lock burst by at most +3.7%. Both mechanisms were dropped without match
compute. The lever that still changes decisions materially is the evaluated horizon. The
existing opt-in `ATTAX_SPECULATE=1` adds an exact 7-bag chance ply after the preview. It
averages the best continuation over every piece the bag can still deal, and a dead
possibility counts as -1e6. CC2 uses the same idea. It changes 13% of the frozen
profile's decisions on recorded boards (45/347). It has never been measured in isolation:
bag40-survival bundled it with survival weights, exposure 6, width 64 and the
*unaligned* attack model.

Prediction: fewer draws and no more losses than control, with APP within 0.03 of control.

Source: the frozen field40 source. `src/` at this request's commit is byte-identical
to HEAD d2dfc23 and to the frozen snapshot (this lane changed only tests/ and tools/).
The adapter `tools/cc2-rematch/attax-tbp.ts` is unchanged. probe.sh snapshots it per label
as usual.

Cost: about 1.6× Attax decision time (median 168 → 270 ms, p95 261 → 316 ms, width 96, same
recorded boards, measured under the current machine load).

### R1 (first, 20 games): paired against the existing frozen-profile batch

| field | value |
|---|---|
| label | `field40-speculate` |
| env diff vs frozen | `ATTAX_SPECULATE=1` (only change) |
| full env | `ATTAX_ROWS=40 ATTAX_GUIDELINE=1 ATTAX_WIDTH=96 ATTAX_DIVERSE=0 ATTAX_EXPOSURE=0 ATTAX_SPECULATE=1`, no `ATTAX_WEIGHTS` |
| seeds | 2401–2410, both seats (probe.sh default: 2 games per seed) = 20 games |
| control | existing `runs/field40-no-diversity` (17W-1L-2D, same seeds, same source) |
| command | `ATTAX_ROWS=40 ATTAX_GUIDELINE=1 ATTAX_WIDTH=96 ATTAX_DIVERSE=0 ATTAX_EXPOSURE=0 ATTAX_SPECULATE=1 tools/cc2-rematch/probe.sh field40-speculate 2401 2410` |

### R2 (decisive, 80 games): fresh tuning seeds, both arms

| field | value |
|---|---|
| labels | `field40-control-2601` (frozen env, `ATTAX_SPECULATE=0`) and `field40-speculate-2601` (`ATTAX_SPECULATE=1`) |
| seeds | 2601–2620, both seats = 40 games per arm |
| commands | as R1 with label/seed range changed; control uses `ATTAX_SPECULATE=0` |

Interleave the two arms seed-by-seed if possible (same machine-load conditions per pair).
If compute is short, run R1 first. If R1 shows speculation behind control by 2+ wins, R2
may be skipped and the verdict is negative.

### Pre-registered decision rule (fixed before any result)

Score per game W=1, D=½, L=0. Pair games by (seed, seat) and take speculate minus control.
1. Primary: wins out of all paired games run (draws are non-wins, as in the final gate).
2. Adopt speculation as the next candidate profile only if pooled R1+R2 wins favour it by
   **≥ +3** (of 60 games per arm), **and** its losses are ≤ control losses + 1, **and** its
   Attax-minus-CC2 APP margin is not lower than control's by more than 0.03.
3. R1 alone (control ceiling 17/20) can only rule speculation out, never in.
4. Otherwise the verdict is "no measurable benefit". The frozen profile stays, and the
   flag stays default-off (it is pre-existing code, so there is nothing to revert).
5. Power, stated honestly: with about 85% base win rate, ±3 wins over 60 games is roughly
   one standard error of the paired difference. A positive verdict means "worth carrying
   into the next fresh-seed gate", not proof.

Secondary, descriptive only: draws, median game length, APP both sides, Attax decision ms
(from `*.attax.log`), and recorded-board fidelity (`check-recorded.ts`).

Please write results (per-label W-L-D, APP, and the paths to the summaries) to
`BENCH-RESULTS.md` in this workdir.
