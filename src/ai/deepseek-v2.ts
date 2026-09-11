// "DeepSeek v2" — a stronger versus fighter than the V8-seal v1.
//
// Differences from `createDeepSeekTetris()` (v1):
//   (a) full reachable placements: hard drops plus SRS wall/floor kicks/tucks,
//       with T-spins detected through the fixed `core/tspin.ts` corner mapping
//       and executed via `placeAt` + explicit `lastSrs` (same technique the
//       Hoiko adapter uses).
//   (b) opponent-aware attack timing driven by controller telemetry.
//   (c) incoming-garbage defense (Cold Clear style height + pending safety).
//   (d) principled downstack/burst selection from board messiness.
//   (e) configurable, deeper beam search.
import { type Board, COLS, cloneBoard } from "../core/board.js";
import { attackForClear } from "../core/garbage.js";
import { bottomCellsOf, cellsFor, type PieceKind } from "../core/pieces.js";
import { classifyTspin } from "../core/tspin.js";
import type { AiDebug, AiExecutionPlan, AiMove, GameSnapshot } from "../ui/types.js";
import { type BeamMove, beamBestMove, createBeamEvaluation, type PlyContext } from "./beam.js";
import { toBoard } from "./deepseek.js";
import {
  dsBumpExWell,
  dsCountHoles,
  dsCountTslots,
  dsEmergency,
  dsFloatWell,
  dsGamma,
  dsHeightPressure,
  dsWell,
} from "./deepseek-score.js";
import {
  type V2OppModel,
  v2BoardStats,
  v2GarbageDefense,
  v2OpponentModel,
} from "./deepseek-v2-score.js";
import { extractFeatures } from "./features.js";
import {
  enumerateKickPlacements,
  enumerateScored,
  type PlacementGenerator,
  type ScoredPlacement,
} from "./search.js";
import { ROWS } from "./types.js";
import { DU_WEIGHTS, FIRE_WEIGHTS, scorePlacement, type Weights } from "./weights.js";

export const DEEPSEEK_V2_NAME = "DEEPSEEK_V2";

export const DEEPSEEK_V2_WEIGHTS: Weights = {
  ...DU_WEIGHTS,
  holes: -15.0,
  wells: -11.0,
  rowsWithHoles: -27.0,
  maxHeight: -3.8,
};

const V2_FIRE = { ...FIRE_WEIGHTS, wellStep: 7, tslotStep: 42 } as const;

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

// --- v2 attack-timing / downstack terms ---
const OPP_DANGER_ATK_W = 26;
const BURST_VULN_TETRIS = 130;
const BURST_VULN_TSPIN = 90;
const BURST_SETUP = 22;
const MESSY_HOLES = 6;
const DOWNSTACK_STEP = 34;
const TSPIN_SETUP_BONUS = 34;

const DEFAULT_DEPTH = 7;
const DEFAULT_WIDTH = 24;
const DEFAULT_TOP_K = 16;

export interface DeepSeekV2Options {
  readonly depth?: number | undefined;
  readonly width?: number | undefined;
  readonly topK?: number | undefined;
  /** Enumerate SRS-kick/tuck landings in addition to hard drops. */
  readonly useKicks?: boolean | undefined;
  readonly useOpponent?: boolean | undefined;
  readonly useGarbageDefense?: boolean | undefined;
  readonly useDownstack?: boolean | undefined;
}

function hasI(hold: PieceKind | null, canHold: boolean, queue: readonly PieceKind[]): boolean {
  if (hold === "I" && canHold) return true;
  for (const k of queue) if (k === "I") return true;
  return false;
}

function maxNativeY(kind: PieceKind, rotation: number): number {
  let max = 0;
  for (const c of cellsFor(kind, rotation)) if (c.y > max) max = c.y;
  return max;
}

/** True when a T resting at (rotation, x, y) is a spin per core tspin semantics. */
export function isV2Tspin(
  board: Board,
  kind: PieceKind,
  rotation: number,
  x: number,
  y: number,
): boolean {
  if (kind !== "T") return false;
  const cells = bottomCellsOf(kind, rotation);
  const pre = cloneBoard(board);
  for (const c of cells) {
    const cx = x + c.x;
    const cy = y + c.y;
    if (cx >= 0 && cx < COLS && cy >= 0 && cy < pre.length) pre[cy] = (pre[cy] ?? 0) | (1 << cx);
  }
  return classifyTspin(pre, cells, x, y, rotation, 1) !== "none";
}

/**
 * Build a single-step `placeAt` execution with an explicit `lastSrs`. Direct
 * placement is how the Hoiko adapter executes kicks/tucks; it keeps the
 * expected board exact and lets T-spins register through the engine's
 * `classifyTspin` (lastSrs != 0) instead of the fragile replay path.
 */
function buildPlaceAt(
  board: Board,
  kind: PieceKind,
  rotation: number,
  x: number,
  y: number,
): AiExecutionPlan {
  const topRow = ROWS - 1 - maxNativeY(kind, rotation) - y;
  const tspin = isV2Tspin(board, kind, rotation, x, y);
  return {
    targetX: x,
    targetRotation: rotation,
    steps: [{ kind: "placeAt", rotation, x, topRow, lastSrs: tspin ? 1 : 0 }],
    expectedBoard: [],
    expectedLinesCleared: 0,
    sourceActiveKind: kind,
    sourceRotation: 0,
    sourceX: 3,
    sourceBoardFingerprint: "",
    sourceHold: null,
    sourceCanHold: true,
  };
}

function makePlacementGenerator(weights: Weights, useKicks: boolean): PlacementGenerator {
  return (board, kind) => {
    const raw = useKicks
      ? enumerateKickPlacements(board, kind)
      : enumerateScored(board, kind, weights);
    const out: ScoredPlacement[] = [];
    for (const placement of raw) {
      const feat = extractFeatures(placement.after, 0, 0);
      const score = scorePlacement(feat, placement.linesCleared, weights);
      out.push({
        ...placement,
        score,
        execution: buildPlaceAt(board, kind, placement.rotation, placement.x, placement.y),
      });
    }
    return out;
  };
}

interface V2Flags {
  readonly useOpponent: boolean;
  readonly useGarbageDefense: boolean;
  readonly useDownstack: boolean;
}

function v2Scorer(
  hold: PieceKind | null,
  canHold: boolean,
  queue: readonly PieceKind[],
  pieces: number,
  opp: V2OppModel,
  flags: V2Flags,
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
    const stats = v2BoardStats(after);
    const well = dsWell(after, stats.heights, 6);
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
      const bump = dsBumpExWell(stats.heights, well.col);
      if (bump > BUMP_CAP) s -= (bump - BUMP_CAP) * BUMP_STEP * gamma;
      const floatWell = dsFloatWell(stats.heights, 6);
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
      const floatAfter = dsFloatWell(stats.heights, 6);
      if (floatAfter.edge && floatAfter.depth >= READY_DEPTH && iAvail) {
        s += floatAfter.depth * WELL_REBUILD_STEP;
      }
    }
    if (ctx.ply === 0 && lines > 0 && lines < 4 && !tspin) {
      const h0 = stats.heights;
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
        const holesAfter = dsCountHoles(after, stats.heights);
        if (holesAfter <= 5) s += (6 - holesAfter) * HOLE_DIVE_STEP * lines;
      } else if (feat.maxHeight >= EMERG_LINE) s -= dsHeightPressure(feat.maxHeight);
      else s -= DIG_HOLD;
    } else if (feat.maxHeight >= EMERG_LINE && lines > 0) {
      const holesAfter = dsCountHoles(after, stats.heights);
      if (holesAfter <= 5) s += (6 - holesAfter) * HOLE_DIVE_STEP * lines;
    }

    // (c) explicit incoming-garbage safety term.
    if (flags.useGarbageDefense) s += v2GarbageDefense(stats, ctx.pendingAfter);

    if (lines > 0) {
      // (b) clearing cancels incoming and pressures the opponent: worth more
      // when the opponent is actively attacking.
      if (flags.useOpponent) s += opp.danger * lines * OPP_DANGER_ATK_W;
      // (d) burst windows when the opponent just whiffed.
      if (flags.useOpponent && opp.vuln > 0) {
        if (lines === 4) s += BURST_VULN_TETRIS;
        else if (tspin && lines > 0) s += BURST_VULN_TSPIN;
      }
      // (d) downstack continuation when the board is messy.
      if (flags.useDownstack && stats.holes >= MESSY_HOLES) s += lines * DOWNSTACK_STEP;
    } else if (!tspin && flags.useDownstack) {
      // Reward keeping a T-spin lane alive on a clean-ish board, and lean into
      // burst setup while the opponent is in a cancel window.
      if (stats.holes <= 3 && dsCountTslots(after, 1) > 0) s += TSPIN_SETUP_BONUS;
      if (flags.useOpponent && opp.vuln > 0 && stats.holes <= 3 && feat.maxHeight < 14)
        s += BURST_SETUP;
    }
    return s;
  };
}

function deepSeekV2Veto(pending: number): (after: Board, lines: number, tspin: boolean) => boolean {
  return (after, lines, tspin) => {
    // Gentler than v1: only reject genuinely lethal afterstates.
    const h = v2BoardStats(after);
    if (lines === 0 && pending > 0 && h.globalMax + pending >= 20) return true;
    if (tspin && lines > 0) {
      if (h.holes >= 10 && h.globalMax >= 14 && pending > 0) return true;
      if (h.holes >= 12 && h.globalMax >= 15) return true;
    }
    return false;
  };
}

interface V2Debug {
  readonly mv: BeamMove;
  readonly thinkMs: number;
  readonly pieces: number;
}

export interface DeepSeekV2 {
  readonly name: string;
  findBestMove(snapshot: GameSnapshot): AiMove | null;
  getDebug(): AiDebug | null;
  reset(): void;
}

export function createDeepSeekV2(options: DeepSeekV2Options = {}): DeepSeekV2 {
  const depth = options.depth ?? DEFAULT_DEPTH;
  const width = options.width ?? DEFAULT_WIDTH;
  const topK = options.topK ?? DEFAULT_TOP_K;
  const useKicks = options.useKicks ?? true;
  const flags: V2Flags = {
    useOpponent: options.useOpponent ?? true,
    useGarbageDefense: options.useGarbageDefense ?? true,
    useDownstack: options.useDownstack ?? true,
  };
  const generator = makePlacementGenerator(DEEPSEEK_V2_WEIGHTS, useKicks);
  let last: V2Debug | null = null;
  let pieces = 0;
  return {
    name: DEEPSEEK_V2_NAME,
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
      const queue: readonly PieceKind[] = s.next.slice(0, Math.max(1, depth));
      const opp = v2OpponentModel(s);
      const mv = beamBestMove(board, cur, queue, s.hold, s.canHold, s.b2b, s.combo, {
        weights: DEEPSEEK_V2_WEIGHTS,
        fireWeights: V2_FIRE,
        depth,
        width,
        topK,
        useHold: true,
        pending: s.pendingGarbage,
        placementGenerator: generator,
        evaluation: createBeamEvaluation({
          scorer: v2Scorer(s.hold, s.canHold, queue, seen, opp, flags),
          legacyVeto: deepSeekV2Veto(s.pendingGarbage),
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
      const h = v2BoardStats(last.mv.after);
      return {
        score: last.mv.score,
        fireScore: last.mv.fireScore,
        linesCleared: last.mv.linesCleared,
        isTspin: last.mv.isTspin,
        opener: null,
        topHoles: h.holes,
        topMaxHeight: h.globalMax,
        thinkMs: last.thinkMs,
        pieceIndex: last.pieces,
        searchDepth: last.mv.searchDepth,
      };
    },
  };
}
