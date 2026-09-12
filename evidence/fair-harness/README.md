# Fair-harness re-baseline (issue #24)

The versus controller used to execute exactly **one queued step per `stepIntervalMs`**.
Each fighter builds its own execution plan:

- DeepSeek v2: a single `placeAt` step → locks in 1 interval.
- Hoiko adapter: `cosmeticSteps` (rotations + horizontal moves) then `placeAt`
  (`src/ai/hoiko-rust-core.ts`, function `cosmeticSteps`) → locks in `|Δx|+1` intervals.

Both sides shared `VERSUS_DEFAULTS.stepIntervalMs = 120`, so the step model acted as an
APM handicap: Hoiko locked **3–7× slower** than DeepSeek. Every pre-fix head-to-head
number (32-0 gate, 16-0/64-0/80-0 fresh seeds) was therefore an artifact of the harness,
not of decision quality (see `evidence/scan/findings.md` F1).

## Fix

`src/versus/controller.ts` `stepSide()` now charges `stepIntervalMs` only for a
**terminal** action (`locksPiece(kind)` or `kind === "hold"`). Non-terminal plan steps
(rotate/move/softDrop) are applied to the core without consuming the step budget, so both
fighters lock exactly one piece per interval regardless of plan length. The Hoiko engine's
decisions are untouched.

Regression test: `tests/versus-controller.test.ts` →
`versus controller lock fairness (issue #24) > cosmetic execution steps do not delay locks relative to a bare placeAt`
(fails pre-fix, passes post-fix).

## Honest results (32 fixed seeds, `bun scripts/gate-v2.ts`)

| Run | Engine | Hoiko beam | Result | Hoiko lines / locks | Mismatches |
|---|---|---|---|---|---|
| pre-fix | TS | 500 | **32-0-0/0** | 254 / 730 | 0 |
| post-fix | TS | 500 | **21-11-0/0** | 1073 / 2421 | 0 |
| post-fix | Rust wasm | 1500 | **21-11-0/0** | 1092 / 2417 | 0 |

Raw artifacts:

- `gate-v2-postfix-beam500-ts.jsonl` — TS v2, fair harness, beam 500 (21-11).
- `gate-v2-postfix-beam1500-rust.jsonl` — Rust wasm v2, fair harness, beam 1500 (21-11).

Beam 1500 is the shipping binary's adaptive ceiling (`beamSizeLimit = min(1500,
maxBeamSize*3)` with `maxBeamSize` clamped to [50,500]), so the result is robust to beam
width and is not an artifact of a narrow opponent.

## Fidelity caveats (not yet covered)

The oracle differentials verify only first-move + `GetDelay` on 9 synthetic positions at
depth 10/14 with preset `we` and the initial beam cap 150. They do **not** cover the
binary's in-match adaptive beam (`SetNextOption`), the ~107 ms wall-clock search budget
(wasm has no clock and always runs to `depth_limit`), high beam vs the real binary, or
full-match garbage/offset behavior. See `evidence/scan/findings.md` and
`tools/hoiko-oracle/diff/REPORT.md` §6.
