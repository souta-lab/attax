// Parameterized DeepSeek fighter for the versus tuner.
//
// This is a faithful transposition of the scorer in `src/ai/deepseek.ts` with
// every named constant replaced by a genome lookup. With `BASELINE_GENOME` it is
// behaviorally identical to `createDeepSeekTetris()` (asserted in
// tests/tuner.test.ts). It exists so a weight vector can be loaded into the
// gate's fighter WITHOUT editing src/ai/deepseek.ts.
//
// New file only. The algorithm structure (beam search, ply loop, veto, branch
// order) is unchanged; only the numeric constants are parameterized.

import {
  type BeamFireWeights,
  type BeamMove,
  beamBestMove,
  createBeamEvaluation,
  type PlyContext,
} from "../ai/beam.js";
import { toBoard } from "../ai/deepseek.js";
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
} from "../ai/deepseek-score.js";
import { extractFeatures } from "../ai/features.js";
import type { Board } from "../core/board.js";
import { attackForClear } from "../core/garbage.js";
import type { PieceKind } from "../core/pieces.js";
import type { AiDebug, AiMove, GameSnapshot } from "../ui/types.js";
import { decodeGenome, type Genome, type TunedParams, type TunedSearch } from "./genome.js";

export interface TunedDeepSeek {
  readonly name: string;
  findBestMove(snapshot: GameSnapshot): AiMove | null;
  getDebug(): AiDebug | null;
  reset(): void;
}

export interface TunedDeepSeekOptions {
  /** Override the beam search configuration (used only for the fast proxy). */
  readonly search?: TunedSearch | undefined;
}

function hasI(hold: PieceKind | null, canHold: boolean, queue: readonly PieceKind[]): boolean {
  if (hold === "I" && canHold) return true;
  for (const k of queue) if (k === "I") return true;
  return false;
}

function tunedScorer(
  p: TunedParams,
  hold: PieceKind | null,
  canHold: boolean,
  queue: readonly PieceKind[],
  pieces: number,
): (after: Board, lines: number, tspin: boolean, ctx: PlyContext) => number {
  const P = p.personality;
  const opening = pieces < P.OPENING_N;
  const late = pieces >= P.LATE_PIECE_N ? P.LATE_MULT : 1;
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
    let s = atk * P.ATK_W * late;
    if (tspin && lines > 0) s += P.TSD_EXEC;
    if (lines === 4) s += P.TETRIS_EXEC;
    if (lines === 3) s += P.TRIPLE_EXEC + P.TRIPLE_ARRIVAL / (ctx.ply + 1);
    if ((lines === 4 || (tspin && lines > 0)) && ctx.b2b) s += P.B2B_CHAIN;
    if (lines > 0 && lines < 4 && !tspin && ctx.b2b) {
      if (emerg === 0) s -= P.B2B_BREAK + (lines <= 2 ? P.B2B_WEAK_EXTRA : 0);
    }
    if (lines === 0 && !tspin && ctx.b2b) {
      if (dsCountTslots(after, 1) > 0) s += P.B2B_TSLOT_EXTRA;
    }
    if (ctx.ply === 0 && opening) s -= feat.holes * P.HOLE_EXTRA;
    if (lines === 0 && !tspin) {
      const setups = dsCountTslots(after, 99);
      if (setups > 2) s -= (setups - 2) * P.CAVITY_STEP;
      const gamma = dsGamma(ctx.ply);
      const eMult = emerg === 2 ? 0.2 : emerg === 1 ? 0.5 : 1;
      const tslots = Math.min(2, dsCountTslots(after, 2));
      s += tslots * P.TSLOT_KEEP2 * gamma * eMult;
      const depth = Math.min(6, well.depth);
      s += depth * P.WELL_PLY_STEP * gamma * eMult;
      if (well.edge) {
        if (depth > 0) s += P.WELL_EDGE_BONUS * gamma * eMult;
      } else if (depth > 0) {
        s -= P.WELL_CENTER_PEN * gamma * eMult;
      }
      const bump = dsBumpExWell(h, well.col);
      if (bump > P.BUMP_CAP) s -= (bump - P.BUMP_CAP) * P.BUMP_STEP * gamma;
      const floatWell = dsFloatWell(h, 6);
      const floatDepth = Math.min(6, floatWell.depth);
      if (floatWell.edge && floatDepth > 0 && feat.holes > 0) {
        s += floatDepth * P.WELL_PLY_STEP * gamma * eMult;
      }
      const floatReady =
        floatWell.edge && floatDepth >= P.READY_DEPTH && feat.holes > 0 && well.globalMax >= 6;
      const readyDepth = Math.max(depth, floatReady ? floatDepth : 0);
      if (emerg === 0 && readyDepth >= P.READY_DEPTH && ctx.ply <= 2 && iAvail)
        s += P.TETRIS_READY * gamma;
      if (emerg === 0 && ctx.ply === 0 && readyDepth >= P.READY_DEPTH && iAvail) {
        if (well.maxExWell <= P.RESERVE_CEIL) s += P.EXECUTE_BONUS;
      }
    }
    if (lines > 0 && ctx.ply <= 2) {
      const floatAfter = dsFloatWell(h, 6);
      if (floatAfter.edge && floatAfter.depth >= P.READY_DEPTH && iAvail) {
        s += floatAfter.depth * P.WELL_REBUILD_STEP;
      }
    }
    if (ctx.ply === 0 && lines > 0 && lines < 4 && !tspin) {
      const h0 = dsHeights(after);
      const w0 = dsWell(after, h0, 6);
      if (w0.depth >= P.READY_DEPTH && w0.edge && iAvail)
        s -= P.FILL_PEN + w0.depth * P.WELL_FILL_LOSS;
    }
    if (lines > 0 && tspin) s += P.TSD_ARRIVAL / (ctx.ply + 1);
    if (lines === 4) s += P.TETRIS_ARRIVAL / (ctx.ply + 1);
    if (ctx.ply >= 1 && ctx.ply <= 3) {
      if (lines === 4) s += P.TETRIS_EXEC_DEEP;
      if (tspin && lines > 0) s += P.TSD_EXEC_DEEP;
    }
    if (lines > 0 && ncombo >= P.REN_START) {
      const renStep = pieces >= P.REN_LATE_N ? P.REN_LATE_STEP : P.REN_STEP;
      s += ncombo * renStep * late;
    }
    if (ctx.combo >= 2 && lines > 0) s += P.COMBO_KEEP;
    else if (ctx.combo >= 2 && lines === 0 && !tspin) {
      if (ctx.pending === 0 && emerg === 0 && feat.maxHeight < P.EMERG_LINE) s += P.REN_CALM_KEEP;
      else s -= P.COMBO_BREAK;
    }
    const pc = ctx.piece;
    if (pc === "T" && !(tspin && lines > 0)) {
      s += lines > 0 ? -P.WASTED_T_CLEAR : -P.WASTED_T_IDLE;
    }
    if (pc === "I" && emerg !== 2 && lines !== 4) {
      s += lines > 0 ? -P.WASTED_I_CLEAR : -P.WASTED_I_IDLE;
    }
    if (emerg > 0 && lines === 0 && !tspin) s -= dsHeightPressure(well.maxExWell);
    if (lines === 0 && !tspin && feat.maxHeight >= 17) {
      s -= (feat.maxHeight - 16) * P.DIG_H20_STEP;
    }
    if (lines === 0 && !tspin && well.globalMax >= 16) {
      const e2 = dsEmergency(ctx.pending, well.maxExWell);
      if (e2 === 2) s -= dsHeightPressure(well.globalMax) * 0.5;
    }
    if (ctx.pending > 0) {
      if (lines > 0) {
        s += ctx.pending * lines * P.URGENCY_W + P.DIG_BONUS * lines * (emerg === 2 ? 2 : 1);
        const holesAfter = dsCountHoles(after, h);
        if (holesAfter <= 5) s += (6 - holesAfter) * P.HOLE_DIVE_STEP * lines;
      } else if (feat.maxHeight >= P.EMERG_LINE) s -= dsHeightPressure(feat.maxHeight);
      else s -= P.DIG_HOLD;
    } else if (feat.maxHeight >= P.EMERG_LINE && lines > 0) {
      const holesAfter = dsCountHoles(after, h);
      if (holesAfter <= 5) s += (6 - holesAfter) * P.HOLE_DIVE_STEP * lines;
    }
    return s;
  };
}

interface TunedDebug {
  readonly mv: BeamMove;
  readonly thinkMs: number;
  readonly pieces: number;
}

export function createTunedDeepSeek(
  genome: Genome,
  options: TunedDeepSeekOptions = {},
): TunedDeepSeek {
  const p = decodeGenome(genome);
  const search: TunedSearch = options.search ?? p.search;
  const fire: BeamFireWeights = {
    tetris: p.fire.tetris,
    tspin: p.fire.tspin,
    tspinSingle: p.fire.tspinSingle,
    tspinDouble: p.fire.tspinDouble,
    tspinTriple: p.fire.tspinTriple,
    b2bBonus: p.fire.b2bBonus,
    comboStep: p.fire.comboStep,
    perfectClear: p.fire.perfectClear,
    wellStep: p.fire.wellStep,
    tslotStep: p.fire.tslotStep,
  };
  let last: TunedDebug | null = null;
  let pieces = 0;
  return {
    name: "DEEPSEEK-VS",
    reset: () => {
      last = null;
      pieces = 0;
    },
    findBestMove: (s) => {
      const t0 = performance.now();
      if (s.active === null || s.gameOver) return null;
      pieces += 1;
      const seen = pieces;
      const board = toBoard(s);
      const cur: PieceKind = s.active.kind;
      const queue: readonly PieceKind[] = s.next.slice(0, search.depth);
      const empty = board.every((v) => v === 0);
      if (empty) {
        // Mirrors deepseek.ts: openings use the DU beam (no personality scorer).
        const mv0 = beamBestMove(board, cur, queue, s.hold, s.canHold, s.b2b, s.combo, {
          depth: search.depth,
          width: search.width,
          topK: search.topK,
          pending: s.pendingGarbage,
        });
        if (mv0 === null) return null;
        last = { mv: mv0, thinkMs: performance.now() - t0, pieces: seen };
        return {
          targetX: mv0.x,
          targetRotation: mv0.rotation,
          useHold: mv0.useHold,
          ...(mv0.execution === undefined ? {} : { execution: mv0.execution }),
        };
      }
      const P = p.personality;
      const adjust = (after: Board, _lines: number, _tspin: boolean): number => {
        void _lines;
        void _tspin;
        const h = dsHeights(after);
        let adj = -(dsCapped(after, h) * P.CAP_PEN + dsHigh(after) * P.HIGH_PEN);
        if (seen <= P.OPENING_N) adj -= dsCountHoles(after, h) * P.HOLE_EXTRA;
        return adj;
      };
      const mv = beamBestMove(board, cur, queue, s.hold, s.canHold, s.b2b, s.combo, {
        weights: p.weights,
        fireWeights: fire,
        depth: search.depth,
        width: search.width,
        topK: search.topK,
        useHold: true,
        pending: s.pendingGarbage,
        evaluation: createBeamEvaluation({
          scoreAdjust: adjust,
          scorer: tunedScorer(p, s.hold, s.canHold, queue, seen),
          legacyVeto: (after, lines, tspin) => dsVeto(after, lines, s.pendingGarbage, tspin),
        }),
      });
      if (mv === null) return null;
      last = { mv, thinkMs: performance.now() - t0, pieces: seen };
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
        pieceIndex: last.pieces,
        searchDepth: last.mv.searchDepth,
      };
    },
  };
}
