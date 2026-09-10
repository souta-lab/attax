/**
 * Hoiko opponent replica.
 *
 * Hoiko (Hoiko_PPT_v0-beta1) is a Puyo Puyo Tetris bot whose evaluation is
 * driven by plaintext weights (evidence/hoiko/analysis.md). This module rebuilds
 * it as a VersusFighter on top of our beam machinery:
 *
 *   beamBestMove(...) + createBeamEvaluation({ scorer })
 *
 * The beam's built-in Dellacherie base score and fire score are zeroed so the
 * accumulated leaf value equals Hoiko's own evaluation (see `ZERO_WEIGHTS` /
 * `ZERO_FIRE`). `sustainCredit` is an unconditional beam term we cannot disable
 * through options, so the scorer subtracts it; this keeps Hoiko's score exact.
 *
 * Defaults follow config.dll: beamSize 50, minDepth 10, useHold true,
 * viewNext 2 (our engine exposes 5 next pieces, so depth is clamped to the
 * available queue by beamBestMove). Move execution is stepwise (no kicks),
 * matching a hard-drop-only bot.
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
import { scanHoikoBoard } from "./hoiko-board.js";
import { extractHoikoFeatures, type HoikoResources, scoreHoikoFeatures } from "./hoiko-features.js";
import {
  HOIKO_DEFAULT_PRESET,
  type HoikoPreset,
  type HoikoWeights,
  hoikoPresetWeights,
} from "./hoiko-weights.js";
import { ROWS } from "./types.js";
import type { Weights } from "./weights.js";

export type { HoikoFeatures, HoikoResources } from "./hoiko-features.js";
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

interface HoikoDebugState {
  readonly move: BeamMove;
  readonly thinkMs: number;
}

/** Build a Hoiko replica fighter. */
export function createHoiko(options: HoikoOptions = {}): VersusFighter {
  const preset = options.weightPreset ?? HOIKO_DEFAULT_PRESET;
  const weights = options.weights ?? hoikoPresetWeights(preset);
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
      const resources: HoikoResources = {
        hold: s.hold,
        canHold: s.canHold,
        queue: s.next.slice(0, 5),
      };
      const scorer: PlyScorer = (after, lines, tspin, ctx) => {
        const features = extractHoikoFeatures(after, lines, tspin, ctx, resources);
        return scoreHoikoFeatures(features, weights) - sustainCredit(after, lines, tspin, ctx.ply);
      };
      const move = beamBestMove(
        board,
        s.active.kind,
        resources.queue,
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
      const stats = scanHoikoBoard(last.move.after);
      return {
        score: last.move.score,
        fireScore: last.move.fireScore,
        linesCleared: last.move.linesCleared,
        isTspin: last.move.isTspin,
        opener: null,
        topHoles: stats.cover,
        topMaxHeight: stats.maxHeight,
        thinkMs: last.thinkMs,
      };
    },
  };
}
