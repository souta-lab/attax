/** Yield-regret instrument (EARLY-CANCEL-DESIGN-2026-11-24 §2.1).
 *
 * Question it separates: on opportunity turns (pendingBefore > 0) in locks
 * 10–29, was the premium clear (a) present among the candidates the search
 * actually evaluated but not chosen (selection problem -> mechanism A), or
 * (b) absent from the candidate set altogether (board-construction problem
 * -> mechanism B)?
 *
 * Definition: regret(turn) = maxAeff(candidates) - Aeff(chosen), where Aeff
 * is the root step's search-internal attack (`Candidate.attack`, pre-cancel
 * award; the same quantity the search itself prices). Both terms come from
 * the SAME search call, so the figure is internally consistent even where
 * the referee's realised Aeff (cancelled + outgoingAfterCancel in the trace)
 * differs by the known +1 cancel component.
 *
 * Recording rule: only attax turns with pendingBefore > 0 and
 * 10 <= lockIndex < 30 are recorded (the design's band). Everything else
 * returns null so a trace driver can call this unconditionally.
 *
 * This module is pure: no I/O, no weights, no search invocation. A trace
 * driver (run-match-trace form) calls `regretRow` with the SearchResult it
 * already computed and appends the returned row to its regret JSONL.
 */
import type { SearchResult } from "./search.js";

export const REGRET_BAND_LO = 10;
export const REGRET_BAND_HI = 30; // exclusive

export interface RegretRow {
  readonly lockIndex: number;
  readonly pendingBefore: number;
  /** Attack of the move actually chosen (search `best.attack`). */
  readonly chosenAeff: number;
  /** Largest attack among all evaluated root candidates. */
  readonly maxCandidateAeff: number;
  /** maxCandidateAeff - chosenAeff (>= 0). */
  readonly regret: number;
  readonly chosenLines: number;
  /** Lines cleared by the highest-attack candidate (first such candidate). */
  readonly maxCandidateLines: number;
  readonly candidateCount: number;
}

/** True when a turn is in scope for the instrument. */
export function isOpportunityTurn(lockIndex: number, pendingBefore: number): boolean {
  return pendingBefore > 0 && lockIndex >= REGRET_BAND_LO && lockIndex < REGRET_BAND_HI;
}

/**
 * Build the regret row for one decided turn, or null when out of scope or
 * the search produced no candidates. `pendingBefore` is the referee-side
 * pending at turn start (the trace's pendingBefore), not the search's
 * internal residual.
 */
export function regretRow(
  result: Pick<SearchResult, "best" | "candidates">,
  lockIndex: number,
  pendingBefore: number,
): RegretRow | null {
  if (!isOpportunityTurn(lockIndex, pendingBefore)) return null;
  if (result.candidates.length === 0) return null;
  let max = result.candidates[0] as SearchResult["candidates"][number];
  for (const c of result.candidates) if (c.attack > max.attack) max = c;
  const chosenAeff = result.best.attack;
  return {
    lockIndex,
    pendingBefore,
    chosenAeff,
    maxCandidateAeff: max.attack,
    regret: max.attack - chosenAeff,
    chosenLines: result.best.linesCleared,
    maxCandidateLines: max.linesCleared,
    candidateCount: result.candidates.length,
  };
}

/** Band total + per-turn mean over recorded rows (the §2.4 readout item 6). */
export function summariseRegret(rows: readonly RegretRow[]): {
  turns: number;
  totalRegret: number;
  meanRegret: number;
  positiveShare: number;
} {
  const total = rows.reduce((n, r) => n + r.regret, 0);
  return {
    turns: rows.length,
    totalRegret: total,
    meanRegret: rows.length ? total / rows.length : 0,
    positiveShare: rows.length ? rows.filter((r) => r.regret > 0).length / rows.length : 0,
  };
}
