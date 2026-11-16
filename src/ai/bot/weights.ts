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
  /** S2 root reward per attack line left after cancelling known incoming garbage. */
  readonly conversion: number;
  /** Extra shaping per clear type, on top of the attack it produced. */
  readonly clear: Readonly<Record<ClearKind, number>>;
  /** Penalty for ending a back-to-back chain with a plain clear. */
  readonly b2bBreak: number;
  /** Penalty for locking a T without a spin while a T-slot was available. */
  readonly wastedT: number;
  /** Per-ply multiplier on later rewards (1 = undiscounted). */
  readonly discount: number;
  /**
   * Adopt C1: terminal state value of B2B being alive, added to the board evaluation of
   * every node (so the leaf's terminal state carries it). 0 or absent = off, and the
   * search skips the term entirely so off is bit-identical.
   */
  readonly b2bState?: number;
  /** C2: value per donation clearing 0..3 lines; all zero/absent skips the scan. */
  readonly tSlotChain0?: number;
  readonly tSlotChain1?: number;
  readonly tSlotChain2?: number;
  readonly tSlotChain3?: number;
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
  conversion: 0,
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
  b2bState: 0,
  tSlotChain0: 0,
  tSlotChain1: 0,
  tSlotChain2: 0,
  tSlotChain3: 0,
};
