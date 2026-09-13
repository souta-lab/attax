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
