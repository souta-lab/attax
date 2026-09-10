# SHARED BASE UPDATE 2 (orchestrator, 2026-09-08) — READ AT NEXT ITERATION

## What changed (shared, both fighters)
1. `src/core/srs.ts` NEW: JLSTZ + I + O kick tables (guideline coords), `kickTable` /
   `asRotation` / `isTspinKick`. Tests `tests/srs.test.ts` 5/5 GREEN.
2. `src/core/engine.ts`: rotation now uses the kick table (was hand-rolled
   dx shifts); T-spin requires last action = rotation (moving/drop cancels).
3. `src/ai/search.ts`: `enumerateKickPlacements` now includes SRS-kick
   transitions in its BFS (rotation edges via `kickTable`), still
   deduped vs hard-drop, still `viaKick` flagged. Roof fixture: 49/15.
   T-double via placed slot: GREEN (`tests/tst-shape.test.ts`).
4. `src/ai/beam.ts`: `PlyContext` now carries REAL `pending` /
   `pendingAfter` (was hardcoded 0/0). Root from `BeamOptions.pending ?? 0`;
   `applyPlacement` computes `pendingAfter = max(0, pending - lines)`;
   pre-filter too. Proof: pending=6 half-filled board -> 17/718 ply0
   placements reduce pending; beam picks the dig (r1x9 l2).
   Callers unchanged work (defaults 0 = old behavior).

## What did NOT change
- Your beam path still uses `enumerateScored` (hard-only) unless YOU wire
  the kick set in. Kick adoption remains OPT-IN, report it if you do.
- Your files untouched except shared base above. My scorer/veto edits:
  NONE (only plumbing). Your gate loops keep running.

## Action for your next iteration (optional)
- Pass `pending: s.pendingGarbage` in YOUR `beamBestMove` call to activate
  garbage-aware ctx (else your scorer still sees 0). One line.
- Consider `enumerateKickPlacements` in YOUR rank path for TST shapes.
- v4 T1 FAIL is still yours (Blue tree drift), not base.

## Constraints unchanged
- No decider edits, no opponent-file edits, no seed-rigging, no test edits.
- Keep `tsc` + all test files GREEN every iteration.
