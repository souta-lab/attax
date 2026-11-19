/**
 * Plan carry-over for the S2 decider (item 100, Souta's amended design of
 * 2026-11-15 23:51).
 *
 * The search's output is "the chosen line + its predicted states". This
 * wrapper keeps that plan and, at every later decision, reconciles the plan's
 * predicted state for this depth against the ACTUAL decision state. It plays
 * the next planned step only when every search-relevant field matches; on any
 * divergence or doubt it falls back to a full search. A move the current
 * decision has not approved (acceptRoot witness filter, reachability) is never
 * played: a carried step is re-checked against the current decision's filter.
 *
 * Plans come from SearchResult.lineStates (the TS search, opt-in). A result
 * without lineStates — e.g. from the Rust engine, which does not return them
 * yet — leaves no plan, so the wrapper is a pure pass-through: every decision
 * searches. That is correct, just without the speedup.
 *
 * Wrap one decider per game per side: the plan is per-player state.
 */
import { generatePlacements, type Placement, spawnPosition } from "../../src/ai/bot/movegen.js";
import type { SearchResult, Step } from "../../src/ai/bot/search.js";
import type { NodeState } from "../../src/ai/bot/state.js";
import type { PieceKind } from "../../src/core/pieces.js";
import { rulesProfile } from "../../src/core/profile.js";
import { s2GarbageMultiplier } from "../../src/core/rules.js";
import { type PublicDecision, projectAttax } from "./attax-player.js";
import { type SearchInput, toSharedInput } from "./s2-input.js";

type AcceptRoot = NonNullable<SearchInput["acceptRoot"]>;

export interface InnerDecider {
  decideAsync(decision: PublicDecision, acceptRoot?: AcceptRoot): Promise<SearchResult | null>;
}

/** A carried decision is marked; a searched one is the inner result unchanged. */
export type CarryoverResult = SearchResult & { readonly carried?: boolean };

/** Why a decision searched instead of carrying (for run accounting). */
export type CarryoverReason =
  | "no-plan"
  | "plan-exhausted"
  | "board"
  | "garbageRows"
  | "hold"
  | "canHold"
  | "b2bChain"
  | "combo"
  | "pending"
  | "dueThisLock"
  | "lift"
  | "queue"
  | "multiplier"
  | "unreachable"
  | "acceptRoot"
  | "reconcile-error";

export interface CarryoverStats {
  searched: number;
  carried: number;
  reasons: Partial<Record<CarryoverReason, number>>;
}

interface Plan {
  readonly result: SearchResult;
  readonly line: readonly Step[];
  /** states[k] = predicted state after k locks of `line` (states[0] = root). */
  readonly states: readonly NodeState[];
  /** The root decision's queue: [active, ...preview]; NodeState.next indexes it. */
  readonly sequence: readonly PieceKind[];
  readonly rootFrame: number;
  /** Locks of the line already played (the next step to play is line[depth]). */
  depth: number;
}

const S2 = rulesProfile("s2");
const MOVEGEN = {
  spinEvidence: S2.spinEvidence,
  rotate180: S2.rotate180,
  kicks180: S2.kicks180,
};

function sameRows(a: ArrayLike<number> | null, b: ArrayLike<number> | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return false;
  return true;
}

function samePlacement(a: Placement, b: Placement): boolean {
  return (
    a.kind === b.kind &&
    a.rotation === b.rotation &&
    a.x === b.x &&
    a.y === b.y &&
    a.lastSrs === b.lastSrs
  );
}

/**
 * Compare the plan's prediction for this decision with the actual decision.
 * Returns null on a full match, else the first diverging field.
 */
function reconcile(
  plan: Plan,
  decision: PublicDecision,
  acceptRoot: AcceptRoot | undefined,
): CarryoverReason | null {
  const d = plan.depth;
  const remaining = plan.line.length - d;
  if (remaining <= 0 || d >= plan.states.length) return "plan-exhausted";
  const predicted = plan.states[d] as NodeState;
  // The same projection the inner decider applies to this decision.
  const actual = toSharedInput(projectAttax(decision));

  if (!sameRows(predicted.board, actual.board)) return "board";
  const actualFlags =
    actual.garbageRows === undefined
      ? null
      : Array.from(actual.board, (_, row) => (actual.garbageRows?.[row] ? 1 : 0));
  if (!sameRows(predicted.garbageRows, actualFlags)) return "garbageRows";
  if (predicted.hold !== actual.hold) return "hold";
  if (predicted.canHold !== actual.canHold) return "canHold";
  if (predicted.b2bChain !== (actual.b2bChain ?? (actual.b2b ? 1 : 0))) return "b2bChain";
  if (predicted.combo !== actual.combo) return "combo";
  if (predicted.pending !== actual.pending) return "pending";
  // Past the root the search lands every residual row at the next
  // non-clearing lock (zero-frame delay, instant entry) — child states store
  // dueThisLock 0 as a placeholder. The modeled due amount is therefore the
  // predicted pending at depth > 0 (and the stored field at the root).
  const predictedDue = d === 0 ? predicted.dueThisLock : predicted.pending;
  if (predictedDue !== (actual.dueThisLock ?? 0)) return "dueThisLock";
  if (predicted.lift !== 0) return "lift"; // the actual root state always has lift 0

  // Queue: the pieces the remaining plan consumes must be exactly the actual
  // [active, ...preview] from the predicted next index.
  const last = plan.states[plan.line.length] as NodeState | undefined;
  if (last === undefined) return "plan-exhausted";
  const needed = Math.max(remaining, last.next - predicted.next);
  const actualQueue = [actual.active.kind, ...actual.preview];
  if (actualQueue.length < needed) return "queue";
  for (let i = 0; i < needed; i += 1) {
    const planned = plan.sequence[predicted.next + i];
    if (planned === undefined || planned !== actualQueue[i]) return "queue";
  }

  // Attack multiplier schedule: the plan priced lock k of the remaining line
  // at rootFrame + 60*(d+k); the actual clock must price it identically.
  const frame = decision.lockTime?.logicalFrame ?? 0;
  for (let k = 0; k < remaining; k += 1) {
    if (s2GarbageMultiplier(frame + 60 * k) !== s2GarbageMultiplier(plan.rootFrame + 60 * (d + k)))
      return "multiplier";
  }

  // The carried step must be a legal root move of THIS decision, generated the
  // way the search generates its roots, and approved by the current filter.
  const step = plan.line[d] as Step;
  const kind = step.usedHold
    ? actual.hold !== null
      ? actual.hold
      : actual.preview[0]
    : actual.active.kind;
  if (kind !== step.placement.kind) return "unreachable";
  // Same start positions the search uses for its root expansion.
  const start = !step.usedHold
    ? actual.active
    : actual.hold !== null
      ? {
          rotation: 0,
          x: 3,
          y: actual.board.length > S2.visibleRows ? actual.board.length - S2.visibleRows - 1 : 0,
        }
      : spawnPosition(kind, actual.board.length);
  const placements = generatePlacements(actual.board, kind, start, MOVEGEN);
  if (!placements.some((p) => samePlacement(p, step.placement))) return "unreachable";
  if (acceptRoot) {
    const raw = placements.find((p) => samePlacement(p, step.placement)) as Placement;
    if (!acceptRoot(raw, step.usedHold)) return "acceptRoot";
  }
  return null;
}

export function createPlanCarryoverDecider(inner: InnerDecider) {
  let plan: Plan | null = null;
  const stats: CarryoverStats = { searched: 0, carried: 0, reasons: {} };

  const searchFresh = async (
    decision: PublicDecision,
    acceptRoot: AcceptRoot | undefined,
    reason: CarryoverReason,
  ): Promise<CarryoverResult | null> => {
    stats.searched += 1;
    stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
    plan = null;
    const result = await inner.decideAsync(decision, acceptRoot);
    const states = result?.lineStates;
    if (result && states && states.length === result.line.length + 1 && result.line.length > 1) {
      const root = toSharedInput(projectAttax(decision));
      plan = {
        result,
        line: result.line,
        states,
        sequence: [root.active.kind, ...root.preview],
        rootFrame: decision.lockTime?.logicalFrame ?? 0,
        depth: 1, // line[0] is played now; the next decision expects states[1]
      };
    }
    return result;
  };

  return {
    stats,
    /** Drop the plan (e.g. between games when a wrapper is reused). */
    reset() {
      plan = null;
    },
    async decideAsync(
      decision: PublicDecision,
      acceptRoot?: AcceptRoot,
    ): Promise<CarryoverResult | null> {
      if (plan === null) return searchFresh(decision, acceptRoot, "no-plan");
      let reason: CarryoverReason | null;
      try {
        reason = reconcile(plan, decision, acceptRoot);
      } catch {
        // Any doubt (e.g. a projection the plan cannot be compared against)
        // falls back to a full search; the inner decider surfaces real errors.
        reason = "reconcile-error";
      }
      if (reason !== null) return searchFresh(decision, acceptRoot, reason);
      const d = plan.depth;
      plan.depth = d + 1;
      stats.carried += 1;
      const { result } = plan;
      const carried: CarryoverResult = {
        best: plan.line[d] as Step,
        line: plan.line.slice(d),
        value: result.value,
        breakdown: result.breakdown,
        candidates: result.candidates,
        nodes: 0, // no search ran for this decision
        depth: result.depth,
        ...(result.lineStates ? { lineStates: result.lineStates.slice(d) } : {}),
        carried: true,
      };
      if (plan.depth >= plan.line.length) plan = null;
      return carried;
    },
  };
}
