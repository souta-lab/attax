# Independent real-time timing (async lock model) — measurement

Base revision: `ce7be3bdc19335cd574ee08df7228452354b870c` (working tree, no commit).

**Question.** The versus harness gives both fighters one shared 120 ms step budget
(`stepSide` + issue-#24 terminal-only accounting), so after #24 both sides lock exactly one
piece per 120 ms of the global clock. Hypothesis: a real match runs each player on their own
timeline, so Hoiko's win rate might improve when each side locks on its own
decision + input schedule. This directory records the implementation and the honest
measurement.

**Verdict: no improvement.** Under every independent-timing arm the faithful Hoiko wins
**fewer or the same** number of the 32 fixed-seed gate matches as under the shared model
(9 → 8 / 7 / 7), the paired differences are not significant (exact McNemar p ≥ 0.30), and
Hoiko's per-match output (lines, sent, locks) drops 5–10 %. The dominant factor in the
real-time model is each engine's relative per-decision speed: this repo's wasm Hoiko replica
decides in ~32 ms vs wasm DeepSeek's ~26 ms at the gate config (`HOIKO_BEAM=150`), so Hoiko
locks ~4 % slower and loses ~5 % more pieces. Details and caveats below.

## Model

`src/versus/controller.ts`, `VersusControllerOptions` (all optional, default = shared):

- `timing: "shared"` (**default**) — unchanged legacy model. Both sides use
  `stepIntervalMs = 120` as the terminal-step budget of the single global clock.
- `timing: "independent"` — each side has its own accumulator (`side.acc`) and its own
  per-piece latency. When a decision produces a plan, the controller latches
  `nextLockLatencyMs`:
  - `fixedLeftLatencyMs` / `fixedRightLatencyMs` when provided (deterministic proxy), else
  - `inputLatencyMs` (default 120) + the real ms measured around that side's own
    `findBestMove` call (`side.lastDecisionMs`).
  The side locks only when its own `acc >= nextLockLatencyMs`; a terminal action (lock or
  hold) consumes that latency, cosmetic steps stay free (issue-#24 semantics preserved).
  At most one lock per side per tick (unchanged). Garbage exchange still happens per tick
  after both sides step; `garbageDelay` / `garbageAligned` and the engine are untouched.
  The side's decision cost is charged as simulated time for the piece it produced, i.e. a
  slower decider loses game time — the point of the experiment.

`shared` is exactly `independent` with zero decision time and a single shared accumulator
(confirmed empirically by the fixed-equal arm below).

## Gate exposure

`scripts/gate-v2.ts` env knobs (recorded in every `HOIKO-config` / `HOIKO-summary` line):

| Env | Meaning | Default |
|---|---|---|
| `VERSUS_TIMING` | `shared` \| `independent` | `shared` |
| `VERSUS_INPUT_MS` | fixed per-piece input/reaction cost (independent only) | `120` |
| `VERSUS_LATENCY_LEFT_MS` | fixed total latency for DeepSeek (deterministic run) | unset |
| `VERSUS_LATENCY_RIGHT_MS` | fixed total latency for Hoiko (deterministic run) | unset |

## Determinism decision

The measured model is **nondeterministic** by construction (real `performance.now()` enters
simulated timing). Seed 1, four separate runs of the same command:

| run | winner | ticks | locks L/R |
|---|---|---|---|
| measured-1 artifact | DeepSeek | 916 | 81/76 |
| measured-2 artifact | DeepSeek | 1141 | 106/86 |
| ad-hoc A | Hoiko | 852 | 78/66 |
| ad-hoc B | DeepSeek | 1251 | — |

Because of that, the *repeatable* measurement uses **fixed per-side latencies** calibrated
from the measured runs' average decision times:
`146 = 120 + 26` (DeepSeek) and `152 = 120 + 32` (Hoiko). A repeat of the fixed run is
byte-identical after removing the wall-clock `thinkMs`/`thinkCount` metric fields
(checked programmatically). The measured model is reported as a second, noisy estimate.

## Commands

```bash
# shared baseline (deterministic)
env DSV2_RUST=1 HOIKO_ADAPT=0 bun scripts/gate-v2.ts > evidence/hoiko-async/shared.jsonl

# measured independent x2 (single process, machine otherwise idle)
env DSV2_RUST=1 HOIKO_ADAPT=0 VERSUS_TIMING=independent \
  bun scripts/gate-v2.ts > evidence/hoiko-async/independent-measured-1.jsonl
# ... independent-measured-2.jsonl identical command

# deterministic independent arms (4 shards, HOIKO_SHARD_INDEX/COUNT, merged in seed order)
env DSV2_RUST=1 HOIKO_ADAPT=0 VERSUS_TIMING=independent VERSUS_INPUT_MS=120 \
  VERSUS_LATENCY_LEFT_MS=146 VERSUS_LATENCY_RIGHT_MS=152 \
  HOIKO_SHARD_INDEX=$i HOIKO_SHARD_COUNT=4 bun scripts/gate-v2.ts   # fixed-calibrated (+ repeat)

# controls: equal rates / Hoiko 15 ms faster / Hoiko at shipping-exe speed / input sensitivity
VERSUS_LATENCY_LEFT_MS=146 VERSUS_LATENCY_RIGHT_MS=146   # fixed-equal
VERSUS_LATENCY_LEFT_MS=146 VERSUS_LATENCY_RIGHT_MS=131   # fixed-hoiko-faster
VERSUS_LATENCY_LEFT_MS=146 VERSUS_LATENCY_RIGHT_MS=221   # fixed-shipping-hoiko (120 + binary ~101 ms/move)
VERSUS_INPUT_MS=60  VERSUS_LATENCY_LEFT_MS=86  VERSUS_LATENCY_RIGHT_MS=92    # input=60
VERSUS_INPUT_MS=240 VERSUS_LATENCY_LEFT_MS=266 VERSUS_LATENCY_RIGHT_MS=272   # input=240
```

## 32-seed gate results (`DSV2_RUST=1 HOIKO_ADAPT=0`, fixed seed corpus)

W-L = DeepSeek left / Hoiko right. `ms/mv` is the in-run average decision cost.

| run | W-L | lines L/R | sent L/R | tetris L/R | locks L/R | maxHeight L/R | holes L/R | ms/mv L/R | ticks | pieces |
|---|---|---|---|---|---|---|---|---|---|---|
| shared (baseline) | **23-9** | 1630/1258 | 852/936 | 54/126 | 2901/2594 | 536/594 | 451/451 | 25.8/32.0 | 26191 | 5495 |
| measured independent #1 | **24-8** | 1537/1126 | 898/850 | 67/119 | 2728/2319 | 508/595 | 418/450 | 26.6/32.3 | 30174 | 5047 |
| measured independent #2 | **25-7** | 1402/1015 | 762/753 | 58/101 | 2574/2192 | 492/604 | 387/438 | 25.9/32.1 | 28417 | 4766 |
| fixed-calibrated 146/152 | **25-7** | 1579/1187 | 872/864 | 63/124 | 2850/2444 | 499/595 | 412/436 | 27.7/33.3 | 31305 | 5294 |
| fixed-calibrated repeat | **25-7** | 1579/1187 | 872/864 | 63/124 | 2850/2444 | 499/595 | 412/436 | 27.3/32.6 | 31305 | 5294 |
| fixed-equal 146/146 | **23-9** | 1630/1258 | 852/936 | 54/126 | 2901/2594 | 536/594 | 451/451 | 26.7/33.0 | 31871 | 5495 |
| fixed-hoiko-faster 146/131 | **18-14** | 1540/1318 | 821/985 | 61/125 | 2684/2657 | 550/585 | 461/460 | 27.2/32.5 | 29611 | 5341 |
| fixed-shipping-hoiko 146/221 | **30-2** | 1538/863 | 885/602 | 66/83 | 2975/1750 | 452/629 | 360/469 | 27.5/34.1 | 32658 | 4725 |
| fixed input=60 (86/92) | 24-8 | 1501/1098 | 863/797 | — | 2742/2238 | — | — | 27.4/34.2 | — | — |
| fixed input=240 (266/272) | 22-10 | 1479/1129 | 832/845 | — | 2657/2302 | — | — | 27.5/34.1 | — | — |

Reading the table:

- **fixed-equal is event-identical to shared** on every metric (same per-seed winners,
  lines, sent, locks, pieces) — only the simulated clock rate differs. Because both sides
  share `dt` and the same interval they stay phase-locked, so this arm is an *absolute-speed
  invariance* control, not a desynchronization test.
- Arms with different per-side intervals (calibrated, hoiko-faster, shipping) are genuinely
  out of phase and change per-seed outcomes.
- **fixed-calibrated result is exactly repeatable** (two sharded runs, identical after
  stripping wall-clock `thinkMs`).
- **fixed-hoiko-faster** shows the harness does respond to tempo: giving Hoiko 15 ms/piece
  over DeepSeek flips the matchup to 18-14. The reverse (shipping-exe speed, +75 ms/piece)
  collapses Hoiko to 2-30.
- Input-cost sensitivity (60/120/240 ms) gives Hoiko 8/7/10 wins — all within noise, i.e.
  the free parameter does not rescue the hypothesis.

### Paired comparison vs shared (exact McNemar on the 32 fixed seeds)

| arm | Hoiko gains | Hoiko loses | p |
|---|---|---|---|
| measured #1 | 5 | 6 | 1.000 |
| measured #2 | 3 | 5 | 0.727 |
| fixed-calibrated 146/152 | 5 | 7 | 0.774 |
| fixed-equal 146/146 | 0 | 0 | 1.000 |
| fixed-hoiko-faster 146/131 | 10 | 5 | 0.302 |
| fixed-shipping-hoiko 146/221 | 2 | 9 | 0.065 |
| input=60 | 6 | 7 | 1.000 |
| input=240 | 6 | 5 | 1.000 |

95 % Wilson intervals for Hoiko's win rate: shared 9/32 = 28.1 % [15.6, 45.4],
measured #1 8/32 = 25.0 % [13.3, 42.1], measured #2 7/32 = 21.9 % [11.0, 38.8].

### Per-seed winners

`per-seed.jsonl` has the full grid (winner/ticks/pieces/lines/sent/locks per run).
Winner matrix (`D` = DeepSeek, `H` = Hoiko):

```
seed  shared measured1 measured2 fixed-cal fixed-equal fixed-hoiko-fast fixed-shipping input60 input240
   1       H        D         H         D           H              H             D         H        D
   2       D        D         D         D           D              H             D         H        D
   3       D        D         D         D           D              D             D         D        D
   5       D        H         H         D           D              D             D         D        D
   7       H        D         D         D           H              D             D         D        D
  11       D        D         D         D           D              D             D         D        D
  13       D        H         D         D           D              H             D         D        D
  17       D        D         D         H           D              D             D         H        D
  19       D        D         D         D           D              H             D         D        D
  23       H        D         D         D           H              H             D         D        H
  29       D        D         D         D           D              H             D         D        H
  31       D        D         D         H           D              D             D         D        D
  37       D        D         D         D           D              D             D         H        D
  41       D        D         D         D           D              D             D         D        D
  42       H        H         H         D           H              D             D         H        H
  43       H        H         H         D           H              D             D         D        H
  47       D        H         H         H           D              H             D         H        H
  53       D        D         D         D           D              H             H         D        D
  59       D        H         D         D           D              D             D         H        H
  61       H        H         H         H           H              H             D         D        D
  67       H        D         D         D           H              D             D         D        H
  71       D        D         D         D           D              D             D         D        D
  73       H        D         D         D           H              D             D         D        D
  79       D        D         D         D           D              H             D         H        D
  83       D        D         D         H           D              D             D         D        D
  89       D        H         H         H           D              D             D         D        H
  97       D        D         D         D           D              D             H         D        D
  99       D        D         D         D           D              D             D         D        D
 777       D        D         D         D           D              H             D         D        H
1234       D        D         D         D           D              H             D         D        H
5555       H        D         D         H           H              H             D         D        D
9001       D        D         D         D           D              H             D         D        D
```

## Fresh-seed sweep (`scripts/strength-sweep.ts`, seeds 301…367, `d7-w24-beam500`, adapt 0)

| run | W-L | lines D/H | sent D/H | ms/mv D/H |
|---|---|---|---|---|
| shared | 12-0 | 667/493 | 381/315 | 34.8/141.0 |
| fixed independent, latencies calibrated to that config (155/261) | 12-0 | 474/227 | 275/158 | 32.3/134.5 |
| measured independent (6 workers in parallel) | 11-1 | 551/273 | 306/194 | 33.3/136.4 |

The sweep makes the mechanism explicit: beam 500 costs Hoiko ~141 ms/decision, so under
real-time timing its output roughly halves (lines 493→227, sent 315→158). The shared model
masks this entirely; that is precisely the dynamic the user hypothesized — but it works
*against* the faithful Hoiko in this port, not for it.

## Native mirror (`rust/game` + `rust/hoiko-app`)

The timing model is ported 1:1 into the native controller — same option fields
(`timing`, `input_latency_ms`, `fixed_left_latency_ms`, `fixed_right_latency_ms`), same
`next_lock_latency_ms` latching at decision time, `VersusTiming::Shared` as the default — with
five ported tests in `rust/game/src/versus/tests.rs` (per-side rates, fixed override, measured
decision on top of input via an injected clock, cosmetic steps free, shared unchanged). The
existing `differential_versus.rs` fixture replays TS-recorded decisions under the shared
default and still passes, confirming the port is event-compatible.

The native app exposes the knobs in both modes:

```bash
hoiko-app --timing independent --input-ms 60 [--latency-left-ms N] [--latency-right-ms N]
hoiko-app --headless --timing independent --input-ms 60 ... [--json]
```

The spectator window shows the active mode next to the speed buttons and re-applies it when
the speed changes; `--headless --json` records the timing block in `NATIVE-config`.
`--latency-left-ms`/`--latency-right-ms` are positional (left/right board), so in the native
app they pin HOIKO (left) / DEEPSEEK (right) — the mirror image of the gate, where left is
DeepSeek.

The 32-seed numbers above are the **TS/wasm gate** measurement. The native app was not
re-measured: it runs the native engines on a wall clock, so its absolute decision costs (and
therefore any real-time ranking) differ from the wasm gate by construction.

## Why this is the honest answer

- The hypothesis was that desynchronized timelines let Hoiko attack before DeepSeek reacts.
  The harness does produce different per-seed outcomes (only 20–24 of 32 seeds keep the
  shared winner), but paired significance tests show no systematic Hoiko gain
  (p = 0.73–1.00), and point estimates move the other way.
- The real-time model converts per-decision compute into lock rate. This repo's wasm Hoiko
  is ~20–25 % slower per decision than wasm DeepSeek at beam 150 (32 vs 26 ms), so it loses
  tempo. If Hoiko is instead given a 15 ms/piece advantage, it jumps to 14 wins — the model
  is responsive; our engine just is not the faster one.
- The **shipping binary is ~101 ms/move** (`rust/README.md`: native port ≈62–66 ms at depth
  14) versus ~32 ms for this wasm replica. A faithful real-time match against the exe would
  put Hoiko at the `146/221` arm → 2-30. The independent-timing question therefore cannot be
  answered for the real exe from this port; it can only say the *replica* does not improve.
- Caveats: ±2-seed differences in the fixed arms are single deterministic draws, not
  repeated samples, and 16 ms tick quantization partially washes out rate gaps under ~8 %.
  The input-cost parameter (60/120/240) shifts the result within noise.

## Verification

At base revision with these changes (no commit, per the task):

- `bun test` → 128 pass / 0 fail (4 new independent-timing tests;
  `tests/versus-controller.test.ts`).
- `bunx tsc --noEmit`, `bun run lint` → clean.
- `bun run build` → green.
- Shared-mode aggregates are byte-identical to `evidence/hoiko-inputs/audit/gate32-final-adapt0.jsonl`
  (23-9; ticks 26191; pieces 5495; lines 1630/1258; locks 2901/2594) — the harness change did
  not alter the existing model.

## Raw artifacts

| file | contents |
|---|---|
| `shared.jsonl` | shared baseline, 32 matches + summary |
| `independent-measured-1.jsonl`, `independent-measured-2.jsonl` | measured real-time runs |
| `fixed-calibrated.jsonl`, `fixed-calibrated-repeat.jsonl` | deterministic 146/152 (+ repeat) |
| `fixed-equal.jsonl` | 146/146 speed-invariance control |
| `fixed-hoiko-faster.jsonl` | 146/131 tempo dose-response |
| `fixed-shipping-hoiko.jsonl` | 146/221 (binary-speed proxy) |
| `fixed-input60.jsonl`, `fixed-input240.jsonl` | input-cost sensitivity |
| `sweep-shared.jsonl`, `sweep-fixed.jsonl`, `sweep-measured.jsonl` | fresh-seed sweeps |
| `per-seed.jsonl` | machine-readable per-seed grid across all runs |
| `*.stderr` | empty on success (kept for completeness) |
