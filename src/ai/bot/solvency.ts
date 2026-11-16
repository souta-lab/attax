/**
 * C2 — geometry-aware solvency for the S2 search (canonical design §C2).
 *
 * The champion's rescue is an amount-only root veto: it estimates survival
 * from counters (height + tank + remaining input) at the root only. This
 * layer is deliberately stronger in three ways, per the design:
 *
 * - It reads the REAL post-lock state at every beam layer: the actual board
 *   (garbage already materialized into it by the driver), the actual stack
 *   height, and the residual pending the driver now carries through the
 *   search — not root counters.
 * - It prices the pressure evolution P' = P − C − T + I over the next lock:
 *   past the root the lab's zero-delay intake makes every residual row due
 *   at the next non-clearing lock, and tanking raises the stack by exactly
 *   the landed amount, so the worst margin is exact arithmetic on the real
 *   geometry: M = 20 − height − pending.
 * - It is a smooth lower-tail penalty plus a certain-death demotion, not a
 *   binary veto: risky lines are devalued in proportion to their margin
 *   shortfall, and a node that the next tank kills outright (M < 0 — it
 *   survives only by cancelling on the immediately next lock) is demoted
 *   below every non-doomed node by a large finite penalty. If every line is
 *   doomed, the least-bad still ranks first (design policy 5).
 *
 * Because the penalty is part of each node's value at every layer, defensive
 * lines are not pruned away before a root decision could rescue them — the
 * failure mode a root-only veto cannot fix.
 *
 * Deferred by design (needs telemetry first, like §C1's beam reservation):
 * counting safe continuations per node, garbage-clear accessibility search,
 * and defensive beam-slot reservation. Scenario arrivals I_j beyond the
 * known residual pending are unobservable at this interface and are not
 * modeled; the margin uses the legally known pressure only.
 *
 * S2-profile parameters only; the guideline bot never sees this module.
 */
import type { BoardFeatures } from "./features.js";
import type { NodeState } from "./state.js";

export interface SolvencyParams {
  /** Points per squared row of margin shortfall below `marginBand`. */
  readonly coefficient: number;
  /** Margin (rows below the visible-field top) at or above which no penalty applies. */
  readonly marginBand: number;
  /** Finite demotion for nodes the next tank kills outright. */
  readonly doomedPenalty: number;
}

export const DEFAULT_SOLVENCY_PARAMS: SolvencyParams = {
  coefficient: 40,
  marginBand: 6,
  doomedPenalty: 1_000_000,
};

/** Everything the solvency layer needs from a post-lock search state. */
export interface SolvencyState {
  /** Post-lock stack height (board feature). */
  readonly maxHeight: number;
  /** Residual pending garbage, due at the next non-clearing lock. */
  readonly pending: number;
}

/**
 * Build a SolvencyState from a NodeState and its board features.
 *
 * @param state The node's state record.
 * @param features Board features computed for this node.
 */
export function solvencyStateFrom(state: NodeState, features: BoardFeatures): SolvencyState {
  return {
    maxHeight: features.maxHeight,
    pending: state.pending,
  };
}

export interface SolvencyAssessment {
  /** Penalty in score points, subtracted inside the node's value bracket. */
  readonly penalty: number;
  /** Worst margin over the next-lock pressure step: 20 − height − pending. */
  readonly margin: number;
  /** True when tanking the residual pending kills this state outright. */
  readonly doomed: boolean;
}

/**
 * Worst margin over the next-lock pressure step: 20 − height − pending.
 * This is also the champion's root-veto arithmetic (choose_rescue): its
 * amount-only projection computes 20 − occupied − tanked − remaining,
 * which is the same number once tanked rows are materialized into the
 * board (height then includes the tank, pending is the remainder).
 */
export function solvencyMargin(state: SolvencyState, visibleRows = 20): number {
  return visibleRows - state.maxHeight - state.pending;
}

/** Assess a post-lock state. Pure; exact height arithmetic, no board scan. */
export function assessSolvency(
  state: SolvencyState,
  params: SolvencyParams,
  visibleRows = 20,
): SolvencyAssessment {
  const margin = solvencyMargin(state, visibleRows);
  const doomed = margin < 0;
  const shortfall = Math.max(0, params.marginBand - margin);
  const penalty = params.coefficient * shortfall * shortfall + (doomed ? params.doomedPenalty : 0);
  return { penalty, margin, doomed };
}
