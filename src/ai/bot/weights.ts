/**
 * The bot's entire policy is this table: board-shape weights (applied to the board at the
 * end of the searched line) plus per-placement rewards (summed along the line).
 * Positive = good, negative = bad. Values are in "points" and only their ratios matter.
 */
import type { BoardFeature } from "./features.js";

export type ClearKind =
  | "single"
  | "double"
  | "triple"
  | "quad"
  | "tspinMini"
  | "tspinSingle"
  | "tspinDouble"
  | "tspinTriple"
  | "perfectClear";

export interface Weights {
  readonly board: Readonly<Record<BoardFeature, number>>;
  /** Reward per garbage line produced (before cancellation — cancelling is defence). */
  readonly attack: number;
  /** Extra shaping per clear type, on top of the attack it produced. */
  readonly clear: Readonly<Record<ClearKind, number>>;
  /** Penalty for ending a back-to-back chain with a plain clear. */
  readonly b2bBreak: number;
  /** Penalty for locking a T without a spin while a T-slot was available. */
  readonly wastedT: number;
  /** Per-ply multiplier on later rewards (1 = undiscounted). */
  readonly discount: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  board: {
    maxHeight: -6,
    danger: -40,
    holes: -60,
    holeCover: -12,
    holeRows: -40,
    bumpiness: -8,
    bumpinessSq: -3,
    rowTransitions: -6,
    wellDepth: 18,
    extraWells: -40,
    tSlot: 60,
  },
  attack: 90,
  clear: {
    single: -60,
    double: -40,
    triple: -30,
    quad: 60,
    tspinMini: -20,
    tspinSingle: 40,
    tspinDouble: 120,
    tspinTriple: 160,
    perfectClear: 400,
  },
  b2bBreak: -90,
  wastedT: -50,
  discount: 0.97,
};
