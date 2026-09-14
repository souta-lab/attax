# Native game core — Phase 1 differential evidence

Phase 1 ports the browser game + versus engine from TypeScript to the new Rust
crate `rust/game` so the native Rust/egui app (DeepSeek-Rust vs RustHoiko) can
run without WASM/Chromium, and a future web build can consume the same core.

The TS reference is the oracle: `tools/game-diff/reference.ts` runs
`src/core/engine.ts` and `src/versus/controller.ts` (plus the Hoiko
input-contract helpers) over deterministic scripts and writes the fixtures in
this directory. `rust/game/tests/differential*.rs` replays the recorded
operations/decisions and asserts identical state.

## Commands

```bash
# 1. regenerate the TS oracle fixtures (after any TS behavior change)
bun tools/game-diff/reference.ts

# 2. replay them on the Rust core
cargo test --manifest-path rust/Cargo.toml -p game

# full workspace gate
cargo test --manifest-path rust/Cargo.toml
```

Last recorded results (HEAD `8411c87` + the Phase 1 working tree):

| Gate | Result |
|---|---|
| `cargo test --manifest-path rust/Cargo.toml` | green (110 game tests + 68 existing hoiko/deepseek tests) |
| `cargo test -p game --test differential` | 2 passed (aligned + per-row engine traces) |
| `cargo test -p game --test differential_versus` | 1 passed (3 scenarios, 332 recorded decisions) |
| `cargo test -p game --test differential_contract` | 4 passed (next state, opponent flags, faithful config, bridge) |
| `bunx tsc --noEmit` | green |
| `bun test` | 124 pass / 0 fail (20 files) |
| `bun run build` | green |
| `bun run lint` | green (130 files) |

## Coverage

### Engine differential (`engine-aligned.json`, `engine-per-row.json`)

Four normal traces per garbage mode (seeds 1, 7, 12345) plus one chaos trace
(seed 99) each, replayed op by op. Every op asserts the full snapshot (game
over, lock id, active kind/rotation/x/y, ghost row, hold, canHold, pending
garbage, lines, combo, native combo/Btb, score, action, attack/blocked values,
board fingerprint, next queue) and, on every lock, the lock transition
(post-clear board, cleared lines, garbage rows applied, action, combo/Btb,
raw/sent attack).

Observed per normal trace (TS reference): 30–49 locks, 3–8 clear locks
(singles and doubles), 2–4 locks that apply spawned garbage rows, score lines
up to 9. The chaos traces drive random `placeMinoAt`/`hardDropAt` arguments to
cover lock-outs, game-over latches and post-game-over no-ops.

### Versus differential (`versus.json`)

Three scenarios (seeds 1, 12345, 4294967295) run the real controller to a match
result. The TS-side greedy placement fighter records every AI decision
(call index, snapshot lock id, hold flag, x/rotation/topRow/lastSrs,
garbageWait); Rust replays them by index through a recorded-decision fighter,
so no decision logic is re-implemented. Each scenario asserts every lock event
(tick, piece count, both sides' lock id/game over/lines/pending/sent/blocked/
board fingerprint/last action), the tick count, the final `VersusResult`, and
the execution counters.

Observed: 102–118 locks per match, 390–450 ticks, 52–60 lock events, KO results
(one draw in the third seed), `sent` 1 on each side (garbage exchange exercised),
0 execution source mismatches, 0 expected-board failures. A generator guard
fails if a fixture stops exercising garbage exchange or never reaches a result.

### Contract differential (`contract.json`)

- `NextState`: seven sequences including the exe-stub golden vectors
  (`NextMino.Init`, `ShiftNext`+`Compare` dumps, full-array carry, per-turn
  `SetPPTData` composition, bag cursor) — the Rust port reproduces the exe
  values recorded in `tests/hoiko-next.test.ts`.
- Opponent flags: the `versus-inputs.ts` derivation corpus (12 boards x 6
  combo/garbage inputs = 72 cases) for `opponentIsPCBoard` /
  `opponentIsPowerfulBoard`.
- Faithful config: `FAITHFUL_HOIKO` constant and five env resolutions
  (`HOIKO_BEAM`, `HOIKO_ADAPT`, preset switch, full optional set).
- Bridge: `frameStepMs` rounding and `boardToNativeRows` orientation over all
  12 corpus boards.

## Port map (TS -> `rust/game`)

| TS source | Rust module |
|---|---|
| `src/ui/types.ts` | `types.rs` |
| `src/core/board.ts` | `board.rs` |
| `src/core/pieces.ts` | `pieces.rs` |
| `src/core/srs.ts` | `srs.rs` |
| `src/core/tspin.ts` | `tspin.rs` |
| `src/core/garbage.ts` | `garbage.rs` |
| `src/core/engine.ts` | `engine/` (`mod`, `spawn`, `lock`, `actions`, `tests`) |
| `src/versus/controller.ts`, `config.ts`, `speed.ts` | `versus/` (`mod`, `state`, `controller`, `flow`, `step`, `tests`) |
| `src/ai/hoiko-faithful.ts` | `contract/faithful.rs` |
| `src/ai/hoiko-next.ts` | `contract/next.rs` |
| `src/ai/hoiko-opponent.ts` | `contract/opponent.rs` |
| `hoiko-rust-core.ts` snapshot mapping | `contract/bridge.rs` |
| `src/versus/controller.ts` RNG (`seededRandom`) | `rng.rs` |

The crate injects randomness (`Rng`/`SeededRng`) and the controller clock
(`set_clock`/`set_seed_source`); it has no OS, thread or wall-clock dependency
and no `unsafe` (`#![forbid(unsafe_code)]`).

## Honest gaps

- The differential drives the *controller* with a recorded scripted fighter,
  not the real DeepSeek/Hoiko engines. Wiring those engines into the native app
  is Phase 2; the game side exposes the snapshot/execution contract they need
  (`contract::bridge`, `AiFighter`, `AiExecutionPlan`).
- `move_from_out` (mapping a Hoiko `SearchOutcome` to an `AiMove`) is app-side:
  it depends on the `hoiko-core` search types and is not part of the game core.
- Auto-rematch seeds: TS uses `Date.now() ^ Math.random()`; the Rust controller
  uses an injected `seed_source` (default a deterministic LCG). The differential
  stops at the result and the rematch countdown is covered by unit tests.
- `think_ms` is wall-clock telemetry in TS and is zero with the default clock
  injected in tests; it is deliberately not compared.
- `last_error`/`error_count` exist for API parity but Rust fighters cannot
  throw, so they are never set (TS catches fighter exceptions).
- `readEnv*` accepts JS `Number()` forms (hex/octal/binary/Infinity) and rejects
  non-integers with the same messages; exotic whitespace/NaN forms beyond that
  are not replicated.

---

# Native app — Phase 2/3 evidence (native fighters + egui/headless)

Phase 2 adds `rust/ai-fighters`: the native host side of both engines, without
wasm. Phase 3 adds `rust/hoiko-app`: an egui 0.36 spectator window plus a
`--headless` mode. The game core (`rust/game`) and both engines
(`hoiko-core`, `deepseek-rust`) are unchanged.

## Adapters (host logic only, no decision changes)

| TS host | Rust module | Notes |
|---|---|---|
| `hoiko-rust-core.ts` | `ai-fighters/src/hoiko.rs` | calls the safe `hoiko_core::ffi::run_search_ffi` (the function the wasm `h_search` wraps); carries NextMino, weight row, beam/timer state, all 15 `OffsetOffAI` fields and the frame clock; builds the request through `game::contract::bridge`; host-side `SetNextOption` adaptation with an injectable clock |
| `deepseek-rust-core.ts` | `ai-fighters/src/deepseek.rs` | `find_best_move_v2_details` -> `placeAt` (landing row + `is_v2_tspin`), hold moves, opponent telemetry, 1-based per-think piece counter |
| `hoiko-weights.ts` | `ai-fighters/src/presets/presets_data.rs` | generated by `bun tools/native-app/dump-rust-presets.ts`; `tests/presets.rs` asserts it against `hoiko-weights.json` |

## Verification results

1. **Fighter differential** (`fighter-differential.json`, 5 seeds, reduced
   depth/beam so the suite stays fast): TS-wasm fighters record every decision;
   the native replay asserts useHold / x / rotation / topRow / lastSrs /
   garbageWait per decision plus the final boards, result and execution
   counters. Result: **946/946 decisions and 5/5 matches identical**.
   `cargo test -p ai-fighters --test fighter_differential` (~19 s debug).
2. **Gate equivalence** (32-seed corpus, `HOIKO_ADAPT=0 DSV2_RUST=1`):
   `bun scripts/gate-v2.ts` -> **23-9-0/0**, fingerprint `414e9451` (identical to
   `evidence/hoiko-inputs/audit/gate32-final-adapt0.jsonl`).
   `hoiko-app --headless` over the same seeds -> **23-9-0/0 with 32/32 identical
   winners and ticks / pieces / lines / sent / locks / mismatch counters**, 0
   execution mismatches, 0 board failures, no caps.
   Evidence: `native-gate32-adapt0.jsonl` + `gate32-adapt0.jsonl`, locked by
   `cargo test -p ai-fighters --test gate_equivalence`.
3. **Rust tests**: reduced-config headless matches terminate cleanly and are
   deterministic; weight-preset fixture; CLI parsing/help; headless smoke
   (`cargo test --manifest-path rust/Cargo.toml`).

## Commands

```bash
# regenerate the TS oracle fixtures
bun tools/native-app/dump-weights.ts
bun tools/native-app/dump-rust-presets.ts
bun tools/native-app/dump-fighter-differential.ts

# native headless (deterministic gate config: adapt off)
./rust/target/release/hoiko-app --headless --seeds 1 --json
./rust/target/release/hoiko-app --headless --seeds 1,2,3 --frames 12000

# reference gate for the comparison
HOIKO_ADAPT=0 DSV2_RUST=1 bun scripts/gate-v2.ts

# spectator window
cargo run --release -p hoiko-app
```

## Honest gaps

- The window's default config is the faithful one (`adapt = true`, wall-clock
  `SetNextOption`), so its outcomes are not machine-reproducible — exactly like
  the shipping binary's. Headless defaults to `adapt = false` (the deterministic
  23-9 gate config); `--hoiko-adapt 1` opts into the faithful adaptive path.
- Searches run on the UI thread: a depth-14 think (~60–160 ms native) blocks a
  frame, so the board advances in visible steps rather than smoothly.
- The default egui fonts have no CJK glyphs, so the draw reason ("同時死亡") is
  shown as "double KO"; the headless JSON keeps the raw reason string.
