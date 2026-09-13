# Versus garbage/OffsetAI differential — shipping Hoiko.exe vs Rust/WASM replica

Run: 2026-09-12T19:04:36.170Z
Args: seeds=1,2,7 cap=150 maxTicks=20000 tick=16 pressure=4 pressureEvery=96 garbageDelay=4 name=stress-d4

## Verdict

**FULL AGREEMENT on all 3 seed(s): 43 thinks (seed 1), 57 thinks (seed 2), 70 thinks (seed 7)**

## Setup

- Right fighter: one fresh `Hoiko.exe` (Wine oracle stub) per think, `timer=1` (depth 14, beam 150), `adapt:false`-equivalent.
- Right replica: persistent `createRustHoiko({...FAITHFUL_HOIKO, adapt:false})`, queried on the identical snapshot each think.
- Left fighter: Rust/WASM DeepSeek v2 (generates attacks/garbage); engine `src/core/engine.ts` seeded per seed, `resolveVersusConfig()` (aligned garbage, 1-lock delay).
- Pressure mode: 4 extra garbage rows injected into the right core every 96 ticks (coverage for garbageWait=1). Snapshots stay identical for both engines.
- Garbage delay: 4 (stress-only deviation from the canonical config; snapshots stay identical for both engines).
- Exe input per think: board(32 bottom-up) + next(28, current first) + hold + combo + b2b + timer=1 + garbage + nowms + iseven + sync=1 + offsetenabled=1 + carried `useoffset/ofs*/gb*/haslast*` + own/opp lock sync fields.
- Stub applies the carried OffsetOffAI statics at native RVAs (0x6638C/0x66390/0x663A0), mirrors `offset_driver.rs::sync`, runs `SearchAI.Search`, then `DecisionOffsetOff` + `IsLocked`/`CanOffsetOff` and prints `garbageWait` + `OFFSET post`.
- Compared per think: move `(x, rot, m)`, `act`, `garbageWait`, `useHold`, and all 15 carried OffsetOffAI state fields.

## Results

### seed 1

- Right thinks: **43**; pieces: **66**; pressure: 4; winner: left; reason: **KO**.
- Pending-garbage turns: **24**; garbageWait=1 turns: exe **2**, replica **2**.
- Exe wall time: 42s.
- **All compared fields agreed.**

### seed 2

- Right thinks: **57**; pieces: **90**; pressure: 4; winner: left; reason: **KO**.
- Pending-garbage turns: **36**; garbageWait=1 turns: exe **5**, replica **5**.
- Exe wall time: 55s.
- **All compared fields agreed.**

### seed 7

- Right thinks: **70**; pieces: **108**; pressure: 4; winner: left; reason: **KO**.
- Pending-garbage turns: **35**; garbageWait=1 turns: exe **3**, replica **3**.
- Exe wall time: 68s.
- **All compared fields agreed.**

## Artifacts

- seed 1: `stress-d4-seed1.jsonl`, `stress-d4-summary-seed1.jsonl`
- seed 2: `stress-d4-seed2.jsonl`, `stress-d4-summary-seed2.jsonl`
- seed 7: `stress-d4-seed7.jsonl`, `stress-d4-summary-seed7.jsonl`
