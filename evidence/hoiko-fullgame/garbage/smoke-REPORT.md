# Versus garbage/OffsetAI differential — shipping Hoiko.exe vs Rust/WASM replica

Run: 2026-09-12T11:47:43.717Z
Args: seeds=1 cap=24 maxTicks=20000 tick=16 name=smoke

## Verdict

**FULL AGREEMENT on all 1 seed(s): 17 thinks (seed 1)**

## Setup

- Right fighter: one fresh `Hoiko.exe` (Wine oracle stub) per think, `timer=1` (depth 14, beam 150), `adapt:false`-equivalent.
- Right replica: persistent `createRustHoiko({...FAITHFUL_HOIKO, adapt:false})`, queried on the identical snapshot each think.
- Left fighter: Rust/WASM DeepSeek v2 (generates attacks/garbage); engine `src/core/engine.ts` seeded per seed, `resolveVersusConfig()` (aligned garbage, 1-lock delay).
- Exe input per think: board(32 bottom-up) + next(28, current first) + hold + combo + b2b + timer=1 + garbage + nowms + iseven + sync=1 + offsetenabled=1 + carried `useoffset/ofs*/gb*/haslast*` + own/opp lock sync fields.
- Stub applies the carried OffsetOffAI statics at native RVAs (0x6638C/0x66390/0x663A0), mirrors `offset_driver.rs::sync`, runs `SearchAI.Search`, then `DecisionOffsetOff` + `IsLocked`/`CanOffsetOff` and prints `garbageWait` + `OFFSET post`.
- Compared per think: move `(x, rot, m)`, `act`, `garbageWait`, `useHold`, and all 15 carried OffsetOffAI state fields.

## Results

### seed 1

- Right thinks: **17**; pieces: **24**; winner: n/a; reason: **cap**.
- Pending-garbage turns: **0**; garbageWait=1 turns: exe **0**, replica **0**.
- Exe wall time: 6s.
- **All compared fields agreed.**

## Artifacts

- seed 1: `smoke-seed1.jsonl`, `smoke-summary-seed1.jsonl`
