# UNIFIED-CORE.md — Single-Core Search Design

Target: one search core, one movegen, one feature set in `src/`; guideline/TBP vs S2
differ ONLY in data (a rules-profile table + per-ruleset weights).

## Rules-Profile Table (`src/core/profile.ts`)

The ONLY source of guideline/S2 differences. All behavioral divergence is encoded as
data in `RulesProfile` fields, not scattered conditionals.

| Field              | guideline              | s2                      |
|--------------------|------------------------|-------------------------|
| `id`               | `"guideline"`          | `"s2"`                  |
| `boardRows`        | 20                     | 40                      |
| `visibleRows`      | 20                     | 20                      |
| `deathHeight`      | `"boardLength"`        | 21                      |
| `attackRules`      | `"guideline"`          | `"tetrio-s2"`           |
| `surge`            | false                  | true                    |
| `comboInAttack`    | false                  | true                    |
| `garbageSemantics` | `"root-lift"`          | `"materialized-carried"`|
| `rotate180`        | false                  | true                    |
| `spinEvidence`     | false                  | true                    |
| `spinClassifier`   | `"engine"`             | `"s2"`                  |
| `dedupe`           | `"guideline"`          | `"s2"`                  |

### Verification vs actual code

Values verified against:
- `src/core/rules.ts` `RULES_PROFILES`: boardRows/visibleRows match cols 10 for both.
- `src/ai/bot/search.ts` expand(): guideline disables combo in attack (`combo: guideline ? -1 : combo`), disables PC attack, uses boolean b2b, death `maxHeight >= board.length`.
- `tools/s2-lab/search.ts` expand(): uses exact b2b chain, staged S2 award via `awardLock("tetrio-s2", ...)`, death `maxHeight >= 21` (capped from board.length), `classifyS2Spin`, `generatePlacements(..., { spinEvidence: true, rotate180: true })`, materialized garbageRows + carried pending/dueThisLock.
- `src/ai/bot/search.ts` dedupe(): `profile = "guideline"` uses legacy key, `"s2"` uses full provenance key.

**Corrections made**: None. All values match the actual implementation.

## Per-Ruleset Weights

Weights are separate from the profile table. The `Weights` type already supports all
needed fields (attack, conversion, clear rewards, discount). S2 uses `conversion > 0`,
guideline uses `conversion = 0`. The profile selects which weight table to apply, but
weight files themselves are not in the profile table.

## ONE Per-Node State Record (`src/ai/bot/state.ts`)

Single source of truth for node state. The unified core consumes ONE per-node `NodeState`
record; search, evaluation, rollouts and telemetry all read it.

```typescript
interface NodeState {
  readonly board: BitBoard;
  readonly garbageRows: Uint8Array | null;  // null = guideline (no tracking)
  readonly hold: PieceKind | null;
  readonly canHold: boolean;
  readonly next: number;
  readonly b2bChain: number;     // exact chain count (guideline stores 0|1)
  readonly b2bActive: boolean;   // derived: chain > 0
  readonly combo: number;
  readonly pending: number;      // guideline: root-only lift; s2: carried
  readonly lift: number;
  readonly dueThisLock: number;
  readonly bagRemaining: readonly PieceKind[] | null;
  readonly tSlot: number;
}
```

### Evaluator View

The evaluator sees b2b, hold and bag through the state record:

```typescript
interface EvaluatorView {
  readonly b2bActive: boolean;
  readonly b2bChain: number;
  readonly hold: PieceKind | null;
  readonly canHold: boolean;
  readonly bagRemaining: readonly PieceKind[] | null;
  readonly combo: number;
  readonly pending: number;
}
```

## Diff Inventory: src search vs tools/s2-lab search

| Aspect                | src/ai/bot/search.ts                     | tools/s2-lab/search.ts                    |
|-----------------------|------------------------------------------|-------------------------------------------|
| **B2B representation**| `b2b: boolean`                           | `b2b: number` (exact chain count)         |
| **Award path**        | `attackForClear` (guideline table)       | `awardLock("tetrio-s2", ...)` with frame multiplier + `classifyS2Spin` |
| **Garbage semantics** | Root-only lift scalar                    | Materialized `garbageRows` + carried `pending`/`dueThisLock` |
| **Death rule**        | `maxHeight >= board.length`, null        | `maxHeight >= 21`, terminal dead leaf     |
| **Movegen options**   | No `spinEvidence`/`rotate180`            | `spinEvidence: true, rotate180: true`     |
| **Spin classifier**   | Engine `classifyTspin`                   | `classifyS2Spin` (All-Mini+)              |
| **Stock Φ**           | Not present                              | `stockPotential` in terminal estimate     |
| **Solvency**          | Not present                              | `assessSolvency` penalty + root veto      |
| **Hard root veto**    | Not present                              | `rootVeto` option                         |
| **Dedupe key**        | Legacy 4-field key (profile-conditional) | Full provenance 7-field key               |
| **Node.dead**         | Not present (null = unplaceable)         | `dead: boolean` for terminal leaves       |

## Remaining Steps (chunk 3b onwards)

Each step has a gate: `bunx tsc --noEmit && bun test && bun run lint && bun run build`
plus Hoiko regression 1001-1200 exact reproduction after every step that touches the
guideline path.

### (i) Port S2 award/garbage/death semantics into shared search behind profile table

The expand() function reads the profile to choose:
- Attack calculation: `attackForClear` vs `awardLock("tetrio-s2", stage)`.
- Garbage handling: root-lift vs materialized-carried.
- Death rule: `board.length` vs 21.
- Spin classification: engine vs s2.

Gate: type-check + tests + Hoiko regression (guideline unchanged).

### (ii) Rewire tools/s2-lab/attax-player.ts + imitation variants to shared search

The S2 player imports from `src/ai/bot/search.ts` with `profile: "s2"`.

Gate: tools/s2-lab tests + S2 lab smoke.

### (iii) Delete tools/s2-lab/search.ts

All S2 consumers now use the shared core.

Gate: no regressions.

### (iv) SPECULATE parity check

Verify: `src/ai/bot/search.ts` already implements the `speculativePieces` chance-node
logic (at lines 133-165). The S2 search has identical logic. No reimplementation needed;
the two already match.

Gate: comparison test showing identical values for same inputs.

### (v) S2-side evidence runs

- Port/contract tests pass under the shared core.
- Lab smoke (a few S2 seeds) produces equivalent results.

Gate: tools/s2-lab tests pass.

### (vi) Hoiko regression 1001-1200 exact reproduction after every step

The frozen 390-10 record must reproduce exactly after each change.

Gate: `tools/unify/` regression scripts.

> 2026-11-17 amendment: the 390-10 record is the width-48 record. The
> width-48 reproduction path was retired that day (width 96 is the standard
> everywhere), and the Hoiko regression baseline was re-measured at width 96
> over the same partition (seeds 1001-1200, both seats, HOIKO_ADAPT=0):
> **378W-22L-0D**, recorded in `bench-results/bot-vs-hoiko.w96.jsonl` (see
> `~/workspace/attax-s2/W48-REMOVAL-INVENTORY-2026-11-17.md`). The 390-10
> record stands as the width-48 historical record; it is no longer the
> regression gate.

## What chunk 3a does NOT do

- Does NOT delete `tools/s2-lab/search.ts` (left fully untouched).
- Does NOT change any S2 behaviour.
- Does NOT change any guideline-path numeric behaviour.

Chunk 3a delivers:
1. This design doc.
2. `src/core/profile.ts` (rules-profile table).
3. `src/ai/bot/state.ts` (NodeState + rootState + evaluatorView).
4. `src/ai/bot/search.ts` refactored to use NodeState.
5. `src/ai/bot/stock.ts` and `src/ai/bot/solvency.ts` (moved from tools/s2-lab, with re-export shims).
6. `tests/bot-state-profile.test.ts`.
