# S2 stage 1 implementation

Select the opt-in core profile with `createEngine({ rulesProfile: "tetrio-s2" })`.
The default remains `guideline`. No AI, search, weights, Hoiko, versus or UI source
was changed. This is a lock-award profile, not a claim of full official controller
or packet-delivery fidelity.

## Files

- `src/core/rules.ts`: profile dimensions, S2 combo formula, surge charge and lock awards.
- `src/core/s2-spin.ts`: separate All-Mini+ classifier; guideline classifier is untouched.
- `src/core/engine.ts`: profile selection, dimensions, classifier and award integration;
  S2 inactive native combo is zero, guideline retains its signed binary convention.
- `src/core/types.ts`: optional released-surge total on lock receipts (S2 only).
- `tests/tetrio-s2.test.ts`: 12 specification-referenced tests.
- `bench-results/s2-stage1-guideline-smoke.jsonl` and
  `bench-results/s2-stage1-rules-audit.json`: guideline regression evidence.
- `dist/index.html` and generated JS assets: rebuilt static bundle.
- This report.

## Implemented mechanics and references

References below are exact headings in `../attax-s2/S2-SPEC.md`, except board
geometry, which the task explicitly requests and the recon pins separately.

- **Attack table and complete combo rule**: ordinary 0/0/1/2/4, full T 2/4/6,
  mini 0/1/2, continued difficult-clear +1 before combo, separate PC +5 after
  combo, and zero attack for no clear. The full unbounded combo formula uses
  `floor(max(a*(1+0.25*c), ln(1+1.25*c)))`, with the logarithmic floor only at c>=2.
- **B2B charging and surge**: one-based difficult-clear chain d, displayed b=d-1;
  every qualifying clear (including PC) advances once, blanks preserve it,
  ordinary breaking clears reset and release b when b>=4. Continued clears get
  flat +1; breaking clears do not. Surge total is exposed separately on receipts.
- **Spin detection: All-Mini versus All-Mini+**: post-1.5 All-Mini+ selected.
  T three corners, facing-corner full/mini distinction and fifth quarter-turn
  kick promotion; all seven pieces, including O and fallback T, can receive an
  immobile mini after rotation. Classification uses the pre-lock board so the
  active piece cannot obstruct its own translation checks.
- **LAB-RECON, Timing and adapter requirements**: 10x40 stored board, 20 visible
  rows in profile metadata; snapshots, collision, clears, garbage storage and
  lock receipts use the selected height. Existing 20-row guideline is retained.

## Validation

- Typecheck (`bun x tsc --noEmit`), full `bun test`, `bun run lint`, and
  `bun run build`: passed. Bun is installed at `/opt/hatch-image/bin/bun`;
  `bun x` supplies the missing `bunx` shell entry point.
- New tests cover every attack row, all 72 sampled combo-chart cells plus high
  combos, PC stacking/nonduplication, surge boundaries and breaking/preserving
  events, T orientations/minis/fifth kick/walls, every-piece immobility in all
  four directions, required rotation evidence, board height/reset, and an
  engine-executed clear followed by an inactive combo reset.
- Guideline smoke benchmark: seed 2001, both seats, adaptation disabled. This is
  regression evidence only; it does not replace or alter headline results.
- Hoiko audit: seed 3001, all 39 audited locks agree. Existing move-generation
  reachability test passes unchanged.
- Rust was not touched. No commit was made.

## Explicit remaining gates (no invented official values)

All are marked TODO in core with `S2-SPEC Unpinned` references:

- **#2**: exact integer partition of surge into three packets. Core computes
  total charge/release only; no lab partition was copied.
- **#3**: official packet holes/RNG, confirmation/arrival/travel and surge-only
  delay. Existing scalar outbox/cancellation/delivery is retained provisionally;
  it does not implement the official three-packet contract.
- **#4**: official margin/non-integer rounding, stage order and per-chunk opener
  cancellation boundaries. Awards here cover multiplier 1 only.
- **#5**: failed inputs, zero-distance/moving hard drops, 180 kick IDs and
  executable immobile-T precedence fixtures. Existing engine history is
  provisional; fifth-kick input is a quarter-turn ordinal, not a 180 ID.
- **#6**: exact hidden/hold spawn coordinates, Clutch order, garbage ARE and
  blockout checks. Existing legacy spawn/controller behavior is retained;
  board storage dimensions do not certify spawn fidelity.
- **#7**: official intake/margin constants and internal numeric storage caps.
  No artificial surge cap was introduced.
- **#8**: exotic spin Quads/higher clears need a legal witness and pinned damage
  row. The S2 award function throws for these instead of assigning lab damage 10.

**#1 is resolved**, not a TODO: official 1.1.1/1.2.0 wins over the stale wiki PC
paragraph, so a PC advances B2B exactly once. Garbage special bonus and opener
phase controller work are outside this stage's requested attack/charge/combo/
spin/board scope; they have not been represented as completed S2 behavior.
