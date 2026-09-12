# Full-game differential — shipping `Hoiko.exe` vs Rust/WASM replica

Harness: `tools/hoiko-oracle/diff/fullgame.ts` (design A: one fresh `wine Hoiko.exe`
process per move through the rebuilt `tools/hoiko-oracle/run_oracle.sh`).
Run: seed 1, cap 200 pieces, ~0.3 s per exe query after prefix warm-up.

## Verdict

**The replica matched 183/183 moves, then diverged on move 183 (1-based piece 184).**

| | exe | rust (`adapt:false`, beam 150, depth 14) |
|---|---|---|
| move | **x=7, rot=2, m=2 (L)**, act 0, moveDelay 232 | **x=7, rot=0, m=2 (L)**, act 0, moveDelay 232 |
| post-move board (native rows 0..4) | `1015, 1015, 999, 967, 448` | `1015, 1015, 995, 967, 449` (per gen-1 expansion) |

Both runs (two independent full executions) stop at the same move with the same two
decisions. A 3x replay of the exact turn-183 snapshot gives 3/3 identical exe results
and 3/3 identical rust results, so the divergence is deterministic, not flaky.

Method note: the primary replica fighter is constructed **fresh per turn** (`adapt:false`,
beam 150, depth 14), mirroring the exe's fresh process — no carried beam or weight-index
state on either side. The faithful persistent `adapt:true` engine is recorded separately.

The snapshot both engines received (turn 183) was identical:

- board rows 0..4 = `1015, 1015, 995, 960, 448`, rows 5..31 = 0
- current `L`, hold `T`, combo `0`, btb `24`
- queue (current first): `L, I, J, S, Z, S, L, I, ...` (the next-2 pins are `I,J`)

## The divergence is not a move-generation gap

The native `hoiko-core` probe (`cargo run --release --example probe`) expands the exact
turn-183 snapshot; the exe's placement is present in the replica's gen-1 child set with
the identical resulting board:

```
C x=7 r=2 m=2 act=0 h=4  board: 1015 1015 999 967 448 0   <- exe's move, identical post-board
C x=7 r=0 m=2 act=0 h=4  board: 1015 1015 995 967 449 0   <- replica's move
```

So the two engines agree on the legal moves and their resulting boards; they disagree
on which gen-1 child the depth-14 beam search ends up preferring.

## Depth sweep on the same snapshot (replica, `adapt:false`)

| depthLimit | replica choice |
|---|---|
| 10 | x=7 rot=0 |
| 11 | **x=7 rot=2 (agrees with exe)** |
| 12 | x=7 rot=0 |
| 13 | x=7 rot=0 |
| 14 | x=7 rot=0 |

The exe ran depth 14 on every one of the 184 turns (`depth @444 = 14`, no time abort:
~70 ms search << 1000 ms limit). The flip between depth 11 and 12 makes this a
deep-beam scoring/selection difference, not a depth-regime artifact.

## Regime and state checks (all 184 queried turns)

- exe `depth=14` on 184/184; `beamLimit=150` on 184/184 (fresh process per move, timer started).
- act matched on 183/183 pre-divergence turns; `moveDelay` matched on 183/183.
- Applying the exe's move to `src/core/engine.ts` reproduced the exe's post-move board
  and hold slot on 183/183 turns (0 state mismatches) — the local execution model is faithful.
- `engineBtb == exe btb` on 184/184. The engine's `nativeCombo` differs from the exe's
  `combo` on 23 turns (the binary keeps negative combo values across a break; the engine
  stores 0), but the harness always feeds the exe's carried value to both sides, so it
  never affects the compared decision.

## Secondary evidence — faithful `adapt:true` (app config), persistent

For reference only (not the verdict): a persistent `createRustHoiko({...FAITHFUL_HOIKO})`
engine was queried on the same snapshots. It disagreed with the exe on 23 of the 183
matched moves before turn 183, with `beamSizeLimit` drifting 305..1500 because the wasm
`SetNextOption` is disabled (`adapt=0` in the FFI input) and the host's JS reimplementation
adapts on wasm wall-time. The exe (fresh per move) stays at beam 150. This is the known
adaptation divergence; isolating it needs a carried-globals exe mode and is out of scope here.

## Reproduce

```bash
HOIKO_DIR=/path/to/Hoiko_PPT_v0-beta1 bash tools/hoiko-oracle/build_oracle.sh
bun tools/hoiko-oracle/diff/fullgame.ts --cap=200 --seed=1 --name=seed1-cap200
```

Expected: `DIVERGENCE turn=183: exe x=7 rot=2 m=2 ... | rust x=7 rot=0 m=2 ...`.

## Artifacts

- `seed1-cap200.jsonl` — 184 per-turn records: full snapshot, exe raw fields, primary rust
  decision, secondary `adapt:true` decision, per-turn state match flags.
- `summary-seed1-cap200.jsonl` — machine-readable summary (one JSON object, first divergence included).
- `divergence-turn183.log` — full raw exe output for the divergent move.
