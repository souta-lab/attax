/**
 * Hoiko opponent replica — exact port of EvaluateAI from TetrizAI_Evaluate.cpp.
 *
 * The fighter drives our beam machinery (beamBestMove) with a scorer that
 * reproduces Hoiko's own evaluation. The beam's built-in Dellacherie base score
 * and fire score are zeroed so the accumulated leaf value equals Hoiko's
 * evaluation; `sustainCredit` is an unconditional beam term we cannot disable
 * through options, so the scorer subtracts it to keep Hoiko's score exact.
 *
 * Defaults follow config.dll: beamSize 50, minDepth 10, useHold true,
 * viewNext 2 (our engine exposes 5 next pieces, so depth is clamped to the
 * available queue by beamBestMove). Move execution is stepwise (no kicks),
 * matching a hard-drop-only bot.
 *
 * GameState -> afterstate/PlyContext mapping (see hoiko-eval.ts for the board
 * bit-orientation conversion):
 *   board.line[] / stackHeight  -> after (converted to native orientation)
 *   hold.m                      -> ctx.hold (hold after the placement)
 *   fallingMino.m               -> ctx.nextPiece (piece placed next)
 *   lockedMino.m                -> ctx.piece (piece just placed)
 *   others.combo / btb / act    -> derived from ctx.combo/ctx.b2b + lines/tspin
 *   commands.moveDelay          -> 0 (approximation; the term is 0 for small delays)
 */

import type { Board } from "../core/board.js";
import type { AiDebug, AiMove, GameSnapshot } from "../ui/types.js";
import type { VersusFighter } from "../versus/controller.js";
import {
  type BeamMove,
  beamBestMove,
  createBeamEvaluation,
  type PlyScorer,
  sustainCredit,
} from "./beam.js";
import type { BeamFireWeights } from "./evaluation.js";
import {
  type ClearAct,
  evaluateNode,
  isEvenPop,
  toSourceBoard,
  transitionWeight,
} from "./hoiko-eval.js";
import {
  HOIKO_DEFAULT_PRESET,
  type HoikoPreset,
  type HoikoWeights,
  hoikoWeightList,
} from "./hoiko-weights.js";
import { ROWS } from "./types.js";
import type { Weights } from "./weights.js";

export type { HoikoPreset, HoikoWeights } from "./hoiko-weights.js";
export {
  HOIKO_DEFAULT_PRESET,
  hoikoPresetWeights,
  parseHoikoWeights,
} from "./hoiko-weights.js";

/** No built-in Dellacherie term: Hoiko's weights carry the whole evaluation. */
const ZERO_WEIGHTS: Weights = {
  landingHeight: 0,
  erodedCells: 0,
  rowTransitions: 0,
  colTransitions: 0,
  holes: 0,
  wells: 0,
  holeDepth: 0,
  rowsWithHoles: 0,
  bumpiness: 0,
  maxHeight: 0,
  linesCleared: 0,
};

/** No built-in fire term; clear/PC/combo rewards come from Hoiko weights. */
const ZERO_FIRE: BeamFireWeights = {
  tetris: 0,
  tspin: 0,
  tspinSingle: 0,
  tspinDouble: 0,
  tspinTriple: 0,
  b2bBonus: 0,
  comboStep: 0,
  perfectClear: 0,
  wellStep: 0,
  tslotStep: 0,
};

const HOIKO_WIDTH = 50;
const HOIKO_DEPTH = 10;
const HOIKO_COLOR = "#e94fb0";

export interface HoikoOptions {
  readonly weightPreset?: HoikoPreset | undefined;
  readonly width?: number | undefined;
  readonly depth?: number | undefined;
  readonly topK?: number | undefined;
  readonly useHold?: boolean | undefined;
  /** Explicit weights override (tests/replays); otherwise the preset is used. */
  readonly weights?: HoikoWeights | undefined;
}

function toBoard(s: GameSnapshot): Board {
  const board: Board = new Uint16Array(ROWS);
  const rows = s.board.rows;
  for (let y = 0; y < rows && y < ROWS; y += 1) {
    const src = s.board.grid[rows - 1 - y];
    if (src === undefined) continue;
    let bits = 0;
    for (let x = 0; x < 10; x += 1) if ((src[x] ?? 0) !== 0) bits |= 1 << x;
    board[y] = bits;
  }
  return board;
}

function isEmpty(board: Board): boolean {
  for (let y = 0; y < board.length; y += 1) if ((board[y] ?? 0) !== 0) return false;
  return true;
}

interface SourceOthers {
  readonly combo: number;
  readonly btb: number;
  readonly act: ClearAct;
}

/**
 * Derive Hoiko's `others` (combo/btb/act) for an afterstate from the beam's
 * context. The beam's combo is 0-based (first clear -> 0) while Hoiko's is
 * 1-based (first clear -> 1), so `sourcePrev = ctx.combo + 1` when ctx.combo>=0.
 * The beam's b2b is a boolean; Hoiko's btb is a count, so `btb > 1` is
 * approximated as "this placement is a b2b clear and b2b was already active".
 */
function sourceOthers(
  ctx: { readonly combo: number; readonly b2b: boolean },
  lines: number,
  tspin: boolean,
  after: Board,
): SourceOthers {
  const sourcePrev = ctx.combo >= 0 ? ctx.combo + 1 : 0;
  const combo = lines > 0 ? sourcePrev + 1 : sourcePrev > 0 ? -sourcePrev : 0;
  const isPc = lines > 0 && isEmpty(after);
  const isB2bClear = lines === 4 || (tspin && lines > 0);
  let btb: number;
  if (lines === 0) btb = ctx.b2b ? 1 : 0;
  else if (isPc) btb = lines >= 4 ? (ctx.b2b ? 2 : 1) : 0;
  else if (isB2bClear) btb = ctx.b2b ? 2 : 1;
  else btb = 0;
  let act: ClearAct;
  if (lines === 0) act = "None";
  else if (isPc) act = "Pc";
  else if (lines === 4) act = "Quad";
  else if (tspin) act = lines === 1 ? "Tss" : lines === 2 ? "Tsd" : "Tst";
  else act = lines === 1 ? "Single" : lines === 2 ? "Double" : "Triple";
  return { combo, btb, act };
}

function boardStats(after: Board): { readonly holes: number; readonly maxHeight: number } {
  const heights = new Array<number>(10).fill(0);
  for (let x = 0; x < 10; x += 1) {
    for (let y = after.length - 1; y >= 0; y -= 1) {
      if (((after[y] ?? 0) & (1 << x)) !== 0) {
        heights[x] = y + 1;
        break;
      }
    }
  }
  let maxHeight = 0;
  for (const h of heights) if (h > maxHeight) maxHeight = h;
  let holes = 0;
  for (let x = 0; x < 10; x += 1) {
    let seen = false;
    for (let y = after.length - 1; y >= 0; y -= 1) {
      const filled = ((after[y] ?? 0) & (1 << x)) !== 0;
      if (filled) seen = true;
      else if (seen) holes += 1;
    }
  }
  return { holes, maxHeight };
}

interface HoikoDebugState {
  readonly move: BeamMove;
  readonly thinkMs: number;
}

/** Build a Hoiko replica fighter. */
export function createHoiko(options: HoikoOptions = {}): VersusFighter {
  const preset = options.weightPreset ?? HOIKO_DEFAULT_PRESET;
  const weightList = options.weights === undefined ? hoikoWeightList(preset) : [options.weights];
  const width = options.width ?? HOIKO_WIDTH;
  const depth = options.depth ?? HOIKO_DEPTH;
  const topK = options.topK ?? width;
  const useHold = options.useHold ?? true;
  let last: HoikoDebugState | null = null;
  return {
    name: "HOIKO",
    color: HOIKO_COLOR,
    findBestMove: (s: GameSnapshot): AiMove | null => {
      const t0 = performance.now();
      if (s.active === null || s.gameOver) return null;
      const board = toBoard(s);
      const rootSrc = toSourceBoard(board);
      const isEvenBoard = isEvenPop(rootSrc);
      const weightIndex = transitionWeight(rootSrc, 0, isEvenBoard);
      const ew = weightList[weightIndex] ?? weightList[0];
      if (ew === undefined) return null;
      const scorer: PlyScorer = (after, lines, tspin, ctx) => {
        const src = toSourceBoard(after);
        const others = sourceOthers(ctx, lines, tspin, after);
        const trustRate = ctx.ply >= 4 ? 0.9 : 1.0;
        const score = evaluateNode(
          src,
          {
            act: others.act,
            combo: others.combo,
            btb: others.btb,
            lockedMino: ctx.piece ?? "I",
            hold: ctx.hold ?? null,
            fallingMino: ctx.nextPiece ?? ctx.piece ?? "I",
            moveDelay: 0,
          },
          ew,
          weightIndex,
          isEvenBoard,
          false,
          false,
          trustRate,
        );
        return score - sustainCredit(after, lines, tspin, ctx.ply);
      };
      const move = beamBestMove(
        board,
        s.active.kind,
        [...s.next, ...s.next, ...s.next],
        s.hold,
        s.canHold,
        s.b2b,
        s.combo,
        {
          weights: ZERO_WEIGHTS,
          fireWeights: ZERO_FIRE,
          width,
          depth,
          topK,
          useHold,
          pending: s.pendingGarbage,
          useKick: false,
          evaluation: createBeamEvaluation({ scorer }),
        },
      );
      if (move === null) return null;
      last = { move, thinkMs: performance.now() - t0 };
      return {
        targetX: move.x,
        targetRotation: move.rotation,
        useHold: move.useHold,
        ...(move.execution === undefined ? {} : { execution: move.execution }),
      };
    },
    getDebug: (): AiDebug | null => {
      if (last === null) return null;
      const stats = boardStats(last.move.after);
      return {
        score: last.move.score,
        fireScore: last.move.fireScore,
        linesCleared: last.move.linesCleared,
        isTspin: last.move.isTspin,
        opener: null,
        topHoles: stats.holes,
        topMaxHeight: stats.maxHeight,
        thinkMs: last.thinkMs,
      };
    },
  };
}
