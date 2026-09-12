# Versus garbage/OffsetAI differential — shipping Hoiko.exe vs Rust/WASM replica

Run: 2026-09-12T12:14:58.165Z
Args: seeds=1,2,7 cap=150 maxTicks=20000 tick=16 pressure=3 pressureEvery=64 garbageDelay=4 name=stress-d4

## Verdict

**FULL AGREEMENT on all 3 seed(s): 47 thinks (seed 1), 43 thinks (seed 2), 96 thinks (seed 7)**

## Setup

- Right fighter: one fresh `Hoiko.exe` (Wine oracle stub) per think, `timer=1` (depth 14, beam 150), `adapt:false`-equivalent.
- Right replica: persistent `createRustHoiko({...FAITHFUL_HOIKO, adapt:false})`, queried on the identical snapshot each think.
- Left fighter: Rust/WASM DeepSeek v2 (generates attacks/garbage); engine `src/core/engine.ts` seeded per seed, `resolveVersusConfig()` (aligned garbage, 1-lock delay).
- Pressure mode: 3 extra garbage rows injected into the right core every 64 ticks (coverage for garbageWait=1). Snapshots stay identical for both engines.
- Garbage delay: 4 (stress-only deviation from the canonical config; snapshots stay identical for both engines).
- Exe input per think: board(32 bottom-up) + next(28, current first) + hold + combo + b2b + timer=1 + garbage + nowms + iseven + sync=1 + offsetenabled=1 + carried `useoffset/ofs*/gb*/haslast*` + own/opp lock sync fields.
- Stub applies the carried OffsetOffAI statics at native RVAs (0x6638C/0x66390/0x663A0), mirrors `offset_driver.rs::sync`, runs `SearchAI.Search`, then `DecisionOffsetOff` + `IsLocked`/`CanOffsetOff` and prints `garbageWait` + `OFFSET post`.
- Compared per think: move `(x, rot, m)`, `act`, `garbageWait`, `useHold`, and all 15 carried OffsetOffAI state fields.

## Results

### seed 1

- Right thinks: **47**; pieces: **72**; pressure: 3; winner: left; reason: **KO**.
- Pending-garbage turns: **32**; garbageWait=1 turns: exe **0**, replica **0**.
- Exe wall time: 19s.
- **All compared fields agreed.**

### seed 2

- Right thinks: **43**; pieces: **71**; pressure: 3; winner: left; reason: **KO**.
- Pending-garbage turns: **23**; garbageWait=1 turns: exe **1**, replica **1**.
- Exe wall time: 16s.
- **All compared fields agreed.**

### seed 7

- Right thinks: **96**; pieces: **151**; pressure: 3; winner: n/a; reason: **cap**.
- Pending-garbage turns: **59**; garbageWait=1 turns: exe **4**, replica **4**.
- Exe wall time: 34s.
- **All compared fields agreed.**

## Artifacts

- seed 1: `stress-d4-seed1.jsonl`, `stress-d4-summary-seed1.jsonl`
- seed 2: `stress-d4-seed2.jsonl`, `stress-d4-summary-seed2.jsonl`
- seed 7: `stress-d4-seed7.jsonl`, `stress-d4-summary-seed7.jsonl`
