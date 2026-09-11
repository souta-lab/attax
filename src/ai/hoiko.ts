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
 * available queue by beamBestMove). Move execution uses the search-generated
 * SRS path from spawn state; other states use the controller's safe fallback.
 *
 * GameState -> afterstate/PlyContext mapping (see hoiko-eval.ts for the board
 * bit-orientation conversion):
 *   board.line[] / stackHeight  -> after (converted to native orientation)
 *   hold.m                      -> ctx.hold (hold after the placement)
 *   fallingMino.m               -> ctx.nextPiece (piece placed next)
 *   lockedMino.m                -> ctx.piece (piece just placed)
 *   others.combo / btb / act    -> derived from ctx.combo/ctx.b2b + lines/tspin
 *   commands.moveDelay          -> estimated from the selected execution path
 */

import type { Board } from "../core/board.js";
import type { AiDebug, AiExecutionPlan, AiMove, GameSnapshot } from "../ui/types.js";
import type { VersusFighter } from "../versus/controller.js";
import { isEvenPop, toSourceBoard, transitionWeight } from "./hoiko-eval.js";
import {
  calcOpponentsAtk,
  canWaitGarbage,
  computeOffsetData,
  isInCoolTime,
  newGarbageData,
  setCoolTimeAfterClearing,
  setRemainingTime,
  type GarbageData,
} from "./hoiko-offset.js";
import { hoikoBeamSearch } from "./hoiko-search.js";
import {
  HOIKO_DEFAULT_PRESET,
  type HoikoPreset,
  type HoikoWeights,
  hoikoWeightList,
} from "./hoiko-weights.js";

const HOIKO_BOARD_ROWS = 32;

export type { HoikoPreset, HoikoWeights } from "./hoiko-weights.js";
export {
  HOIKO_DEFAULT_PRESET,
  hoikoPresetWeights,
  parseHoikoWeights,
} from "./hoiko-weights.js";

const HOIKO_WIDTH = 50;
const HOIKO_DEPTH = 14;
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
  const board: Board = new Uint16Array(HOIKO_BOARD_ROWS);
  const rows = s.board.rows;
  for (let y = 0; y < rows && y < HOIKO_BOARD_ROWS; y += 1) {
    const src = s.board.grid[rows - 1 - y];
    if (src === undefined) continue;
    let bits = 0;
    for (let x = 0; x < 10; x += 1) if ((src[x] ?? 0) !== 0) bits |= 1 << x;
    board[y] = bits;
  }
  return board;
}

function boardFingerprint(s: GameSnapshot): string {
  const rows: number[] = [];
  for (let y = 0; y < s.board.rows; y += 1) {
    const row = s.board.grid[s.board.rows - 1 - y];
    let bits = 0;
    for (let x = 0; x < 10; x += 1) {
      if ((row?.[x] ?? 0) !== 0) bits |= 1 << x;
    }
    rows.push(bits);
  }
  return rows.join(",");
}

function normalizeExecution(s: GameSnapshot, execution: AiExecutionPlan): AiExecutionPlan {
  const active = s.active;
  if (active === null) return execution;
  return {
    ...execution,
    expectedBoard: execution.expectedBoard.slice(0, s.board.rows),
    sourceActiveKind: active.kind,
    sourceRotation: active.rotation,
    sourceX: active.posX,
    sourceBoardFingerprint: boardFingerprint(s),
    sourceHold: s.hold,
    sourceCanHold: s.canHold,
  };
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
  readonly move: { readonly x: number; readonly rotation: number; readonly useHold: boolean };
  readonly after: Board;
  readonly score: number;
  readonly linesCleared: number;
  readonly isTspin: boolean;
  readonly thinkMs: number;
}

/** Build a Hoiko replica fighter. */
export function createHoiko(options: HoikoOptions = {}): VersusFighter {
  const preset = options.weightPreset ?? HOIKO_DEFAULT_PRESET;
  const weightList = options.weights === undefined ? hoikoWeightList(preset) : [options.weights];
  const width = options.width ?? HOIKO_WIDTH;
  const depth = options.depth ?? HOIKO_DEPTH;
  let last: HoikoDebugState | null = null;
  let garbageData: GarbageData = newGarbageData();
  let lastOwnLock = -1;
  let lastOpponentLock = -1;
  return {
    name: "HOIKO",
    color: HOIKO_COLOR,
    findBestMove: (s: GameSnapshot): AiMove | null => {
      const t0 = performance.now();
      if (s.active === null || s.gameOver) return null;
      if (s.lockId < lastOwnLock) {
        garbageData = newGarbageData();
        lastOwnLock = -1;
        lastOpponentLock = -1;
      }
      const frame = Math.trunc(performance.now() * 0.06);
      if (s.lockId !== lastOwnLock) {
        if (lastOwnLock >= 0) {
          setCoolTimeAfterClearing(garbageData, frame, s.lastAttack, s.lockId);
        }
        lastOwnLock = s.lockId;
      }
      const opponentLock = s.opponentLockId ?? 0;
      if (opponentLock !== lastOpponentLock) {
        const lines = s.opponentLastClearLines ?? 0;
        calcOpponentsAtk(
          garbageData,
          lines,
          s.opponentLastNativeBtb ?? 0,
          (s.opponentLastNativeBtb ?? 0) > 1 ? 1 : 0,
          s.opponentLastNativeCombo ?? s.opponentCombo ?? 0,
        );
        lastOpponentLock = opponentLock;
      }
      const board = toBoard(s);
      const rootSrc = toSourceBoard(board);
      const isEvenBoard = isEvenPop(rootSrc);
      const weightIndex = transitionWeight(rootSrc, 0, isEvenBoard);
      const ew = weightList[weightIndex] ?? weightList[0];
      if (ew === undefined) return null;
      const move = hoikoBeamSearch(
        board,
        s.active.kind,
        s.next,
        s.hold,
        s.canHold,
        s.nativeBtb,
        s.nativeCombo,
        ew,
        {
          width,
          depth,
          useHold: options.useHold ?? true,
          pending: s.pendingGarbage,
          isEvenBoard,
          weightIndex,
        },
      );
      if (move === null) return null;
      const offset = computeOffsetData(
        board,
        s.next,
        s.hold,
        s.nativeBtb,
        move.planActs,
        isEvenBoard,
      );
      const execution =
        move.useHold ||
        move.execution === undefined ||
        s.active.rotation !== 0 ||
        s.active.posX !== 3
          ? undefined
          : normalizeExecution(s, move.execution);
      last = {
        move,
        after: move.after,
        score: move.score,
        linesCleared: move.linesCleared,
        isTspin: move.isTspin,
        thinkMs: performance.now() - t0,
      };
      setRemainingTime(garbageData, move.planActs[0] ?? "None");
      const opponentCombo = s.opponentCombo ?? 0;
      return {
        targetX: move.x,
        targetRotation: move.rotation,
        useHold: move.useHold,
        ...(execution === undefined ? {} : { execution }),
        garbageWait:
          !isInCoolTime(garbageData, frame) &&
          canWaitGarbage(offset, s.pendingGarbage, opponentCombo, isEvenBoard),
      };
    },
    getDebug: (): AiDebug | null => {
      if (last === null) return null;
      const stats = boardStats(last.after);
      return {
        score: last.score,
        fireScore: 0,
        linesCleared: last.linesCleared,
        isTspin: last.isTspin,
        opener: null,
        topHoles: stats.holes,
        topMaxHeight: stats.maxHeight,
        thinkMs: last.thinkMs,
      };
    },
  };
}
