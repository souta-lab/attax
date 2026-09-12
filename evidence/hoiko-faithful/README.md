# Faithful Hoiko opponent config — measured result

First measurement of the Hoiko replica running the shipping binary's **in-match**
configuration instead of the fixed-beam overrides the gate/app used until now.

## What changed

Single source of truth: `src/ai/hoiko-faithful.ts` (`FAITHFUL_HOIKO`), derived from the
shipping binary config (`evidence/hoiko/weights/config.txt`) and its derived search
bounds:

| Field | Value | Provenance |
|---|---|---|
| `weightPreset` | `we` | config.txt `playStyle 0` |
| `maxBeamSize` | 50 | config.txt `beamSize 50` (was incorrectly defaulted to 500) |
| `beamSizeLimit` | 150 | `min(1500, threads*50*3)` initial cap |
| `adapt` | true | binary `SetNextOption` beam adaptation (was off in gate/app) |
| `depthLimit` / `viewNext` | 14 / 2 | config.txt |

The browser app now calls `createRustHoiko()` with no overrides; all harnesses
(`gate-v2`, `hoiko-gate`, `hoiko-solo`, tuner `eval-worker`) resolve through
`resolveFaithfulHoikoOptions`, which defaults to the faithful constant and only lets
`HOIKO_BEAM` (stress/ablation) and `HOIKO_ADAPT=0` (deterministic runs) override it.
Parity guard: `tests/hoiko-faithful-config.test.ts`.

## Commands

```bash
# faithful: beam 150 + SetNextOption adaptation ON
DSV2_RUST=1 bun scripts/gate-v2.ts > gate-v2-beam150-adapt.jsonl

# comparison baseline: same initial beam, adaptation OFF
DSV2_RUST=1 HOIKO_BEAM=150 HOIKO_ADAPT=0 bun scripts/gate-v2.ts > gate-v2-beam150-noadapt.jsonl
```

Machine: Intel i5-8400 (6 threads), Bun 1.4.2, Linux. `DSV2_RUST=1` (Rust wasm DeepSeek
v2) matches the app and the committed fair-harness baseline. Both runs reached the full
32 seeds with 0 caps, 0 draws, 0 execution mismatches, 0 expected-board failures.

## Results (32 fixed seeds)

| Run | Hoiko config | DSv2 wins | Hoiko wins | Hoiko lines / locks | Hoiko avg ms/decision | Adaptive beam max |
|---|---|---|---|---|---|---|
| **faithful** | beam 150 + adapt | **25** | 7 | 1182 / 2576 | 239.7 | 500 (clamp) |
| baseline | beam 150, adapt off | 22 | 10 | 943 / 2158 | 33.9 | 50 (fixed) |
| committed (fair-harness) | beam 1500, adapt off | 21 | 11 | 1092 / 2417 | 383.5 | n/a |

Fingerprints: faithful `6170045b`, baseline `ffb04fe2`.

## Honest verdict

- **DeepSeek v2 still wins under the faithful config: 25-7** — a larger margin than the
  committed 21-11. The honest gate result is unchanged in direction and not a regression.
- The faithful adaptive replica is **weaker in this harness** than both fixed-beam
  replicas (7 wins vs 10 at beam 150 and 11 at beam 1500), even though adaptation raised
  the average search effort 7x (33.9 -> 239.7 ms/decision) and the coefficient saturated
  at its [50,500] clamp. It cleared more lines (1182 vs 1092) but also ended with higher
  stacks (sum `maxHeight` 605 vs 570).
- **Adaptation is wall-clock dependent by construction**: `SetNextOption` is driven by
  real elapsed search time, so the effective beam trajectory depends on the CPU and
  machine load. On this machine it was stable — the 4-seed probe (`1,5555,13,37`) gave
  identical winners in two consecutive runs, and those four outcomes match the full run
  (`probe-adapt-runA.jsonl`, `probe-adapt-runB.jsonl`). A different CPU or loaded machine
  will adapt differently; treat the 25-7 as "this machine, this load".

## Raw artifacts

- `gate-v2-beam150-adapt.jsonl` — faithful run (25-7).
- `gate-v2-faithful-verify.jsonl` — independent re-run of the faithful config by the
  orchestrator; same outcome **25-7** (fingerprint `8fb97094`, `adaptiveBeamMax 500`),
  confirming the result reproduces on this machine.
- `gate-v2-beam150-noadapt.jsonl` — beam-150/no-adaptation baseline (22-10).
- `probe-adapt-runA.jsonl`, `probe-adapt-runB.jsonl` — same-config repeatability probe.
