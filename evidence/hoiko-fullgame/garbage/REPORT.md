# Versus garbage/OffsetAI differential — shipping Hoiko.exe vs Rust/WASM replica

Run: 2026-09-12T12:18:11.471Z
Args: seeds=1,2,3,7,11 cap=150 maxTicks=20000 tick=16 pressure=0 pressureEvery=96 garbageDelay=1

## Verdict

**FULL AGREEMENT on all 5 seed(s): 62 thinks (seed 1), 101 thinks (seed 2), 97 thinks (seed 3), 95 thinks (seed 7), 51 thinks (seed 11)**

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
- Exe wall time: 22s.
- **All compared fields agreed.**

### seed 2

- Right thinks: **101**; pieces: **150**; pressure: 0; winner: n/a; reason: **cap**.
- Pending-garbage turns: **14**; garbageWait=1 turns: exe **0**, replica **0**.
- Exe wall time: 35s.
- **All compared fields agreed.**

### seed 3

- Right thinks: **97**; pieces: **150**; pressure: 0; winner: n/a; reason: **cap**.
- Pending-garbage turns: **10**; garbageWait=1 turns: exe **0**, replica **0**.
- Exe wall time: 34s.
- **All compared fields agreed.**

### seed 7

- Right thinks: **95**; pieces: **150**; pressure: 0; winner: n/a; reason: **cap**.
- Pending-garbage turns: **16**; garbageWait=1 turns: exe **0**, replica **0**.
- Exe wall time: 34s.
- **All compared fields agreed.**

### seed 11

- Right thinks: **51**; pieces: **79**; pressure: 0; winner: left; reason: **KO**.
- Pending-garbage turns: **8**; garbageWait=1 turns: exe **1**, replica **1**.
- Exe wall time: 17s.
- **All compared fields agreed.**

## Artifacts

- seed 1: `seed1.jsonl`, `summary-seed1.jsonl`
- seed 2: `seed2.jsonl`, `summary-seed2.jsonl`
- seed 3: `seed3.jsonl`, `summary-seed3.jsonl`
- seed 7: `seed7.jsonl`, `summary-seed7.jsonl`
- seed 11: `seed11.jsonl`, `summary-seed11.jsonl`
