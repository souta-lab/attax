/**
 * Public API for the reconstructed native Hoiko engine.
 *
 * `NativeInput.board` rows are bottom-up, native orientation (column c = bit
 * `9-c`). `current` is the observable active piece (planned from spawn);
 * `queue` is the observable next queue AFTER the current piece.
 */

import {
  HOIKO_DEFAULT_PRESET,
  hoikoWeightList,
  type HoikoPreset,
  type HoikoWeights,
} from "../hoiko-weights.js";
import { GamePack } from "./gamepack.js";
import { NextMino } from "./nextmino.js";
import { ACT_NONE, MINO_NONE, kindToMino, type MinoType } from "./shapes.js";
import {
  defaultSearchState,
  runSearch,
  setNextOption,
  type SearchOutcome,
  type SearchState,
} from "./search.js";
import type { PieceKind } from "../../core/pieces.js";

export interface NativeInput {
  readonly board: readonly number[];
  readonly current: PieceKind;
  readonly queue: readonly PieceKind[];
  readonly hold: PieceKind | null;
  readonly combo: number;
  readonly btb: number;
}

export interface NativeMove {
  readonly rotation: number;
  readonly x: number;
  readonly useHold: boolean;
  readonly score: number;
}

export interface NativeSearchOptions {
  readonly searchState?: SearchState;
  readonly weights?: readonly HoikoWeights[];
  readonly weightPreset?: HoikoPreset;
  readonly viewNext?: number;
  readonly isEvenBoard?: boolean;
  readonly useS4W?: boolean;
  readonly timeLimitMs?: number;
  readonly now?: () => number;
  readonly allowHold?: boolean;
  readonly feedQueue?: boolean;
  readonly adapt?: boolean;
}

export const DEFAULT_VIEW_NEXT = 2;

/**
 * Build the search root. `feedQueue` (default true) copies the observable
 * upcoming pieces over the bag prediction in `m`, because the caller's engine
 * exposes the real queue (the binary only ever sees `viewNext` of it). The
 * `trustEnd` window still comes from `NextMino.Compare`, so the trust gates are
 * unchanged.
 */
export function buildRoot(input: NativeInput, viewNext: number, feedQueue = false): GamePack {
  const g = new GamePack();
  g.board.init();
  for (let y = 0; y < input.board.length && y < 32; y += 1) g.board.line[y] = input.board[y] ?? 0;
  g.board.updateMaxHeight();
  g.hold.init();
  g.hold.m = input.hold === null ? MINO_NONE : kindToMino(input.hold);
  g.commands.init();
  g.combo = input.combo;
  g.btb = input.btb;
  g.act = ACT_NONE;
  g.fallingMino.init();
  g.lockedMino.init();
  const next = new NextMino();
  next.viewNext = viewNext;
  const realNext: MinoType[] = [kindToMino(input.current), ...input.queue.map(kindToMino)];
  next.init(realNext);
  if (feedQueue) {
    for (let i = 0; i < realNext.length && i < next.m.length; i += 1) {
      next.m[i] = realNext[i] ?? MINO_NONE;
    }
  }
  g.setNewCurrent(next);
  return g;
}

export interface NativeSearchRun {
  readonly outcome: SearchOutcome;
  readonly root: GamePack;
}

export function searchNative(
  input: NativeInput,
  options: NativeSearchOptions = {},
): NativeSearchRun | null {
  const viewNext = options.viewNext ?? DEFAULT_VIEW_NEXT;
  const state = options.searchState ?? defaultSearchState();
  const weightList =
    options.weights ?? hoikoWeightList(options.weightPreset ?? HOIKO_DEFAULT_PRESET);
  const root = buildRoot(input, viewNext, options.feedQueue ?? false);
  const now = options.now ?? ((): number => performance.now());
  const outcome = runSearch(
    state,
    root,
    weightList,
    options.isEvenBoard ?? true,
    options.useS4W ?? false,
    viewNext,
    now,
    options.timeLimitMs,
    options.allowHold ?? true,
  );
  if (outcome === null) return null;
  if (options.adapt ?? true) {
    setNextOption(
      state,
      outcome.overTime,
      outcome.depth,
      outcome.moveDelay,
      outcome.firstAct,
      root.isSafe(),
    );
  }
  return { outcome, root };
}

/** Convenience one-shot: returns the best first move for the given state. */
export function nativeBestMove(
  input: NativeInput,
  options: NativeSearchOptions = {},
): NativeMove | null {
  const run = searchNative(input, options);
  if (run === null) return null;
  const o = run.outcome;
  return {
    rotation: ((o.firstR % 4) + 4) % 4,
    x: o.firstX,
    useHold: o.firstHold,
    score: o.score,
  };
}

export { defaultSearchState, setNextOption } from "./search.js";
export type { SearchState, SearchOutcome } from "./search.js";
export { GamePack } from "./gamepack.js";
export { Board, popCount, log2, FULL_ROW } from "./board.js";
export { FallMino, Command, HoldMino } from "./mino.js";
export { NextMino, NextIterator } from "./nextmino.js";
export { expandNode } from "./expand.js";
export { evaluate, evaluateFirst, transitionWeight } from "./evaluate.js";
export { searchPcBoard } from "./evaluate-pc.js";
export { searchTsd, searchTst } from "./evaluate-tsd.js";
export { searchDTCannon } from "./evaluate-dtcannon.js";
export {
  ACT_NONE,
  ACT_SINGLE,
  ACT_DOUBLE,
  ACT_TRIPLE,
  ACT_QUAD,
  ACT_TSS,
  ACT_TSD,
  ACT_TST,
  ACT_TSM,
  ACT_PC,
  MINO_I,
  MINO_J,
  MINO_L,
  MINO_O,
  MINO_T,
  MINO_S,
  MINO_Z,
  MINO_NONE,
  kindToMino,
  minoToKind,
  shapeFor,
} from "./shapes.js";
export type { ClearAct, MinoType } from "./shapes.js";
