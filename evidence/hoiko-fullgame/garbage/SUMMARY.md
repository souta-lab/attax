# Garbage + OffsetAI exe-vs-replica differential — findings and verdict

Task: extend end-to-end replica-vs-exe equivalence from solo play to garbage /
OffsetAI, by teaching the oracle stub the pending-garbage + offset/sync fields,
then driving a versus match with the exe as one fighter and comparing the Rust
replica on identical snapshots.

## Verdict

**Garbage/OffsetAI-equivalent in the tested regimes.** In every run the exe and
the Rust replica agreed on the first move `(x, rot, m)`, the clear `act`,
`garbageWait`, hold usage, the carried weight family index, and all 15 carried
OffsetOffAI state fields, on identical snapshots:

| Run | Seeds | Right thinks | Mismatches | pending>0 turns | canWait=1 | garbageWait=1 |
|---|---|---|---|---|---|---|
| smoke (cap 24) | 1 | 17 | 0 | 0 | — | 0 |
| natural (cap 150) | 1,2,3,7,11 | 406 | 0 | 58 | 63 | 1 (seed 11) |
| stress (pressure + delay 4) | 1,2,7 | 186 | 0 | 114 | 30 | 5 (seed 2 ×1, seed 7 ×4) |
| **total** | | **609** | **0** | **172** | **93** | **6** |

`garbageWait=1` fired 6 times and matched every time; weight-family-2 phases
(`weightIndex=2`, 35 thinks) matched too. Act matched on every think (0 act
mismatches). Raw records: `seed<N>.jsonl`, `stress-d4-seed<N>.jsonl`,
`summary-*.jsonl`, generated `REPORT.md` / `stress-d4-REPORT.md`.

Stress runs inject garbage (`--pressure=3` every 64 ticks via the engine's
`receiveGarbage`) and use `garbageDelay=4` so the wait branch is observable on a
low stack; they are coverage runs, not app-regime claims. Both engines still see
identical snapshots. Natural runs use the canonical `resolveVersusConfig()`.

## Harness interface

`bun tools/hoiko-oracle/diff/garbage.ts [--seeds=1,2,7] [--cap=120]
[--pressure=0] [--pressure-every=96] [--garbage-delay=1] [--name=]`

- Right fighter = exe stub (`tools/hoiko-oracle/diff/exe-fighter.ts`), one fresh
  `Hoiko.exe` process per think; right replica = one persistent
  `createRustHoiko({...FAITHFUL_HOIKO, adapt:false})` engine queried on the same
  snapshot before the exe call.
- Left fighter = Rust/WASM DeepSeek v2 (real attacks); engine
  `src/core/engine.ts` + `resolveVersusConfig()`.
- Wrapper matches the adapter's state carry: `frameMs += frameStepMs(20)`
  (=333 ms/think), the exe's `OFFSET post` state and `weightIndex` are written
  into the next query, and `next=` is padded to 28 with `MINO_NONE` exactly like
  `build_root`.

New stub keys (all opt-in; legacy `board`/`next`/`hold`/`combo`/`b2b`/`timer`
inputs are unchanged):

```
garbage= pending_garbage= nowms= iseven= weightindex=
offsetenabled= sync= useoffset= ofscanwait= ofscenter4= ofsatk=
ofspcchance= ofsnearoffset= gboppatk= gbcool= gbremaining=
gblockcount= gbfirstinvalid= haslastown= lastownid= haslastopp= lastoppid=
lockid= lastaction= lastattack= opplock= opplockid= oppclear= oppbtb= oppcombo=
```

New stub outputs: `garbageWait=<0|1>`, `OFFSET post use=.. canWait=.. center4=..
atk=.. pc=.. near=.. gbAtk=.. gbCool=.. gbRem=.. gbLock=.. gbFirst=.. hasOwn=..
ownId=.. hasOpp=.. oppId=..`, `planacts=a0,a1,a2`, `weightIndex=<k>`.

Stub mechanics (RVAs from `monodis --fields`; base = `Marshal.GetHINSTANCE`):

- isEvenBoard @0x66382, `OffsetOffAI.useOffsetOff` @0x6638C, `ofsData` @0x66390
  (16 B: bool@0, int@4, int@8, bool@12, bool@13), `gbData` @0x663A0 (20 B: four
  ints then bool@16) — written raw because managed reflection only sees the
  opaque `<alignment member>`.
- `EvaluateAI.weight/weightList` @0x66378/0x66368: `weightindex=k` writes
  `weightList + 272*k` (EvalWeight = 272 B), post-search index read back.
- `offsetenabled`/`sync` replay `rust/hoiko-core/src/offset_driver.rs::sync` with
  the binary primitives (`SetPrevAct`, `LockOffsetAfterClearing`,
  `OpponentIsNewLockDown`, `CalcOpponentsAtk`, `IsFirstInvalidLockDown`,
  `InvalidateGettingEnemysAtk`, `UseOffsetOff`), then after `SearchAI.Search`
  call `DecisionOffsetOff(root)` and emit
  `garbageWait = !IsLocked(frame) && CanOffsetOff(pendingGarbage)` — the same
  contract as `HoikoOffsetDriver::decide`. Frame clock =
  `trunc(now_ms * 0.06)`, identical to the adapter.

## Root causes found and fixed

Three real issues, two in the harness and one faithfulness bug in the replica.
Each was first seen as a concrete divergence:

### 1. Harness: hold availability was not passed to the exe

- Divergence: smoke think 1, post-hold snapshot (`canHold=false`): exe placed
  I at `x=3`, replica at `x=0` (rot/m/act equal).
  Raw: `smoke-divergence-seed1-turn1.{json,log}`.
- Cause: the stub had no `canHold` input, so the search always allowed hold,
  while the adapter passes `allow_hold = snapshot.canHold`.
- Fix: exe input `usehold=${canHold ? 1 : 0}` (stub writes `ExpandAI.useHold`,
  RVA 0x663D0), which is the exact global counterpart of the replica's
  `allow_hold` gate.

### 2. Replica faithfulness bug: `DecisionOffsetOff` board and height seeding

- Divergence: smoke think 14, move/act/garbageWait/useHold all equal but
  `ofsCenter4: exe=5 rust=6`.
  Raw: `smoke-divergence-seed1-turn14.{json,log}`.
- Causes (both in `rust/hoiko-core`):
  1. The binary's `DecisionOffsetOff` seeds the `Int32Array` with **-1** before
     `Board.GetColumnHeight` (IL 13943–13954); the port called
     `get_column_height_zeroed` (0-seeded), reporting every height one too high.
  2. The binary reads the **post-first-move** root GamePack: `WriteResult` copies
     the generation-1 node into the root (`CopyBlock(root+120, gen1, 304)`,
     IL 15893), so board/hold/btb are the state after the committed first move.
     The port passed the pre-search input board.
- Fix (`rust/hoiko-core`):
  - `search.rs`: `FirstMoveState { board, hold_m, btb }` carried from generation 1
    and exported on `SearchOutcome` (`best.first_state`).
  - `ffi.rs`: `decide` now uses `o.first_state.{board, hold_m, btb}`.
  - `offset_driver.rs`: `input.board.get_column_height(...)` (-1 seed).
  - Regression test `decide_uses_minus_one_seeded_column_heights` (asserts
    center4=5 vs 6 on the exact exe board); verified red on the old code.
  - `src/ai/wasm/hoiko_core.wasm` rebuilt (`rust/build.sh`).

### 3. Harness: weight family index not carried into the fresh exe process

- Divergence (stress only): think 94, board at `weightIndex=2` phase:
  exe x=2 vs replica x=8, same plan acts `[0,0,6]`, exe node count 63723 vs
  63778, and `ofsCenter4` 15 vs 13 as a consequence of the different chosen
  move. Raw: `stress-d4-divergence-seed7-turn94.{json,log}`.
- Cause: each exe process starts at `weightList[0]`, while the persistent
  replica (like the app/real binary in-process) carries `weightIndex`; after a
  tall-board transition `transition_weight` selects family 2 (`wd`), so the two
  searched with different weights.
- Fix: stub `weightindex=` restore + readback; wrapper carries and compares it.
- Also fixed while here: the stub wraps short `next=` lists, so the wrapper now
  pads to 28 with `MINO_NONE` exactly like `build_root`.

## Gate results (all green, same run as this report)

| Gate | Result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bun test` | 113 pass / 0 fail |
| `bun run lint` | clean |
| `bun run build` | built |
| `cargo test --manifest-path rust/Cargo.toml` | hoiko-core 50 pass (49 + 1 new regression) and all other suites pass |
| `bun tools/hoiko-oracle/diff/diff.ts` | 9/9 first move + DELAY-OK |
| `bun tools/hoiko-oracle/diff/twosearch.ts` | 9/9 beam adaptation |
| `bun tools/hoiko-oracle/diff/fullgame.ts --cap=500` | 500/500 moves, 0 act/state mismatches (final stub) |
| `bun scripts/gate-v2.ts` (32 seeds) | **24-8** vs DeepSeek v2, preserved |

## Scope and caveats

- The stub models the **adapter's** decision contract
  (`DecisionOffsetOff` → `!IsLocked && CanOffsetOff(pendingGarbage)`). The
  binary's full in-game wait lambda also has an `opponentsAtk` branch
  (IL 2862–2905); that app-side branch is not part of `offset_driver.rs::decide`
  and is not modeled on either side.
- `canHold=false` is represented as a global `useHold=0` on both engines, which
  is the app's `allow_hold` contract. The binary's per-piece `hold.swappedHold`
  game path is not modeled (the stub root keeps `swappedHold=0`).
- The exe is a fresh process per think; restored state = weight index, the 15
  OffsetOffAI fields, own/opp lock ids, and the virtual frame clock. The search
  regime is `timer=1` (1000 ms) with depth 14 / beam 150, the exe-equivalent of
  `adapt:false`; no time-limit cutoff was observed (`depth @444 = 14` in all
  runs, exe search ≤ ~120 ms).
- Stress runs (`--pressure`, `--garbage-delay=4`) are coverage regimes. The
  natural runs (5 seeds, 406 thinks) are app-regime.
- `pressure4-*` files are an earlier iteration (stub before weight-index carry);
  they are kept as raw history, not part of the verdict. The authoritative
  datasets are `seed*.jsonl` (natural) and `stress-d4-seed*.jsonl` (stress).
