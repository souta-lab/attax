/** Loaded potential — mechanism B (EARLY-CANCEL-DESIGN-2026-11-24 §2.3).
 *
 * Rationale (design §1 + regret instrument, item 6): on opportunity turns
 * in locks 10–29 the premium clear was usually ABSENT from the evaluated
 * candidate set (band regret total 12 lines over 102 loss games, ~9% of
 * the +1.28 lines/game behavioural effect), so the deficit is built
 * earlier, in locks 0–19 board construction: plain clears that break B2B
 * and moves that collapse a T-spin setup spend the loaded clear before an
 * opportunity turn can use it. Mechanism B therefore prices the CHILD
 * position's retained "loaded potential" in the opening band, so a move
 * that destroys it pays the opportunity cost in the root reward.
 *
 * Definition (three binary features of the child position, sum 0–3):
 *   - b2bActive:        the child's B2B chain is still active (> 0).
 *   - tSlotPresent:     the child board still has a T-spin slot
 *                       (boardFeatures.tSlot > 0).
 *   - premiumWithinTwo: a premium clear (quad, or any spin clear — the
 *                       clears whose attack carries the spin/B2B premium
 *                       of design §1.3) is legally reachable within the
 *                       next two placements of the child's queue.
 *
 * `premiumWithinTwo` is an existence check, not a valuation: ply 1 mirrors
 * the search's own piece options (current piece, or the hold swap), ply 2
 * is the following queue piece with no further hold (a conservative
 * under-estimate — a hold at ply 2 could only add options). Spin
 * classification matches the S2 search exactly (classifyS2Spin on the
 * pre-lock board), and clears are judged by lockPlacement.
 *
 * This module is pure: no I/O, no weights, no search invocation. The S2
 * search calls it for root children only, only while the registered
 * `loadedPotential` weight is non-zero and the root lock is in band, so
 * the default profile pays no cost and is bit-identical.
 */
import {
  type BitBoard,
  collides,
  generatePlacements,
  lockPlacement,
  type Placement,
  spawnPosition,
} from "../../src/ai/bot/movegen.js";
import type { PieceKind } from "../../src/core/pieces.js";
import { classifyS2Spin } from "../../src/core/s2-spin.js";

/** Mechanism B prices root locks 0–19 (design §2.3): root lock < 20. */
export const LOADED_BAND_HI = 20;

export interface LoadedPotential {
  readonly b2bActive: boolean;
  readonly tSlotPresent: boolean;
  readonly premiumWithinTwo: boolean;
  /** Sum of the three binary features (0–3): the credited quantity. */
  readonly total: number;
}

/** True when the root lock index is inside the mechanism-B band. */
export function isLoadedBand(lockIndex: number | undefined): boolean {
  return lockIndex !== undefined && lockIndex >= 0 && lockIndex < LOADED_BAND_HI;
}

/** SB-3 (R2-STAGE2-DESIGN-2026-11-24 §3.3) prices root locks >= 40:
 * the same loaded-potential features as mechanism B, extended to the
 * mid-game onwards under the separated key `loadedPotentialMid`.
 * Locks 20–39 are priced by neither mechanism. */
export const LOADED_MID_BAND_LO = 40;

/** True when the root lock index is inside the SB-3 band. */
export function isLoadedMidBand(lockIndex: number | undefined): boolean {
  return lockIndex !== undefined && lockIndex >= LOADED_MID_BAND_LO;
}

function isPremiumClear(board: BitBoard, placement: Placement): boolean {
  const spin = classifyS2Spin(
    placement,
    (x, y) =>
      x < 0 || x >= 10 || y >= board.length || (y >= 0 && ((board[y] ?? 0) & (1 << x)) !== 0),
    (dx, dy) =>
      !collides(board, placement.kind, placement.rotation, placement.x + dx, placement.y + dy),
  );
  const lines = lockPlacement(board, placement).linesCleared;
  return lines > 0 && (lines === 4 || spin !== "none");
}

interface PlyOption {
  readonly kind: PieceKind;
  readonly next: number;
}

/** Ply-1 options mirroring search.ts pieceOptions (current / hold swap). */
function plyOptions(
  sequence: readonly PieceKind[],
  next: number,
  hold: PieceKind | null,
  canHold: boolean,
): PlyOption[] {
  const current = sequence[next];
  if (current === undefined) return [];
  const options: PlyOption[] = [{ kind: current, next: next + 1 }];
  if (!canHold) return options;
  if (hold === null) {
    const after = sequence[next + 1];
    if (after !== undefined && after !== current) options.push({ kind: after, next: next + 2 });
  } else if (hold !== current) {
    options.push({ kind: hold, next: next + 1 });
  }
  return options;
}

/**
 * Existence of a premium clear within the next two placements from the
 * child position. `sequence`/`next`/`hold`/`canHold` are the child's
 * queue state (same fields the search node carries).
 */
export function premiumClearWithinTwo(
  board: BitBoard,
  sequence: readonly PieceKind[],
  next: number,
  hold: PieceKind | null,
  canHold: boolean,
): boolean {
  for (const option of plyOptions(sequence, next, hold, canHold)) {
    const start = spawnPosition(option.kind, board.length);
    for (const placement of generatePlacements(board, option.kind, start, {
      spinEvidence: true,
      rotate180: true,
    })) {
      if (isPremiumClear(board, placement)) return true;
      const following = sequence[option.next];
      if (following === undefined) continue;
      const after = lockPlacement(board, placement).board;
      const start2 = spawnPosition(following, after.length);
      for (const placement2 of generatePlacements(after, following, start2, {
        spinEvidence: true,
        rotate180: true,
      })) {
        if (isPremiumClear(after, placement2)) return true;
      }
    }
  }
  return false;
}

/**
 * Feature-quantify one child position. `b2b` is the child's B2B chain
 * counter (award.difficultChain), `tSlot` its boardFeatures.tSlot, and
 * the queue fields its post-lock queue state.
 */
export function loadedPotential(input: {
  readonly board: BitBoard;
  readonly b2b: number;
  readonly tSlot: number;
  readonly sequence: readonly PieceKind[];
  readonly next: number;
  readonly hold: PieceKind | null;
  readonly canHold: boolean;
}): LoadedPotential {
  const b2bActive = input.b2b > 0;
  const tSlotPresent = input.tSlot > 0;
  const premiumWithinTwo = premiumClearWithinTwo(
    input.board,
    input.sequence,
    input.next,
    input.hold,
    input.canHold,
  );
  return {
    b2bActive,
    tSlotPresent,
    premiumWithinTwo,
    total: Number(b2bActive) + Number(tSlotPresent) + Number(premiumWithinTwo),
  };
}
