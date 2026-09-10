// "DeepSeek Tetris" — the project's single AI.
//
// Reset to the V8 seal: the scoring/beam policy below is byte-equivalent to the
// frozen V8 candidate (see freeze/v8) with kicks disabled. The former co-evolution
// experiment, the V9 veto, and the useKick/placementGenerator knobs are retired.
import { type Board, COLS } from "../core/board.js";
import { attackForClear } from "../core/garbage.js";
import type { PieceKind } from "../core/pieces.js";
import type { AiDebug, AiMove, GameSnapshot } from "../ui/types.js";
import { type BeamMove, beamBestMove, createBeamEvaluation, type PlyContext } from "./beam.js";
import {
  dsBumpExWell,
  dsCapped,
  dsCountHoles,
  dsCountTslots,
  dsEmergency,
  dsFloatWell,
  dsGamma,
  dsHeightPressure,
  dsHeights,
  dsHigh,
  dsVeto,
  dsWell,
} from "./deepseek-score.js";
import { extractFeatures } from "./features.js";
import { ROWS } from "./types.js";
import { DU_WEIGHTS, FIRE_WEIGHTS, type Weights } from "./weights.js";

export const DEEPSEEK_NAME = "DEEPSEEK";

export const DEEPSEEK_WEIGHTS: Weights = {
  ...DU_WEIGHTS,
  holes: -14.5,
  wells: -11.0,
  rowsWithHoles: -26.0,
  maxHeight: -3.6,
};

const DEEPSEEK_FIRE = { ...FIRE_WEIGHTS, wellStep: 7, tslotStep: 42 } as const;

const ATK_W = 142;
const TSD_EXEC = 205;
const TETRIS_EXEC = 320;
const TRIPLE_EXEC = 340;
const TRIPLE_ARRIVAL = 220;
const B2B_CHAIN = 130;
const B2B_BREAK = 120;
const CAVITY_STEP = 25;
const COMBO_KEEP = 60;
const COMBO_BREAK = 60;
const REN_STEP = 55;
const REN_START = 2;
const REN_LATE_STEP = 110;
const REN_LATE_N = 150;
const URGENCY_W = 32;
const DIG_BONUS = 145;
const DIG_HOLD = 45;
const EMERG_LINE = 14;
const TSD_ARRIVAL = 340;
const TETRIS_ARRIVAL = 460;
const WELL_PLY_STEP = 30;
const TSLOT_KEEP2 = 42;
const WELL_EDGE_BONUS = 34;
const WELL_CENTER_PEN = 55;
const TETRIS_READY = 170;
const TETRIS_EXEC_DEEP = 340;
const TSD_EXEC_DEEP = 220;
const WASTED_T_CLEAR = 150;
const WASTED_T_IDLE = 20;
const WASTED_I_CLEAR = 110;
const WASTED_I_IDLE = 20;
const BUMP_CAP = 8;
const BUMP_STEP = 22;
const LATE_PIECE_N = 60;
const LATE_MULT = 1.15;
const HOLE_EXTRA = 14;
const OPENING_N = 30;
const READY_DEPTH = 4;
const EXECUTE_BONUS = 420;
const FILL_PEN = 80;
const WELL_FILL_LOSS = 40;
const DIG_H20_STEP = 220;
const RESERVE_CEIL = 13;
const HOLE_DIVE_STEP = 18;
const B2B_WEAK_EXTRA = 60;
const B2B_TSLOT_EXTRA = 50;
const WELL_REBUILD_STEP = 22;
const REN_CALM_KEEP = 30;

function hasI(hold: PieceKind | null, canHold: boolean, queue: readonly PieceKind[]): boolean {
  if (hold === "I" && canHold) return true;
  for (const k of queue) if (k === "I") return true;
  return false;
}

function deepSeekScorer(
  hold: PieceKind | null,
  canHold: boolean,
  queue: readonly PieceKind[],
  pieces: number,
): (after: Board, lines: number, tspin: boolean, ctx: PlyContext) => number {
  const opening = pieces < OPENING_N;
  const late = pieces >= LATE_PIECE_N ? LATE_MULT : 1;
  const iAvail = hasI(hold, canHold, queue);
  return (after, lines, tspin, ctx) => {
    const feat = extractFeatures(after, 0, 0);
    const ncombo = lines > 0 ? ctx.combo + 1 : -1;
    const atk = attackForClear({
      lines,
      tspinLines: tspin ? lines : 0,
      combo: ncombo,
      b2bActive: ctx.b2b,
      perfectClear: feat.maxHeight === 0,
    });
    const h = dsHeights(after);
    const well = dsWell(after, h, 6);
    const emerg = dsEmergency(ctx.pending, well.globalMax);
    let s = atk * ATK_W * late;
    if (tspin && lines > 0) s += TSD_EXEC;
    if (lines === 4) s += TETRIS_EXEC;
    if (lines === 3) s += TRIPLE_EXEC + TRIPLE_ARRIVAL / (ctx.ply + 1);
    if ((lines === 4 || (tspin && lines > 0)) && ctx.b2b) s += B2B_CHAIN;
    if (lines > 0 && lines < 4 && !tspin && ctx.b2b) {
      if (emerg === 0) s -= B2B_BREAK + (lines <= 2 ? B2B_WEAK_EXTRA : 0);
    }
    if (lines === 0 && !tspin && ctx.b2b) {
      if (dsCountTslots(after, 1) > 0) s += B2B_TSLOT_EXTRA;
    }
    if (ctx.ply === 0 && opening) s -= feat.holes * HOLE_EXTRA;
    if (lines === 0 && !tspin) {
      const setups = dsCountTslots(after, 99);
      if (setups > 2) s -= (setups - 2) * CAVITY_STEP;
      const gamma = dsGamma(ctx.ply);
      const eMult = emerg === 2 ? 0.2 : emerg === 1 ? 0.5 : 1;
      const tslots = Math.min(2, dsCountTslots(after, 2));
      s += tslots * TSLOT_KEEP2 * gamma * eMult;
      const depth = Math.min(6, well.depth);
      s += depth * WELL_PLY_STEP * gamma * eMult;
      if (well.edge) {
        if (depth > 0) s += WELL_EDGE_BONUS * gamma * eMult;
      } else if (depth > 0) {
        s -= WELL_CENTER_PEN * gamma * eMult;
      }
      const bump = dsBumpExWell(h, well.col);
      if (bump > BUMP_CAP) s -= (bump - BUMP_CAP) * BUMP_STEP * gamma;
      const floatWell = dsFloatWell(h, 6);
      const floatDepth = Math.min(6, floatWell.depth);
      if (floatWell.edge && floatDepth > 0 && feat.holes > 0) {
        s += floatDepth * WELL_PLY_STEP * gamma * eMult;
      }
      const floatReady =
        floatWell.edge && floatDepth >= READY_DEPTH && feat.holes > 0 && well.globalMax >= 6;
      const readyDepth = Math.max(depth, floatReady ? floatDepth : 0);
      if (emerg === 0 && readyDepth >= READY_DEPTH && ctx.ply <= 2 && iAvail)
        s += TETRIS_READY * gamma;
      if (emerg === 0 && ctx.ply === 0 && readyDepth >= READY_DEPTH && iAvail) {
        if (well.maxExWell <= RESERVE_CEIL) s += EXECUTE_BONUS;
      }
    }
    if (lines > 0 && ctx.ply <= 2) {
      const floatAfter = dsFloatWell(h, 6);
      if (floatAfter.edge && floatAfter.depth >= READY_DEPTH && iAvail) {
        s += floatAfter.depth * WELL_REBUILD_STEP;
      }
    }
    if (ctx.ply === 0 && lines > 0 && lines < 4 && !tspin) {
      const h0 = dsHeights(after);
      const w0 = dsWell(after, h0, 6);
      if (w0.depth >= READY_DEPTH && w0.edge && iAvail) s -= FILL_PEN + w0.depth * WELL_FILL_LOSS;
    }
    if (lines > 0 && tspin) s += TSD_ARRIVAL / (ctx.ply + 1);
    if (lines === 4) s += TETRIS_ARRIVAL / (ctx.ply + 1);
    if (ctx.ply >= 1 && ctx.ply <= 3) {
      if (lines === 4) s += TETRIS_EXEC_DEEP;
      if (tspin && lines > 0) s += TSD_EXEC_DEEP;
    }
    if (lines > 0 && ncombo >= REN_START) {
      const renStep = pieces >= REN_LATE_N ? REN_LATE_STEP : REN_STEP;
      s += ncombo * renStep * late;
    }
    if (ctx.combo >= 2 && lines > 0) s += COMBO_KEEP;
    else if (ctx.combo >= 2 && lines === 0 && !tspin) {
      if (ctx.pending === 0 && emerg === 0 && feat.maxHeight < EMERG_LINE) s += REN_CALM_KEEP;
      else s -= COMBO_BREAK;
    }
    const pc = ctx.piece;
    if (pc === "T" && !(tspin && lines > 0)) {
      s += lines > 0 ? -WASTED_T_CLEAR : -WASTED_T_IDLE;
    }
    if (pc === "I" && emerg !== 2 && lines !== 4) {
      s += lines > 0 ? -WASTED_I_CLEAR : -WASTED_I_IDLE;
    }
    if (emerg > 0 && lines === 0 && !tspin) s -= dsHeightPressure(well.maxExWell);
    if (lines === 0 && !tspin && feat.maxHeight >= 17) {
      s -= (feat.maxHeight - 16) * DIG_H20_STEP;
    }
    if (lines === 0 && !tspin && well.globalMax >= 16) {
      const e2 = dsEmergency(ctx.pending, well.maxExWell);
      if (e2 === 2) s -= dsHeightPressure(well.globalMax) * 0.5;
    }
    if (ctx.pending > 0) {
      if (lines > 0) {
        s += ctx.pending * lines * URGENCY_W + DIG_BONUS * lines * (emerg === 2 ? 2 : 1);
        const holesAfter = dsCountHoles(after, h);
        if (holesAfter <= 5) s += (6 - holesAfter) * HOLE_DIVE_STEP * lines;
      } else if (feat.maxHeight >= EMERG_LINE) s -= dsHeightPressure(feat.maxHeight);
      else s -= DIG_HOLD;
    } else if (feat.maxHeight >= EMERG_LINE && lines > 0) {
      const holesAfter = dsCountHoles(after, h);
      if (holesAfter <= 5) s += (6 - holesAfter) * HOLE_DIVE_STEP * lines;
    }
    return s;
  };
}

function deepSeekVeto(pending: number): (after: Board, lines: number, tspin: boolean) => boolean {
  return (after, lines, tspin) => dsVeto(after, lines, pending, tspin);
}

export function toBoard(s: GameSnapshot): Board {
  const board: Board = new Uint16Array(ROWS);
  const rows = s.board.rows;
  for (let y = 0; y < rows && y < ROWS; y += 1) {
    const src = s.board.grid[rows - 1 - y];
    if (src === undefined) continue;
    let bits = 0;
    for (let x = 0; x < COLS; x += 1) {
      if ((src[x] ?? 0) !== 0) bits |= 1 << x;
    }
    board[y] = bits;
  }
  return board;
}

interface DeepSeekDebug {
  readonly mv: BeamMove;
  readonly thinkMs: number;
}

/**
 * Public options for the DeepSeek AI. The V8 seal ships with no tuning knobs:
 * the former BLUE/RED `useKick` and `placementGenerator` experiments are retired.
 */
export interface DeepSeekOptions {
  readonly _reserved?: never;
}

export interface DeepSeekTetris {
  readonly name: string;
  findBestMove(snapshot: GameSnapshot): AiMove | null;
  getDebug(): AiDebug | null;
}

export function createDeepSeekTetris(options: DeepSeekOptions = {}): DeepSeekTetris {
  void options;
  let last: DeepSeekDebug | null = null;
  let pieces = 0;
  return {
    name: DEEPSEEK_NAME,
    findBestMove: (s) => {
      const t0 = performance.now();
      if (s.active === null || s.gameOver) return null;
      pieces += 1;
      const seen = pieces;
      const board = toBoard(s);
      const cur: PieceKind = s.active.kind;
      const queue: readonly PieceKind[] = s.next.slice(0, 5);
      const empty = board.every((v) => v === 0);
      if (empty) {
        // Intentional: openings use default DU beam (no personality scorer/veto).
        // Cheap, diverse, and personality shaping starts once a stack exists.
        const mv0 = beamBestMove(board, cur, queue, s.hold, s.canHold, s.b2b, s.combo, {
          depth: 6,
          pending: s.pendingGarbage,
        });
        if (mv0 === null) return null;
        last = { mv: mv0, thinkMs: performance.now() - t0 };
        return {
          targetX: mv0.x,
          targetRotation: mv0.rotation,
          useHold: mv0.useHold,
          ...(mv0.execution === undefined ? {} : { execution: mv0.execution }),
        };
      }
      const deepSeekAdjust = (after: Board, _lines: number, _tspin: boolean): number => {
        void _lines;
        void _tspin;
        const h = dsHeights(after);
        let adj = -(dsCapped(after, h) * 30 + dsHigh(after) * 25);
        if (seen <= OPENING_N) adj -= dsCountHoles(after, h) * HOLE_EXTRA;
        return adj;
      };
      const mv = beamBestMove(board, cur, queue, s.hold, s.canHold, s.b2b, s.combo, {
        weights: DEEPSEEK_WEIGHTS,
        fireWeights: DEEPSEEK_FIRE,
        depth: 6,
        width: 24,
        topK: 16,
        useHold: true,
        pending: s.pendingGarbage,
        evaluation: createBeamEvaluation({
          scoreAdjust: deepSeekAdjust,
          scorer: deepSeekScorer(s.hold, s.canHold, queue, seen),
          legacyVeto: deepSeekVeto(s.pendingGarbage),
        }),
      });
      if (mv === null) return null;
      last = { mv, thinkMs: performance.now() - t0 };
      return {
        targetX: mv.x,
        targetRotation: mv.rotation,
        useHold: mv.useHold,
        ...(mv.execution === undefined ? {} : { execution: mv.execution }),
      };
    },
    getDebug: () => {
      if (last === null) return null;
      const h = dsHeights(last.mv.after);
      return {
        score: last.mv.score,
        fireScore: last.mv.fireScore,
        linesCleared: last.mv.linesCleared,
        isTspin: last.mv.isTspin,
        opener: null,
        topHoles: dsCountHoles(last.mv.after, h),
        topMaxHeight: h.reduce((m, v) => (v > m ? v : m), 0),
        thinkMs: last.thinkMs,
      };
    },
  };
}
