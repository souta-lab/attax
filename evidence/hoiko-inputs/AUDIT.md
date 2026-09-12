# Hoiko engine input-contract audit

Scope: every input the versus harness/adapter feeds the Rust/WASM Hoiko replica,
checked against the shipping `Hoiko.exe` (Wine oracle stub +
`Hoiko.all.cs` decompile). "Correct?" means the value the harness computes equals
the value the binary's real per-turn path passes to `SearchAI.Search`.

Raw evidence lives next to this file (`nextcarry/`, `iseven/`, `weight/`) and in
`evidence/hoiko-fullgame/` (full-game and versus/OffsetAI differentials).

| input | harness computation | binary semantics | correct? | fix | evidence |
|---|---|---|---|---|---|
| persistent `NextMino` (`m[28]`, `trustEnd`, `bagRemains`) | rebuilds the root every think from the live snapshot, so the queue tail/trust was reset | persistent root: `RootNode.SetPPTData` = `ShiftNext` (+1 when the last command was an empty-slot hold) + `Compare(0, live)` per turn; `RootNode.Init` fills the bag once at match start | **was wrong**: first search never ran `NextMino.Init` (tail was all `None`), so `trustEnd`/bag predictions diverged | `advanceNext` runs `NextState.init(live)` on the first search, then one `shift` (+1 after hold) + `compare(0, live)` per turn; carry wired in `RustHoikoEngine` (`next_carry*` FFI fields, `build_root_carried`) | `nextcarry/report.json` (TS state == exe `NEXTDUMP` full `m[28]`/trust/remains 13/13), `nextcarry/behavior.json` (exe vs replica decisions 20/20), `tests/hoiko-next.test.ts`, stub keys `shiftnext=`/`carrym=` |
| `isEvenBoard` (versus) | `PopCount(board) even` per turn (`evenMode:"auto"`) | `ReadConfig` = `true`; only `EvenOrOdd` (called from `QuickSearch`) sets parity, and `QuickSearch` runs only on the `NextTurn` resync (`!IsSameAs(root, mimic)`) | **correct as an equivalent**: the exe probe shows the real static is `true` and parity changes the move on an odd board (`iseven=1`/real = `6/0/6`; `evenodd=1` = `0/0/0`), and board parity is invariant under piece locks (+4 cells) and line clears (-10 cells/row), so it changes only when garbage rows arrive — every garbage arrival desyncs the board and forces the resync `QuickSearch`+`EvenOrOdd` that recomputes exactly that parity. Initial state (empty board) is parity-even == `true` | none | `iseven/decompile-isEvenBoard.txt` (writers 11042/13658; caller 15603; normal path 5054/3630/21972), `iseven/report.json` (9/9 real==`iseven=1`, 9/9 `evenodd`==replica `auto`; `odd-3bit-I-*.log` is the discriminating case), versus scan 117/258 odd-parity turns all decision-identical |
| `EvaluateAI.weight` row | carried `out.weightIndex` into the next search, **but forced back to 0 every versus search** | persists across turns; only `ReadEvalWeight` (Init), `TransitionWeight`, `EvenOrOdd` write it — no per-turn reset | **was wrong**: `TransitionWeight` reads the previous row (transitionHeight 13 vs 15, sticky row 1) | removed the `versus` reset; row now carried like the in-process binary | `weight/decompile-weight.txt` (readers 13548/13618/13632; `SearchAI.ReadConfig` only at Init 2497/4001/6315), `weight/discriminating-*` (exe move 0/2/1 at row 0 vs 4/1/1 at row 2 on a real versus position) |
| `combo` | engine `nativeCombo`, clamped to 0 on a no-clear lock | `Others.CalcAtk`: `if (combo > 0) combo *= -1; else combo = 0` — exe `postmove` combo is negative (-1/-2/-3) | **was wrong**: engine reported 0 where the exe reports negatives (330/2550 solo records) | `applyClear`: `nativeCombo = nativeCombo > 0 ? -nativeCombo : 0` | `evidence/hoiko-fullgame/*.jsonl` (`exe.postCombo` histogram `{-3:3,-2:22,-1:305,0:1861,...}`), `Tetriz_Common.cpp:530`, `tests/game-logic-regressions.test.ts` |
| `btb` | engine `nativeBtb` | `Others.CalcAtk` btb updates | yes (0 mismatches vs exe `postmove.btb` over 2550 records) | none | `evidence/hoiko-fullgame/*.jsonl` |
| `pendingGarbage` | `snapshot.pendingGarbage` (own incoming, not yet spawned) | `DecisionOffsetOff` wait gate gets `GetComingGarbage(playerNo)` (own); `ObserveOpponent` gives the same value to `OpponentIsPowerfulBoard` | yes | none | decompile 3133-3136 / 3186-3189, `evidence/hoiko-fullgame/garbage/` (wait decisions and 15 offset fields all match) |
| `sync` fields (`lockId`, `lastAction`, `lastAttack`, `opponentLockId`, `opponentLastClearLines`, `opponentLastNativeBtb`, `opponentLastNativeCombo`) | engine lock transitions | `NextTurn` reads combo/btb from memory, `LockOffsetAfterClearing(GetMatchFrames(), GetComingGarbage(opponent), GetNextCount(opponent))`; `lastAttack` is net of blocked | **was wrong in the harness**: `exe-fighter.ts` sent `oppcombo=` for the sync opponent combo, but the stub's `oppcombo=` key is the versus static `EvaluateAI.SetOpponentsCombo`, so `_syncOppCombo` stayed 0 and `CalcOpponentsAtk` under-counted (divergence seed 1 think 50: `gbOpponentsAtk` exe=4 rust=5) | renamed the sync key to `opplastcombo=` in the stub + `exe-fighter.ts`; `oppcombo=` remains the vs static | decompile 3128-3136/3150-3152, `evidence/hoiko-fullgame/garbage/divergence-seed1-turn50.{json,log}` (pre-fix) and `seed1.jsonl` (62/62 post-fix) |
| carried `OffsetOffAI` (15 fields) | `RustOut` -> next input | same fields written to the native statics (RVA 0x6638C/0x66390/0x663A0) | yes | none (previous fix: `DecisionOffsetOff` -1-seeded column heights + post-first-move board) | `evidence/hoiko-fullgame/garbage/SUMMARY.md`, OffsetAI all-methods md5 identity |
| `next` queue length / pinning | `snapshot.next` (12) padded with `None` to 28 | `NextMino` fills its own bag; `Compare(0, realNext)` pins only `viewNext=2` entries | yes: entries beyond `viewNext-1` are never read from the input, and in carry mode the tail comes from the persisted `m[28]` | none | `probe.rs` `build_root`/`build_root_carried`, `nextcarry/report.json`, full-game 500/500 with a 12-entry queue |
| `board` encoding + arrived garbage | `boardToNativeRows` (row 0 bottom, col c = bit 9-c) from the live engine board (garbage already spawned) | `Board.line[32]` written directly by the game, rows include spawned garbage | yes | none | `versus-inputs` Part A 72/72, full-game 500/500, versus differential full agreement |
| `hold` / `allowHold` | `s.hold` / `s.canHold` | `game.hold.m` / `ExpandAI.useHold` (0 after a hold until the next lock) | yes | none (previous fix: `usehold=${canHold}`) | `evidence/hoiko-fullgame/garbage/SUMMARY.md` §1, differentials |
| `viewNext`, `depthLimit`, `minDepth`, `maxBeamSize`, `beamSizeLimit`, `weightIndex` init | config (`we`, 2, 14, 10, 50, 150, 0) | `ReadConfig` + `SetNextOption` | yes (initial values); `weightIndex` now carried (see above) | none | `tools/hoiko-oracle/REFERENCE.md`, `diff.ts` 9/9 + `twosearch.ts` 9/9 |
| match reset (app rematch) | the app reuses one fighter; the carried queue/weight/beam/offset/frame persisted into the next match | a new match runs `SearchAI.Init`/`ReadConfig` + `RootNode.Init` (fresh `NextMino`, weight row 0, beam 50/150, timer 1000, fresh OffsetOffAI) | **was wrong** for the browser rematch path (the gate recreates the fighter per match, so its numbers are unaffected) | added `RustHoikoEngine.resetMatchState()` + `fighter.reset()` | `src/ai/hoiko-rust-core.ts`, single-seed gate record byte-identical before/after (`/tmp/opencode/seed1-postreset.jsonl`), `tests/versus-controller.test.ts` |
| frame clock `now_ms` | virtual ms clock, +333 ms (20 frames) per think; converted by `*0.06` | game passes `Memory.GetMatchFrames()` (frames at 60 fps) into `LockOffsetAfterClearing`/`is_locked` | **modeled, not exe-verifiable**: stub and replica share the `ms*0.06` conversion, so the differential is self-consistent; the real game's frames per turn depend on the game and are not observable from the exe | none; `HOIKO_FRAMES` exposes the assumption | `ScpDriverStub.cs` `FrameOf`, `offset_driver.rs` `frame()`, decompile 3133, `garbage/SUMMARY.md` |
| search time budget (`time_limit_ms` / `SetNextOption`) | constant `time_limit_ms=1000` (no abort, deterministic depth 14) + wall-clock `applySetNextOption` when `adapt:1` | real per-turn `timer.limit = GetDelay-5` (set by the previous `SetNextOption`); `overTime` drives the beam adaptation from the binary's real elapsed time | **regime matches the oracle** (`timer=1` -> limit 1000, the verified 150/14 regime); the real game's `GetDelay-5` abort bound and the binary's real timing are not reproducible | none; `HOIKO_ADAPT=0` is the deterministic equivalence regime, `adapt:1` is a timing approximation | `diff.ts` 9/9, `twosearch.ts` 9/9, decompile 15598/15892, solo full-game `rustAdaptMoveMismatchCount` 27/196 (adapt:1) vs 0 (adapt:0) |

## Gate re-measurement (32 seeds, `DSV2_RUST=1`, fixed inputs)

Measured on a frozen copy of the tree (`engine.ts` `f5fb6003`,
`hoiko-rust-core.ts` `8c7740d8`, `hoiko-next.ts` `800d7da5`; the only later edit
was the inert `resetMatchState` addition, proven by a byte-identical single-seed
record). An independent run on the live tree reproduced `adapt=0` exactly
(23-9). Raw records: `gate-adapt0.jsonl`, `gate-adapt1.jsonl` in this directory.

| Gate | before (docs/BEAT_HOIKO.md) | after input audit |
|---|---|---|
| `HOIKO_ADAPT=0` (deterministic beam 150) | 26-6 | **23-9** (Hoiko +3) |
| `HOIKO_ADAPT=1` (wall-clock adaptation) | 24-8 | **26-6** (load-dependent; see residual #2) |

Hoiko improves in the deterministic regime; it does not reach 32-0. The inputs
above are exe-verified, so the remaining gap is dominated by DeepSeek being
genuinely stronger, not by an input-contract error. The `adapt:1` number moves
with machine load (its beam trajectory is driven by the host search time), so it
is not a stable comparison point.

`scripts/strength-sweep.ts` (fresh 12-seed set, all six configs) likewise shows
DeepSeek ahead everywhere: `d7-w24-beam500` 11-1, `d7-w24-beam3000` 8-4,
`d10-w24-beam500` 10-2, `d10-w24-beam3000` 11-1, `d10-w32-beam3000` 11-1,
`d13-w24-beam3000` 11-1 (`evidence/strength/sweep-inputaudit.jsonl`).

## Oracle differentials re-verified after the fixes

| Differential | Result |
|---|---|
| `garbage.ts` natural (seeds 1,2,3,7,11 cap=150) | **FULL AGREEMENT 406/406 thinks**, move/act/garbageWait/useHold/weightIndex + all 15 offset fields |
| `garbage.ts` stress (1,2,7, pressure 4, delay 4) | **FULL AGREEMENT 170/170 thinks**, `garbageWait=1` matched 10 times |
| `versus-inputs.ts` | **72/72 derivation + 8/8 behavior** |
| `nextcarry-behavior.ts` | **20/20** (exe `shiftnext=N` vs the adapter after N+1 searches) |
| `nextcarry.ts --ts-only` | TS `NextState` == recorded exe `NEXTDUMP` for all 13 positions x 8 shifts |
| `diff.ts` / `twosearch.ts` (solo) | unchanged green (beam 150/14, adaptation) |
| `bun test` (124) / `tsc` / `biome` / `vite build` / `cargo test` | all green |

## Residual approximations (documented, not fixed)

1. **Resync-turn weight seed** — on a real desync (garbage arrival) the binary's
   `QuickSearch` runs `EvenOrOdd`, which also seeds `weight = weightList[2]`
   before that search's `TransitionWeight`. The replica models the
   `isEvenBoard` half of the resync but not the row-2 seed; it carries the row
   from the previous in-sync turn. Only affects the first search after a
   garbage arrival.
2. **Host wall-clock beam adaptation** — `adapt:1` (the app/gate default) adapts
   the beam from the WASM search time, which is ~2.4x faster than the binary;
   the solo full-game differential shows 27/196 move diffs for `adapt:1` vs
   0/196 for `adapt:0`. No deterministic equivalent exists without emulating the
   binary's machine speed.
3. **Frames-per-think** — 20 frames (333 ms) per think is a model of the real
   per-piece game duration (not exe-observable); it only feeds the OffsetAI
   countdowns.

## Supplement — next-carry cadence, sync arg3, SetNextOption basis

Independent workstream on the same tree; raw evidence in `audit/`.

- **NextMino carry cadence (#8)** — the per-turn mutation is
  `RootNode.SetPPTData`: `ShiftNext` then `Compare(0, live)` each piece (IL
  7048-7049), plus one extra `ShiftNext` when the previous command was an
  empty-slot hold (IL 7050-7053). The adapter's first search must run
  `NextMino.Init` (0 shifts), so think *k* carries *k−1* shifts. New stub keys
  `shiftnext=N` (replays `N` per-turn mutations on the exe root) and `nextdump`
  (prints the full `m[28]`/`trustEnd`/`bagRemains`).
  - `audit/nextcarry-behavior.json` — exe `shiftnext=N` vs the adapter after
    `N+1` thinks, hold disabled: **20/20** (incl. `trustEnd=4`, `bagRemains=0`).
  - `tests/hoiko-next.test.ts` — full-array goldens for shifts 0..6 from the exe
    `NEXTDUMP`; `bun test tests/hoiko-next.test.ts` 5 pass.
- **`LockOffsetAfterClearing` arg3 (#6c)** — the binary passes
  `Memory2.GetNextCount(opponent)` (the opponent's draw cursor), not our own lock
  id (IL 3150-3152). Fixed in `rust/hoiko-core/src/offset_driver.rs` and the
  oracle stub; `garbage.ts --seeds=1 --cap=24` re-verified **17/17 full
  agreement** (`evidence/hoiko-fullgame/garbage/smoke-carry-REPORT.md`).
- **`SetNextOption` basis (#3)** — `overTime` is measured against `timer.limit`
  at search start (the carried `GetDelay(prev) − takeOverTime`), not the current
  search's `GetDelay` (IL 15908). Fixed in `applySetNextOption`.

| run (32 seeds, `DSV2_RUST=1`) | adapt | carry | result | Hoiko wins |
|---|---|---|---|---|
| recorded baseline | 0 | n/a | 26-6 | 6 |
| control (sync + basis fixes only) | 0 | off | 27-5 | 5 |
| carry on | 0 | on | **23-9** | **9** |
| carry on (final combined tree) | 0 | on | **23-9** | **9** |

8-seed ablations (adapt=0): carry off 6-2 → carry on **4-4**; `HOIKO_OFFSET=0`
4-4; `HOIKO_EVEN=true` 5-3; `HOIKO_FRAMES=0/20/120` all 4-4. So the carry is the
only audited input that materially moves the scoreboard; the frame clock and the
offset-enable choice are immaterial in the gated regime.

Full records: `audit/gate32-adapt{0,1}-carry.jsonl`,
`audit/gate32-adapt0-nocarry.jsonl`, `audit/gate32-final-adapt{0,1}.jsonl`,
`audit/strength-sweep.jsonl`. Oracle runs used a private run dir
(`/tmp/opencode/oracle-solo/run`) because the shared `/tmp/opencode/oracle/run`
was written concurrently.

Final `scripts/strength-sweep.ts` (12 fresh seeds, 6 configs, combined tree):
DeepSeek wins 10-12/12 in every config (`d10-w24-beam3000` and
`d13-w24-beam3000` are 12-0); Hoiko 0-2/12.

