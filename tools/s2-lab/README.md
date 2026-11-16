# S2 placement-lab harness

Run from the attax repository root with Bun (tested with 1.4.4):

```sh
bun tools/s2-lab/run-match.mjs --games 1 --seed 42 --out /tmp/attax-s2.jsonl
```

`--games N` uses seeds S through S+N-1 and alternates attax left/right, starting
left. Output is **append-only JSONL**. `--max-locks 1000` caps total locks across
both players; a simultaneous event is never split to fit the cap. Capped games
are `unfinished`, with `winner: null`. Infrastructure/protocol errors produce
an `error` record and a nonzero exit, then stop the set. A terminal draw has
`status: finished`, `reason: top-out`, and `winner: null`.

The default lab checkout is `../s2-bot-lab-ref`. Override it with `S2_LAB_ROOT`.
`CC2_F14_WASM` optionally overrides the champion artifact path; the default is
`bot/cold-clear-2-s2/target/wasm32-unknown-unknown/release/cold_clear_2_s2.wasm`
inside that checkout. Install/build the lab's dependencies and artifact using
its documented instructions. This harness never edits lab source.

Champion self-play smoke, through the same lab factories/referee:

```sh
bun tools/s2-lab/run-match.mjs --games 1 --seed 42 --champion-vs-champion --out /tmp/champion-smoke.jsonl
bun test tools/s2-lab/contracts.test.ts
```

This is the lab's **legacy placement arena**, with its synthetic paced clock,
legacy-LCG queues, and zero controller delivery delay. Both players get the
champion's unchanged default cadence and 14 pieces including current. It does
not run realtime INPUT controls or certify official game fidelity. The
champion keeps its complete default profile, 2048 selections and persistent
per-game WASM session; THINK TIME, MULTITHREAD and RG remain off.

The lab searches with the shared core, `src/ai/bot/search.ts`, under rules
profile `"s2"`: unchanged beam/weights, exact difficult-chain state, staged S2
awards/classifier, amount-only root garbage, and a mandatory root-witness
filter in the runner. The former private copy (`tools/s2-lab/search.ts`) was
deleted in unify chunk 3b; `s2-input.ts` keeps the lab's input shape (numeric
exact chain in `b2b`) and its single mapping onto the shared input
(`toSharedInput`). `shared-parity.test.ts` pins both the shared search and the
player's own decision path to the pre-port goldens in `tools/unify/`.

See [STAGE2-REPORT.md](../../STAGE2-REPORT.md) for conversions, smoke evidence,
known limits, and the restricted Git metadata handoff.
