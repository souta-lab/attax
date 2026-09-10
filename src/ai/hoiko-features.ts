/**
 * Hoiko feature assembly and weight application.
 *
 * `extractHoikoFeatures` combines the geometric board scan (hoiko-board.ts)
 * with move/context features derived from the beam ply context. The exact
 * native feature definitions are unknown, so context features are documented
 * approximations that keep each weight's sign faithful:
 *  - resource/resourceMax: I/T availability across hold + visible queue (the
 *    beam does not expose per-node holds, so the root snapshot is used).
 *  - tsd/tst/td*: geometric spin slots (see hoiko-board.ts) gated on T
 *    availability; `*Offensive` flags a ready slot with no incoming garbage
 *    (greedy setup), matching the negative weights.
 *  - moveDelay: search ply as a stand-in for hesitation/wasted moves.
 *  - wasteI/wasteT: placing an I/T on a non-premium clear (mirrors our fighters).
 *  - comboDebt: combo continuation reward (weight is positive).
 *  - pcStack/pcChance: hole-free stack whose row count is a multiple of four.
 */

import { type Board, COLS } from "../core/board.js";
import type { PieceKind } from "../core/pieces.js";
import type { PlyContext } from "./evaluation.js";
import { type HoikoBoardStats, scanHoikoBoard } from "./hoiko-board.js";
import type { HoikoWeights } from "./hoiko-weights.js";

export interface HoikoResources {
  readonly hold: PieceKind | null;
  readonly canHold: boolean;
  readonly queue: readonly PieceKind[];
}

export type HoikoFeatures = HoikoBoardStats & {
  readonly resource: number;
  readonly resourceMax: number;
  readonly tsdHole: number;
  readonly tsdSpinable: number;
  readonly tsdClearable: number;
  readonly tsdOffensive: number;
  readonly tstHole: number;
  readonly tstSpinable: number;
  readonly tstClearable: number;
  readonly tstHint: number;
  readonly tstOffensive: number;
  readonly tdHole: number;
  readonly tdHint: number;
  readonly moveDelay: number;
  readonly holdI: number;
  readonly holdT: number;
  readonly wasteI: number;
  readonly wasteT: number;
  readonly clearSingle: number;
  readonly clearDouble: number;
  readonly clearTriple: number;
  readonly clearQuad: number;
  readonly tspSingle: number;
  readonly tspDouble: number;
  readonly tspTriple: number;
  readonly b2bClear: number;
  readonly pcClear: number;
  readonly comboBtb: number;
  readonly comboDebt: number;
  /** ncombo (>= 1) when a clear continued/started a combo, else -1. */
  readonly comboCount: number;
};

function isEmpty(board: Board): boolean {
  for (let y = 0; y < board.length; y += 1) if ((board[y] ?? 0) !== 0) return false;
  return true;
}

function pieceAvailable(
  resources: HoikoResources,
  current: PieceKind | undefined,
  kind: PieceKind,
): boolean {
  if (current === kind) return true;
  if (resources.canHold && resources.hold === kind) return true;
  return resources.queue.includes(kind);
}

/** Derive the full Hoiko feature vector for one afterstate. */
export function extractHoikoFeatures(
  after: Board,
  lines: number,
  tspin: boolean,
  ctx: PlyContext,
  resources: HoikoResources,
): HoikoFeatures {
  const board = scanHoikoBoard(after);
  const hasT = pieceAvailable(resources, ctx.piece, "T");
  let resourceCount = 0;
  if (resources.hold === "I" || resources.hold === "T") resourceCount += 1;
  for (const kind of resources.queue) {
    if (kind === "I" || kind === "T") {
      resourceCount += 1;
      if (resourceCount >= 2) break;
    }
  }
  resourceCount = Math.min(2, resourceCount);
  const ncombo = lines > 0 ? ctx.combo + 1 : -1;
  const difficult = lines === 4 || (tspin && lines > 0);
  return {
    ...board,
    resource: resourceCount,
    resourceMax: resourceCount >= 2 ? 1 : 0,
    tsdHole: board.spinDouble,
    tsdSpinable: board.spinDouble,
    tsdClearable: board.spinDouble === 1 && hasT ? 1 : 0,
    tsdOffensive: board.spinDouble === 1 && ctx.pending === 0 ? 1 : 0,
    tstHole: board.spinTriple,
    tstSpinable: board.spinTriple,
    tstClearable: board.spinTriple === 1 && hasT ? 1 : 0,
    tstHint: board.spinTriple === 1 && hasT ? 1 : 0,
    tstOffensive: board.spinTriple === 1 && ctx.pending === 0 ? 1 : 0,
    tdHole: board.spinCannon,
    tdHint: board.spinCannon === 1 && hasT ? 1 : 0,
    moveDelay: ctx.ply,
    holdI: resources.hold === "I" ? 1 : 0,
    holdT: resources.hold === "T" ? 1 : 0,
    wasteI: ctx.piece === "I" && lines !== 4 ? 1 : 0,
    wasteT: ctx.piece === "T" && !(tspin && lines > 0) ? 1 : 0,
    clearSingle: lines === 1 && !tspin ? 1 : 0,
    clearDouble: lines === 2 && !tspin ? 1 : 0,
    clearTriple: lines === 3 && !tspin ? 1 : 0,
    clearQuad: lines === 4 ? 1 : 0,
    tspSingle: tspin && lines === 1 ? 1 : 0,
    tspDouble: tspin && lines === 2 ? 1 : 0,
    tspTriple: tspin && lines === 3 ? 1 : 0,
    b2bClear: ctx.b2b && difficult ? 1 : 0,
    pcClear: lines > 0 && isEmpty(after) ? 1 : 0,
    comboBtb: ctx.b2b && lines > 0 && ctx.combo >= 1 ? 1 : 0,
    comboDebt: lines > 0 && ctx.combo >= 1 ? 1 : 0,
    comboCount: ncombo,
  };
}

/** Hoiko score = dot(weights, features); vectors carry per-index weights. */
export function scoreHoikoFeatures(features: HoikoFeatures, w: HoikoWeights): number {
  const f = features;
  let s = 0;
  s += f.maxHeight * w.maxHeight;
  s += f.over10 * w.over10;
  s += f.over15 * w.over15;
  s += f.updown2 * w.updown2;
  s += f.donateCover * w.donateCover;
  s += f.cover * w.cover;
  s += f.roof * w.roof;
  s += f.badRoof * w.badRoof;
  s += f.pierce * w.pierce;
  s += f.anabara * w.anabara;
  s += f.wellHint * w.wellHint;
  s += f.wellDepth * w.wellDepth;
  s += f.wellPeak * w.wellPeak;
  for (let x = 0; x < COLS; x += 1) s += (f.column[x] ?? 0) * (w.column[x] ?? 0);
  s += f.pcStack * w.pcStack;
  s += f.pcChance * w.pcChance;
  s += f.resource * w.resource;
  s += f.resourceMax * w.resourceMax;
  s += f.tsdHole * w.tsdHole;
  s += f.tsdSpinable * w.tsdSpinable;
  s += f.tsdClearable * w.tsdClearable;
  s += f.tsdOffensive * w.tsdOffensive;
  s += f.tstHole * w.tstHole;
  s += f.tstSpinable * w.tstSpinable;
  s += f.tstClearable * w.tstClearable;
  s += f.tstHint * w.tstHint;
  s += f.tstOffensive * w.tstOffensive;
  s += f.tdHole * w.tdHole;
  s += f.tdHint * w.tdHint;
  s += f.moveDelay * w.moveDelay;
  s += f.holdI * w.holdI;
  s += f.holdT * w.holdT;
  s += f.wasteI * w.wasteI;
  s += f.wasteT * w.wasteT;
  s += f.clearSingle * w.single;
  s += f.clearDouble * w.double;
  s += f.clearTriple * w.triple;
  s += f.clearQuad * w.quad;
  s += f.tspSingle * w.tss;
  s += f.tspDouble * w.tsd;
  s += f.tspTriple * w.tst;
  s += f.b2bClear * w.btb;
  s += f.pcClear * w.pc;
  s += f.comboBtb * w.comboBtb;
  if (f.comboCount >= 1) s += w.comboAtk[Math.min(4, f.comboCount - 1)] ?? 0;
  s += f.comboDebt * w.comboDebt;
  s += f.nexus * w.nexus;
  return s;
}
