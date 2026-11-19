// Moved verbatim from src/ai/bot/state.ts in Phase C (2026-11-19): the TS search was
// removed and the GPU driver is the only engine left; the shapes and constants it
// needs live here now. Only import paths were adjusted.
/**
 * Unified per-node state record for the search core.
 *
 * The unified core consumes ONE NodeState record per node; search, evaluation,
 * rollouts (SPECULATE) and telemetry all read it. This file also defines the
 * SearchInput interface (the definition lives here; the result/option types
 * that used to sit in search.ts are vendored alongside in search-types.ts).
 */
import type { PieceKind } from "../../src/core/pieces.js";
import type { BoardFeatures } from "./features.js";
import type { BitBoard, Placement } from "./board.js";

export interface SearchInput {
  readonly board: BitBoard;
  /** S2: logical referee frame at the root decision (lockTime). Absent = 0. */
  readonly frame?: number;
  /** S2: garbage flags aligned with board row indices. Absent on the guideline path. */
  readonly garbageRows?: readonly number[];
  readonly active: { kind: PieceKind; rotation: number; x: number; y: number };
  readonly hold: PieceKind | null;
  readonly canHold: boolean;
  /** Upcoming pieces after the active one (the visible preview). */
  readonly preview: readonly PieceKind[];
  readonly b2b: boolean;
  /**
   * S2: exact difficult-clear chain. When present it is used verbatim (and
   * `b2b` is ignored for the root state); the guideline path never sets it.
   */
  readonly b2bChain?: number;
  /** Engine combo counter: -1 = no chain, 0 = first clear of a chain, ... */
  readonly combo: number;
  /** Incoming garbage rows not yet on the board. */
  readonly pending: number;
  /** S2: referee-given rows due on the root lock. Absent = 0. */
  readonly dueThisLock?: number;
  /** S2: referee kickset witness required for root placements only. */
  readonly acceptRoot?: (placement: Placement, usedHold: boolean) => boolean;
  /** Possible next pieces after the visible queue, uniformly distributed by 7-bag. */
  readonly speculativePieces?: readonly PieceKind[];
}

/**
 * The single per-node state record the unified search core consumes.
 * Search, evaluation (including stock Φ / solvency), rollouts and telemetry
 * all read through this record.
 */
export interface NodeState {
  readonly board: BitBoard;
  /**
   * Garbage flags aligned with board row indices (same index space as board).
   * Null on the guideline path (no per-row tracking; only lift scalar).
   */
  readonly garbageRows: Uint8Array | null;
  readonly hold: PieceKind | null;
  readonly canHold: boolean;
  /** Index into the piece sequence of the piece to place next. */
  readonly next: number;
  /**
   * Exact difficult-clear chain count. The guideline path stores 0 or 1
   * (boolean semantics, converted at the boundary); the S2 path stores the
   * true chain length.
   */
  readonly b2bChain: number;
  /** Derived: whether a difficult-clear chain is active (chain > 0). */
  readonly b2bActive: boolean;
  /** Engine combo counter: -1 = no chain, 0 = first clear of a chain, ... */
  readonly combo: number;
  /**
   * Residual incoming garbage not yet on the board. Guideline: root-only
   * (later nodes carry 0, the root's is held as lift). S2: carried through
   * the search.
   */
  readonly pending: number;
  /** Garbage rows that will land under the stack during the line. */
  readonly lift: number;
  /** Referee-given rows due on the root lock (S2 only). */
  readonly dueThisLock: number;
  /**
   * Reserved for per-ply bag remainder after the visible queue.
   * Currently inert (`null` in `search()`): unseen-piece speculation and C2
   * `tAvailable` read `input.speculativePieces` at root (`adoptContext` and the
   * leaf chance-average pass), so `search()` passes `null` at root and every ply.
   */
  readonly bagRemaining: readonly PieceKind[] | null;
  /** Lines a T-spin into the best open T-slot would clear (board feature). */
  readonly tSlot: number;
}

/**
 * Build the root NodeState from a SearchInput.
 *
 * @param input The search input (board, active, hold, queue, b2b, combo, pending).
 * @param rootFeatures Board features computed for the root (used for tSlot).
 * @param bagRemaining Authoritative bag remainder (null if unknown).
 */
export function rootState(
  input: SearchInput,
  rootFeatures: BoardFeatures,
  bagRemaining: readonly PieceKind[] | null,
): NodeState {
  const b2bChain = input.b2bChain !== undefined ? input.b2bChain : input.b2b ? 1 : 0;
  return {
    board: input.board,
    // Same construction as the S2 lab root: one flag per board row.
    garbageRows:
      input.garbageRows !== undefined
        ? Uint8Array.from(input.board, (_, row) => (input.garbageRows?.[row] ? 1 : 0))
        : null,
    hold: input.hold,
    canHold: input.canHold,
    next: 0,
    b2bChain,
    b2bActive: input.b2bChain !== undefined ? b2bChain > 0 : input.b2b,
    combo: input.combo,
    pending: input.pending,
    lift: 0,
    dueThisLock: input.dueThisLock ?? 0,
    bagRemaining,
    tSlot: rootFeatures.tSlot,
  };
}

/**
 * The evaluator's window into the node state. This is exactly the set of fields
 * the evaluator and mechanism layers (stock Φ, solvency) need to see through
 * the state record.
 */
export interface EvaluatorView {
  readonly b2bActive: boolean;
  readonly b2bChain: number;
  readonly hold: PieceKind | null;
  readonly canHold: boolean;
  readonly bagRemaining: readonly PieceKind[] | null;
  readonly combo: number;
  readonly pending: number;
}

/**
 * Extract the evaluator's view from a NodeState.
 */
export function evaluatorView(state: NodeState): EvaluatorView {
  return {
    b2bActive: state.b2bActive,
    b2bChain: state.b2bChain,
    hold: state.hold,
    canHold: state.canHold,
    bagRemaining: state.bagRemaining,
    combo: state.combo,
    pending: state.pending,
  };
}
