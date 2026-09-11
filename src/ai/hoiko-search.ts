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
import { classifyTspin, type TspinKind } from "../core/tspin.js";
import type { AiExecutionPlan, AiExecutionStep } from "../ui/types.js";
import type { ClearAct } from "./hoiko-eval.js";
import { evaluateNodeFull, isEvenPop, toSourceBoard, W } from "./hoiko-eval.js";
import type { HoikoWeights } from "./hoiko-weights.js";
import { enumerateKickPlacements, type ScoredPlacement } from "./search.js";

export interface HoikoSearchOptions {
  readonly width?: number | undefined;
  readonly correctedWidth?: number | undefined;
  readonly depth?: number | undefined;
  readonly useHold?: boolean | undefined;
  readonly pending?: number | undefined;
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
  readonly planActs: readonly ClearAct[];
}

interface SearchNode {
  readonly board: Board;
  readonly hold: PieceKind | null;
  readonly canHold: boolean;
  readonly btb: number;
  readonly combo: number;
  readonly queueIndex: number;
  readonly nextPieceOverride: PieceKind | null;
  readonly familyScore: number;
  readonly score: number;
  readonly pcScore: number;
  readonly firstRotation: number;
  readonly firstX: number;
  readonly firstHold: boolean;
  readonly after: Board;
  readonly linesCleared: number;
  readonly isTspin: boolean;
  readonly planActs: readonly ClearAct[];
  readonly firstExecution?: AiExecutionPlan;
  readonly pending: number;
}

interface Placement {
  readonly rotation: number;
  readonly x: number;
  readonly y: number;
  readonly linesCleared: number;
  readonly after: Board;
  readonly moveDelay: number;
  readonly lastSrs: number;
  readonly execution?: AiExecutionPlan;
}

export interface SearchQueueState {
  readonly queueIndex: number;
  readonly nextPieceOverride: PieceKind | null;
}

export type SearchQueueAction = "normal" | "emptyHold" | "swapHold";

function assertNever(value: never): never {
  throw new Error(`Unexpected search queue action: ${String(value)}`);
}

export function advanceSearchQueue(
  state: SearchQueueState,
  action: SearchQueueAction,
  current: PieceKind,
): SearchQueueState {
  switch (action) {
    case "normal":
      return {
        queueIndex: state.nextPieceOverride === null ? state.queueIndex + 1 : state.queueIndex,
        nextPieceOverride: null,
      };
    case "emptyHold":
      return {
        queueIndex: state.queueIndex + (state.nextPieceOverride === null ? 2 : 1),
        nextPieceOverride: null,
      };
    case "swapHold":
      return {
        queueIndex: state.nextPieceOverride === null ? state.queueIndex + 1 : state.queueIndex,
        nextPieceOverride: current,
      };
    default:
      return assertNever(action);
  }
}

function moveDelay(
  steps: readonly AiExecutionStep[] | undefined,
  rotation: number,
  x: number,
): number {
  if (steps === undefined)
    return 116 + Math.min(rotation, 4 - rotation) * 16 + Math.abs(x - 3) * 30;
  let delay = 0;
  for (const step of steps) {
    switch (step.kind) {
      case "left":
      case "right":
        delay += 30;
        break;
      case "rotateCW":
      case "rotateCCW":
        delay += 16;
        break;
      case "softDrop":
        delay += 33;
        break;
      case "drop":
        delay += 116;
        break;
      case "hold":
        delay += 16;
        break;
    }
  }
  return delay;
}

function enumerateHardPlacements(board: Board, kind: PieceKind): Placement[] {
  const out: Placement[] = [];
  for (let rotation = 0; rotation < rotationCount(kind); rotation += 1) {
    const cells = bottomCellsOf(kind, rotation);
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    for (const cell of cells) {
      minX = Math.min(minX, cell.x);
      maxX = Math.max(maxX, cell.x);
    }
    for (let x = -minX; x < 10 - maxX; x += 1) {
      const y = dropY(board, cells, x, board.length + 4);
      if (y > 19) continue;
      if (collides(board, cells, x, y)) continue;
      const transition = computeLockAfterstate(board, cells, x, y);
      if (transition.topOut && transition.linesCleared === 0) continue;
      out.push({
        rotation,
        x,
        y,
        linesCleared: transition.linesCleared,
        after: transition.after,
        moveDelay: moveDelay(undefined, rotation, x),
        lastSrs: rotation === 0 ? 0 : 1,
      });
    }
  }
  return out;
}

function enumeratePlacements(board: Board, kind: PieceKind, useKick: boolean): Placement[] {
  if (!useKick) return enumerateHardPlacements(board, kind);
  return enumerateKickPlacements(board, kind)
    .filter((placement: ScoredPlacement) => placement.y <= 19)
    .map((placement: ScoredPlacement) => ({
      rotation: placement.rotation,
      x: placement.x,
      y: placement.y,
      linesCleared: placement.linesCleared,
      after: placement.after,
      moveDelay: moveDelay(placement.execution?.steps, placement.rotation, placement.x),
      lastSrs:
        placement.srsKickIndex === undefined
          ? placement.rotation === 0
            ? 0
            : 1
          : placement.srsKickIndex + 1,
      ...(placement.execution === undefined ? {} : { execution: placement.execution }),
    }));
}

function isEmpty(board: Board): boolean {
  for (let y = 0; y < board.length; y += 1) {
    if ((board[y] ?? 0) !== 0) return false;
  }
  return true;
}

function sourceOthers(
  ctx: { readonly combo: number; readonly btb: number },
  lines: number,
  tspin: TspinKind,
  after: Board,
): { readonly combo: number; readonly btb: number; readonly act: ClearAct } {
  let combo = ctx.combo;
  if (lines === 0) {
    combo = combo > 0 ? -combo : 0;
  } else {
    if (combo < 0) combo = 0;
    combo += 1;
  }
  const isPc = lines > 0 && isEmpty(after);
  let btb: number;
  if (lines === 0) btb = ctx.btb;
  else if (isPc) btb = lines >= 4 ? ctx.btb + 1 : 0;
  else if (lines === 4 || (tspin !== "none" && lines > 0)) btb = ctx.btb + 1;
  else btb = 0;
  let act: ClearAct;
  if (lines === 0) act = "None";
  else if (isPc) act = "Pc";
  else if (lines === 4) act = "Quad";
  else if (tspin === "mini") act = "Tsm";
  else if (tspin === "full") act = lines === 1 ? "Tss" : lines === 2 ? "Tsd" : "Tst";
  else act = lines === 1 ? "Single" : lines === 2 ? "Double" : "Triple";
  return { combo, btb, act };
}

function lockBeforeClear(
  board: Board,
  cells: readonly { readonly x: number; readonly y: number }[],
  px: number,
  py: number,
): Board {
  const locked = cloneBoard(board);
  for (const cell of cells) {
    const x = px + cell.x;
    const y = py + cell.y;
    if (x < 0 || x >= 10 || y < 0 || y >= locked.length) continue;
    locked[y] = (locked[y] ?? 0) | (1 << x);
  }
  return locked;
}

function applyPlacement(
  node: SearchNode,
  placedPiece: PieceKind,
  fallingPiece: PieceKind | undefined,
  p: Placement,
  holdAfter: PieceKind | null,
  canHoldAfter: boolean,
  queueIndexAfter: number,
  nextPieceOverrideAfter: PieceKind | null,
  isFirst: boolean,
  ply: number,
  ew: HoikoWeights,
  weightIndex: number,
  isEvenBoard: boolean,
  useS4W: boolean,
  opponentIsPowerful: boolean,
): SearchNode | null {
  const cells = bottomCellsOf(placedPiece, p.rotation);
  const y = p.y;
  if (y > 19) return null;
  if (collides(node.board, cells, p.x, y)) return null;
  const transition = computeLockAfterstate(node.board, cells, p.x, y);
  if (transition.topOut && transition.linesCleared === 0) return null;
  const test = transition.after;
  const beforeClear = lockBeforeClear(node.board, cells, p.x, y);
  const tspin: TspinKind =
    placedPiece === "T" ? classifyTspin(beforeClear, cells, p.x, y, p.rotation, p.lastSrs) : "none";
  const pendingAfter = Math.max(0, node.pending - transition.linesCleared);
  const src = toSourceBoard(test);
  const others = sourceOthers(
    { combo: node.combo, btb: node.btb },
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
      fallingMino: fallingPiece ?? placedPiece,
      moveDelay: p.moveDelay + (holdAfter !== node.hold ? 16 : 0),
    },
    ew,
    weightIndex,
    isEvenBoard,
    useS4W,
    opponentIsPowerful,
    trustRate,
    node.pcScore,
  );
  const familyScore = evalResult.familyScore + node.familyScore;
  const score = evalResult.score + node.familyScore;
  return {
    board: test,
    hold: holdAfter,
    canHold: canHoldAfter,
    btb: others.btb,
    combo: others.combo,
    queueIndex: queueIndexAfter,
    nextPieceOverride: nextPieceOverrideAfter,
    familyScore,
    score,
    pcScore: evalResult.pcScore,
    planActs: [...node.planActs, others.act],
    ...(isFirst
      ? node.hold === null && holdAfter === node.hold && p.execution !== undefined
        ? { firstExecution: p.execution }
        : {}
      : node.firstExecution === undefined
        ? {}
        : { firstExecution: node.firstExecution }),
    firstRotation: isFirst ? p.rotation : node.firstRotation,
    firstX: isFirst ? p.x : node.firstX,
    firstHold: isFirst ? holdAfter !== node.hold : node.firstHold,
    after: test,
    linesCleared: transition.linesCleared,
    isTspin: tspin !== "none",
    pending: pendingAfter,
  };
}

function expandNode(
  node: SearchNode,
  piece: PieceKind,
  nextPiece: PieceKind | undefined,
  followingPiece: PieceKind | undefined,
  isFirst: boolean,
  ply: number,
  ew: HoikoWeights,
  weightIndex: number,
  isEvenBoard: boolean,
  useS4W: boolean,
  opponentIsPowerful: boolean,
  useHold: boolean,
): SearchNode[] {
  const out: SearchNode[] = [];
  const queueState: SearchQueueState = {
    queueIndex: node.queueIndex,
    nextPieceOverride: node.nextPieceOverride,
  };
  const normalQueue = advanceSearchQueue(queueState, "normal", piece);
  for (const p of enumeratePlacements(node.board, piece, isFirst)) {
    const child = applyPlacement(
      node,
      piece,
      nextPiece,
      p,
      node.hold,
      true,
      normalQueue.queueIndex,
      normalQueue.nextPieceOverride,
      isFirst,
      ply,
      ew,
      weightIndex,
      isEvenBoard,
      useS4W,
      opponentIsPowerful,
    );
    if (child !== null) out.push(child);
  }
  if (useHold && node.canHold) {
    if (node.hold !== null && node.hold !== piece) {
      const held = node.hold;
      const swapQueue = advanceSearchQueue(queueState, "swapHold", piece);
      for (const p of enumeratePlacements(node.board, held, isFirst)) {
        const child = applyPlacement(
          node,
          held,
           piece,
           p,
           piece,
           true,
           swapQueue.queueIndex,
           swapQueue.nextPieceOverride,
          isFirst,
          ply,
          ew,
          weightIndex,
          isEvenBoard,
          useS4W,
          opponentIsPowerful,
        );
        if (child !== null) out.push(child);
      }
    } else if (node.hold === null && nextPiece !== undefined) {
      const emptyHoldQueue = advanceSearchQueue(queueState, "emptyHold", piece);
      for (const p of enumeratePlacements(node.board, nextPiece, isFirst)) {
        const child = applyPlacement(
          node,
          nextPiece,
           followingPiece,
           p,
           piece,
           true,
           emptyHoldQueue.queueIndex,
           emptyHoldQueue.nextPieceOverride,
          isFirst,
          ply,
          ew,
          weightIndex,
          isEvenBoard,
          useS4W,
          opponentIsPowerful,
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
  btb: number,
  combo: number,
  ew: HoikoWeights,
  options: HoikoSearchOptions = {},
): HoikoSearchMove | null {
  const width = options.width ?? 50;
  const correctedWidth = options.correctedWidth ?? width * 3;
  const depth = Math.min(options.depth ?? 14, queue.length + 1);
  const useHold = options.useHold ?? true;
  const pending = options.pending ?? 0;
  const isEvenBoard = options.isEvenBoard ?? isEvenPop(toSourceBoard(board));
  const weightIndex = options.weightIndex ?? 0;
  const useS4W = options.useS4W ?? false;
  const opponentIsPowerful = options.opponentIsPowerful ?? false;

  const pieces: readonly PieceKind[] = [current, ...queue.slice(0, depth + 1)];
  if (pieces.length === 0) return null;
  const PLIES = depth;

  let beam: SearchNode[] = [
    {
      board: cloneBoard(board),
      hold,
      canHold,
      btb,
      combo,
      queueIndex: 0,
      nextPieceOverride: null,
      familyScore: 0,
      score: 0,
      pcScore: 0,
      firstRotation: 0,
      firstX: 0,
      firstHold: false,
      after: cloneBoard(board),
      linesCleared: 0,
      isTspin: false,
      planActs: [],
      pending,
    },
  ];

  for (let ply = 0; ply < PLIES; ply += 1) {
    const nextBeam: SearchNode[] = [];
    for (const node of beam) {
      const piece = node.nextPieceOverride ?? pieces[node.queueIndex];
      if (piece === undefined) continue;
      const nextQueueIndex =
        node.nextPieceOverride === null ? node.queueIndex + 1 : node.queueIndex;
      const nextPiece: PieceKind | undefined = pieces[nextQueueIndex];
      const followingPiece: PieceKind | undefined = pieces[nextQueueIndex + 1];
      const expanded = expandNode(
        node,
        piece,
        nextPiece,
        followingPiece,
        ply === 0,
        ply,
        ew,
        weightIndex,
        isEvenBoard,
        useS4W,
        opponentIsPowerful,
        useHold,
      );
      for (const child of expanded) nextBeam.push(child);
    }
    if (nextBeam.length === 0) break;
    nextBeam.sort((a: SearchNode, b: SearchNode) => b.score - a.score);
    const limit =
      ply === 0
        ? Math.min(100, nextBeam.length)
        : Math.min(correctedWidth >> (ply >= 7 ? 1 : 0), nextBeam.length);
    beam = nextBeam.slice(0, Math.max(limit, width));
  }

  if (beam.length === 0) return null;
  let bestLeaf = beam[0];
  if (bestLeaf === undefined) return null;
  let bestCorrected = correctedScore(bestLeaf, ew);
  for (const candidate of beam.slice(1)) {
    const corrected = correctedScore(candidate, ew);
    if (corrected > bestCorrected) {
      bestLeaf = candidate;
      bestCorrected = corrected;
    }
  }
  return {
    rotation: bestLeaf.firstRotation,
    x: bestLeaf.firstX,
    useHold: bestLeaf.firstHold,
    score: bestLeaf.score,
    after: bestLeaf.after,
    linesCleared: bestLeaf.linesCleared,
    isTspin: bestLeaf.isTspin,
    planActs: bestLeaf.planActs,
    ...(bestLeaf.firstExecution === undefined ? {} : { execution: bestLeaf.firstExecution }),
  };
}

function correctedScore(node: SearchNode, ew: HoikoWeights): number {
  const comboDebt = node.combo > 0 ? node.combo * (ew.weight[W.ComboDebt] ?? 0) : 0;
  return node.score - comboDebt - node.pcScore;
}
