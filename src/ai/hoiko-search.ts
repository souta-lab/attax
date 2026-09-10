/**
 * Hoiko SearchAI port — the beam search from TetrizAI_Search.cpp composed with
 * the faithful EvaluateAI (hoiko-eval.ts).
 *
 * Native SearchAI::Search expands every child of each beam node (ExpandAI:
 * all rotations x columns, plus the hold variant), evaluates each with
 * EvaluateAI::Evaluate, then partial_sorts the whole beam by `score` and keeps
 * the top `correctedBeamSize`. The score accumulation is the key difference
 * from our generic beam:
 *
 *   familyScore = trunc((actionScore + trunc(boardScore*nexus)) * trustRate)
 *                 + parent.familyScore
 *   score       = trunc((actionScore + boardScore) * trustRate)
 *                 + parent.familyScore
 *
 * The beam sorts by `score` (full board weight at the current node plus the
 * accumulated family quality), which is what lets Hoiko find the setups
 * (doubles/quads/PC) its eval rewards. We use the real next queue from the
 * snapshot (not a tripled copy) and the same width/depth as the gate config.
 */

import type { Board } from "../core/board.js";
import { cloneBoard, collides, computeLockAfterstate, dropY } from "../core/board.js";
import type { PieceKind } from "../core/pieces.js";
import { bottomCellsOf, rotationCount } from "../core/pieces.js";
import type { AiExecutionPlan } from "../ui/types.js";
import type { ClearAct } from "./hoiko-eval.js";
import { evaluateNodeFull, isEvenPop, toSourceBoard } from "./hoiko-eval.js";
import type { HoikoWeights } from "./hoiko-weights.js";
import { offsetBonus, type OffsetData } from "./hoiko-offset.js";

export interface HoikoSearchOptions {
  readonly width?: number | undefined;
  readonly depth?: number | undefined;
  readonly useHold?: boolean | undefined;
  readonly pending?: number | undefined;
  readonly offset?: OffsetData | undefined;
  readonly isEvenBoard?: boolean | undefined;
  readonly weightIndex?: number | undefined;
  readonly useS4W?: boolean | undefined;
  readonly opponentIsPowerful?: boolean | undefined;
}

export interface HoikoSearchMove {
  readonly rotation: number;
  readonly x: number;
  readonly useHold: boolean;
  readonly score: number;
  readonly after: Board;
  readonly linesCleared: number;
  readonly isTspin: boolean;
  readonly execution?: AiExecutionPlan;
}

interface SearchNode {
  readonly board: Board;
  readonly hold: PieceKind | null;
  readonly canHold: boolean;
  readonly b2b: boolean;
  readonly combo: number;
  readonly queueIndex: number;
  readonly familyScore: number;
  readonly score: number;
  readonly pcScore: number;
  readonly firstRotation: number;
  readonly firstX: number;
  readonly firstHold: boolean;
  readonly after: Board;
  readonly linesCleared: number;
  readonly isTspin: boolean;
  readonly pending: number;
}

interface Placement {
  readonly rotation: number;
  readonly x: number;
  readonly y: number;
  readonly linesCleared: number;
  readonly after: Board;
}

function enumeratePlacements(board: Board, kind: PieceKind): Placement[] {
  const out: Placement[] = [];
  const rots = rotationCount(kind);
  for (let r = 0; r < rots; r += 1) {
    const cells = bottomCellsOf(kind, r);
    let minX = 0;
    let maxX = 0;
    for (const c of cells) {
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
    }
    for (let px = -minX; px < 10 - maxX; px += 1) {
      const startY = board.length + 4;
      if (collides(board, cells, px, startY)) continue;
      const y = dropY(board, cells, px, startY);
      if (collides(board, cells, px, y)) continue;
      const transition = computeLockAfterstate(board, cells, px, y);
      if (transition.topOut && transition.linesCleared === 0) continue;
      out.push({
        rotation: r,
        x: px,
        y,
        linesCleared: transition.linesCleared,
        after: transition.after,
      });
    }
  }
  return out;
}

function isEmpty(board: Board): boolean {
  for (let y = 0; y < board.length; y += 1) {
    if ((board[y] ?? 0) !== 0) return false;
  }
  return true;
}

function isTspinShape(
  after: Board,
  cells: readonly { readonly x: number; readonly y: number }[],
  px: number,
  py: number,
): boolean {
  let cx = 0;
  let cy = 0;
  for (const c of cells) {
    cx += px + c.x;
    cy += py + c.y;
  }
  cx /= cells.length;
  cy /= cells.length;
  const corners: Array<readonly [number, number]> = [
    [Math.floor(cx - 0.6), Math.floor(cy - 0.6)],
    [Math.ceil(cx + 0.6), Math.floor(cy - 0.6)],
    [Math.floor(cx - 0.6), Math.ceil(cy + 0.6)],
    [Math.ceil(cx + 0.6), Math.ceil(cy + 0.6)],
  ];
  let filled = 0;
  for (const [x, y] of corners) {
    if (x < 0 || x >= 10 || y < 0) {
      filled += 1;
      continue;
    }
    if (y >= after.length) continue;
    if (((after[y] ?? 0) & (1 << x)) !== 0) filled += 1;
  }
  return filled >= 3;
}

function sourceOthers(
  ctx: { readonly combo: number; readonly b2b: boolean },
  lines: number,
  tspin: boolean,
  after: Board,
): { readonly combo: number; readonly btb: number; readonly act: ClearAct } {
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

function boardKey(board: Board, hold: PieceKind | null, canHold: boolean): string {
  let h = 0;
  for (let y = 0; y < board.length; y += 1) {
    h = (Math.imul(h, 31) + (board[y] ?? 0)) | 0;
  }
  return `${h}:${hold ?? "-"}:${canHold ? 1 : 0}`;
}

function dedupe(nodes: SearchNode[]): SearchNode[] {
  const seen = new Set<string>();
  const out: SearchNode[] = [];
  for (const n of nodes) {
    const k = boardKey(n.board, n.hold, n.canHold);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

function applyPlacement(
  node: SearchNode,
  placedPiece: PieceKind,
  p: Placement,
  holdAfter: PieceKind | null,
  canHoldAfter: boolean,
  queueIndexAfter: number,
  isFirst: boolean,
  ply: number,
  ew: HoikoWeights,
  weightIndex: number,
  isEvenBoard: boolean,
  useS4W: boolean,
  opponentIsPowerful: boolean,
  offset: OffsetData | undefined,
): SearchNode | null {
  const cells = bottomCellsOf(placedPiece, p.rotation);
  const y = dropY(node.board, cells, p.x, node.board.length + 4);
  if (collides(node.board, cells, p.x, y)) return null;
  const transition = computeLockAfterstate(node.board, cells, p.x, y);
  if (transition.topOut && transition.linesCleared === 0) return null;
  const test = transition.after;
  const tspin = placedPiece === "T" && isTspinShape(test, cells, p.x, y);
  const pendingAfter = Math.max(0, node.pending - transition.linesCleared);
  const src = toSourceBoard(test);
  const others = sourceOthers(
    { combo: node.combo, b2b: node.b2b },
    transition.linesCleared,
    tspin,
    test,
  );
  const trustRate = ply >= 7 ? 0.9 : 1.0;
  const evalResult = evaluateNodeFull(
    src,
    {
      act: others.act,
      combo: others.combo,
      btb: others.btb,
      lockedMino: placedPiece,
      hold: holdAfter,
      fallingMino: placedPiece,
      moveDelay: 0,
    },
    ew,
    weightIndex,
    isEvenBoard,
    useS4W,
    opponentIsPowerful,
    trustRate,
    node.pcScore,
  );
  let scoreContribution = evalResult.score;
  if (offset !== undefined && transition.linesCleared > 0) {
    scoreContribution += offsetBonus(
      offset,
      node.pending,
      transition.linesCleared,
      tspin,
      node.combo,
      node.b2b,
      0,
      isEvenBoard,
    );
  }
  const familyScore = evalResult.familyScore + node.familyScore;
  const score = scoreContribution + node.familyScore;
  const nextCombo = transition.linesCleared > 0 ? node.combo + 1 : -1;
  const nextB2b =
    transition.linesCleared === 4 || (tspin && transition.linesCleared > 0)
      ? true
      : transition.linesCleared > 0
        ? false
        : node.b2b;
  return {
    board: test,
    hold: holdAfter,
    canHold: canHoldAfter,
    b2b: nextB2b,
    combo: nextCombo,
    queueIndex: queueIndexAfter,
    familyScore,
    score,
    pcScore: evalResult.pcScore,
    firstRotation: isFirst ? p.rotation : node.firstRotation,
    firstX: isFirst ? p.x : node.firstX,
    firstHold: isFirst ? holdAfter !== node.hold : node.firstHold,
    after: test,
    linesCleared: transition.linesCleared,
    isTspin: tspin,
    pending: pendingAfter,
  };
}

function expandNode(
  node: SearchNode,
  piece: PieceKind,
  nextPiece: PieceKind | undefined,
  isFirst: boolean,
  ply: number,
  ew: HoikoWeights,
  weightIndex: number,
  isEvenBoard: boolean,
  useS4W: boolean,
  opponentIsPowerful: boolean,
  offset: OffsetData | undefined,
  useHold: boolean,
): SearchNode[] {
  const out: SearchNode[] = [];
  for (const p of enumeratePlacements(node.board, piece)) {
    const child = applyPlacement(
      node,
      piece,
      p,
      node.hold,
      node.canHold,
      node.queueIndex + 1,
      isFirst,
      ply,
      ew,
      weightIndex,
      isEvenBoard,
      useS4W,
      opponentIsPowerful,
      offset,
    );
    if (child !== null) out.push(child);
  }
  if (useHold && node.canHold) {
    if (node.hold !== null && node.hold !== piece) {
      const held = node.hold;
      for (const p of enumeratePlacements(node.board, held)) {
        const child = applyPlacement(
          node,
          held,
          p,
          piece,
          false,
          node.queueIndex + 1,
          isFirst,
          ply,
          ew,
          weightIndex,
          isEvenBoard,
          useS4W,
          opponentIsPowerful,
          offset,
        );
        if (child !== null) out.push(child);
      }
    } else if (node.hold === null && nextPiece !== undefined) {
      for (const p of enumeratePlacements(node.board, nextPiece)) {
        const child = applyPlacement(
          node,
          nextPiece,
          p,
          piece,
          false,
          node.queueIndex + 2,
          isFirst,
          ply,
          ew,
          weightIndex,
          isEvenBoard,
          useS4W,
          opponentIsPowerful,
          offset,
        );
        if (child !== null) out.push(child);
      }
    }
  }
  return out;
}

/**
 * Hoiko beam search. Returns the best first move (rotation/x/hold) for the
 * current piece, or null when no placement is possible.
 */
export function hoikoBeamSearch(
  board: Board,
  current: PieceKind,
  queue: readonly PieceKind[],
  hold: PieceKind | null,
  canHold: boolean,
  b2b: boolean,
  combo: number,
  ew: HoikoWeights,
  options: HoikoSearchOptions = {},
): HoikoSearchMove | null {
  const width = options.width ?? 50;
  const depth = Math.min(options.depth ?? 10, queue.length + 1);
  const useHold = options.useHold ?? true;
  const pending = options.pending ?? 0;
  const offset = options.offset;
  const isEvenBoard = options.isEvenBoard ?? isEvenPop(toSourceBoard(board));
  const weightIndex = options.weightIndex ?? 0;
  const useS4W = options.useS4W ?? false;
  const opponentIsPowerful = options.opponentIsPowerful ?? false;

  const pieces: readonly PieceKind[] = [current, ...queue.slice(0, depth)];
  if (pieces.length === 0) return null;
  const PLIES = depth;

  let beam: SearchNode[] = [
    {
      board: cloneBoard(board),
      hold,
      canHold,
      b2b,
      combo,
      queueIndex: 0,
      familyScore: 0,
      score: 0,
      pcScore: 0,
      firstRotation: 0,
      firstX: 0,
      firstHold: false,
      after: cloneBoard(board),
      linesCleared: 0,
      isTspin: false,
      pending,
    },
  ];

  for (let ply = 0; ply < PLIES; ply += 1) {
    const nextBeam: SearchNode[] = [];
    for (const node of beam) {
      const piece = pieces[node.queueIndex];
      if (piece === undefined) continue;
      const nextPiece: PieceKind | undefined = pieces[node.queueIndex + 1];
      const expanded = expandNode(
        node,
        piece,
        nextPiece,
        ply === 0,
        ply,
        ew,
        weightIndex,
        isEvenBoard,
        useS4W,
        opponentIsPowerful,
        offset,
        useHold,
      );
      for (const child of expanded) nextBeam.push(child);
    }
    if (nextBeam.length === 0) break;
    nextBeam.sort((a: SearchNode, b: SearchNode) => b.score - a.score);
    beam = dedupe(nextBeam).slice(0, width);
  }

  if (beam.length === 0) return null;
  const bestLeaf = beam[0];
  if (bestLeaf === undefined) return null;
  return {
    rotation: bestLeaf.firstRotation,
    x: bestLeaf.firstX,
    useHold: bestLeaf.firstHold,
    score: bestLeaf.score,
    after: bestLeaf.after,
    linesCleared: bestLeaf.linesCleared,
    isTspin: bestLeaf.isTspin,
  };
}
