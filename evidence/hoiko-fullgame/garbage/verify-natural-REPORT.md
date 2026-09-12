# Versus garbage/OffsetAI differential — shipping Hoiko.exe vs Rust/WASM replica

Run: 2026-09-12T12:53:50.986Z
Args: seeds=1,2,7 cap=120 maxTicks=20000 tick=16 pressure=0 pressureEvery=96 garbageDelay=1 name=verify-natural

## Verdict

**FULL AGREEMENT on all 3 seed(s): 62 thinks (seed 1), 80 thinks (seed 2), 76 thinks (seed 7)**

## Setup

- Right fighter: one fresh `Hoiko.exe` (Wine oracle stub) per think, `timer=1` (depth 14, beam 150), `adapt:false`-equivalent.
- Right replica: persistent `createRustHoiko({...FAITHFUL_HOIKO, adapt:false})`, queried on the identical snapshot each think.
- Left fighter: Rust/WASM DeepSeek v2 (generates attacks/garbage); engine `src/core/engine.ts` seeded per seed, `resolveVersusConfig()` (aligned garbage, 1-lock delay).
- Natural mode: no injected garbage (DeepSeek attacks only).
- Garbage delay: canonical `GARBAGE_DELAY=1`.
- Exe input per think: board(32 bottom-up) + next(28, current first) + hold + combo + b2b + timer=1 + garbage + nowms + iseven + sync=1 + offsetenabled=1 + carried `useoffset/ofs*/gb*/haslast*` + own/opp lock sync fields.
- Stub applies the carried OffsetOffAI statics at native RVAs (0x6638C/0x66390/0x663A0), mirrors `offset_driver.rs::sync`, runs `SearchAI.Search`, then `DecisionOffsetOff` + `IsLocked`/`CanOffsetOff` and prints `garbageWait` + `OFFSET post`.
- Compared per think: move `(x, rot, m)`, `act`, `garbageWait`, `useHold`, and all 15 carried OffsetOffAI state fields.

## Results

### seed 1

- Right thinks: **62**; pieces: **96**; pressure: 0; winner: left; reason: **KO**.
- Pending-garbage turns: **10**; garbageWait=1 turns: exe **0**, replica **0**.
- Exe wall time: 24s.
- **All compared fields agreed.**

### seed 2

- Right thinks: **80**; pieces: **120**; pressure: 0; winner: n/a; reason: **cap**.
- Pending-garbage turns: **12**; garbageWait=1 turns: exe **0**, replica **0**.
- Exe wall time: 32s.
- **All compared fields agreed.**

### seed 7

- Right thinks: **76**; pieces: **120**; pressure: 0; winner: n/a; reason: **cap**.
- Pending-garbage turns: **11**; garbageWait=1 turns: exe **0**, replica **0**.
- Exe wall time: 26s.
- **All compared fields agreed.**

## Artifacts

- seed 1: `verify-natural-seed1.jsonl`, `verify-natural-summary-seed1.jsonl`
- seed 2: `verify-natural-seed2.jsonl`, `verify-natural-summary-seed2.jsonl`
- seed 7: `verify-natural-seed7.jsonl`, `verify-natural-summary-seed7.jsonl`
