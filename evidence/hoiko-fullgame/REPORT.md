# Full-game differential — shipping Hoiko.exe vs Rust/WASM replica

Run: `seed1-cap500` (seed 1, cap 500, design A per-move wine invocation).

## Verdict

**N/500 moves matched: exe and rust (x,rot,m) agreed on all 500 pieces (no divergence, cap reached)**

## Setup

- Exe: shipping `Hoiko.exe` under Wine, one fresh process per move via `tools/hoiko-oracle/run_oracle.sh`.
- Exe inputs per move: `board` (32 bottom-up rows), `next` (28: current first), `hold`, `combo`, `b2b`, `timer=1`.
- Exe regime: `beamSizeLimit=150`, depth 14 (timer started, search ~70 ms << 1000 ms limit).
- Replica (primary verdict): `createRustHoiko({...FAITHFUL_HOIKO, adapt:false})` — beam 150, depth 14, queried on the identical snapshot.
- Replica (secondary): faithful `adapt:true` app config, persistent across moves; recorded but not part of the verdict.
- Local game: `src/core/engine.ts` with `seededRandom(seed)`; the exe's chosen move is applied via `placeMinoAt` (+ `hold()` when the exe's post-move hold slot shows a swap).

## Results

- Moves played: **500**; verdict-matched: **500**.
- First divergence: none.
- Engine-vs-exe state mismatches (board/hold after applying the exe move): **0**.
- act mismatches (with matching move): **0**.
- faithful (adapt:true) replica move mismatches vs exe: **80**.

Artifacts:

- `seed1-cap500.jsonl` — per-move raw records (snapshot, exe, rust, rustAdapt, state).
- `summary-seed1-cap500.jsonl` — machine-readable summary (one JSON object).

