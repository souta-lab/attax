/**
 * The search core's option/result types, vendored from src/ai/bot/search.ts
 * in Phase C (2026-11-19) when the TS search was removed. The GPU driver is
 * the only engine left; it consumes and produces these shapes (SearchResult
 * is what the codec reconstructs from a serve block), so the types live with
 * the lab now. Definitions are verbatim; only import paths were adjusted.
 */
import type { Placement } from "./board.js";
import type { SolvencyParams } from "./solvency.js";
import type { NodeState } from "./state.js";
import type { StockParams } from "./stock.js";
import type { Weights } from "./weights.js";

export type SearchProfile = "guideline" | "s2";

export interface SearchOptions {
  readonly weights: Weights;
  readonly width: number;
  /** Preserve roots and attack-economy states in competition search. */
  readonly diverse?: boolean;
  /** Cost per squared exposed row on every intermediate board. */
  readonly exposure?: number;
  /** External guideline rig: no combo/PC attack; lock-out above row 20. */
  readonly guideline?: boolean;
  /**
   * Rules profile (src/core/profile.ts). Selects the full rules semantics, not
   * only the dedupe key: "guideline" (default) is the frozen Hoiko/TBP search;
   * "s2" is the TETR.IO S2 lab search (exact B2B chain, staged S2 awards and
   * frame multiplier, All-Mini+ spins, 180 rotations, materialized garbage with
   * carried pending, terminal death at row 21, full-provenance dedupe key).
   * The guideline-rig option `guideline` is ignored under "s2".
   */
  readonly profile?: SearchProfile;
  /** S2 only — C1 stock potential (canonical §C1). Absent or scale 0 = Φ ≡ 0. */
  readonly stock?: StockParams;
  /** S2 only — C2 solvency layer (canonical §C2). Absent or coefficient 0 = no penalty. */
  readonly solvency?: SolvencyParams;
  /**
   * S2 only — hard root solvency veto: the champion's choose_rescue as a pure
   * decision-stage filter over the ranked root lines (see search()).
   * Absent/false = no veto; the search values are never modified by it.
   */
  readonly rootVeto?: boolean;
  /**
   * S2 only — garbage-scenario root scoring (canonical §C2, item 100): extra
   * pending rows per scenario. The actual input is always scenario 0; every
   * root is scored by its WORST best-line value across the shared scenario set
   * (see searchWithGarbageScenarios). Absent = off (plain search).
   */
  readonly garbageScenarios?: readonly number[];
  /**
   * Also return the best line's predicted node states (SearchResult.lineStates).
   * Opt-in so that results stay byte-identical for every existing consumer that
   * serializes whole results (the S2 golden parity tests, case dumps).
   */
  readonly lineStates?: boolean;
}

export interface Step {
  readonly placement: Placement;
  readonly usedHold: boolean;
  readonly linesCleared: number;
  readonly attack: number;
  readonly reward: number;
}

/** One candidate first move with the value of the best line that starts with it. */
export interface Candidate {
  readonly placement: Placement;
  readonly usedHold: boolean;
  readonly value: number;
}

export interface SearchResult {
  readonly best: Step;
  /** The full planned line (first element = `best`). */
  readonly line: readonly Step[];
  readonly value: number;
  /** Shape breakdown of the board after the first move (feature -> weighted points). */
  readonly breakdown: Readonly<Record<string, number>>;
  /** Best first moves, best first. */
  readonly candidates: readonly Candidate[];
  readonly nodes: number;
  readonly depth: number;
  /**
   * Only with SearchOptions.lineStates: the search's own predicted states along
   * the returned line — lineStates[k] is the state after k locks of `line`
   * (lineStates[0] = the root state). The GPU engine's wire format does not
   * carry it, so GPU results never have it.
   */
  readonly lineStates?: readonly NodeState[];
}

/**
 * Per-decider call options at the lab boundary (the shape the lab's decider
 * factories accepted): an optional explicit beam width, and the lineStates
 * request (plan carry-over's input). The GPU decider reads only lineStates —
 * and refuses it, because the wire format carries no per-step states.
 */
export interface DeciderOptions {
  readonly width?: number;
  readonly lineStates?: boolean;
}
