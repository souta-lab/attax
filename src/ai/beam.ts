import type { Board } from "../core/board.js";
import { cloneBoard, collides, computeLockAfterstate, dropY } from "../core/board.js";
import { isDifficultClear } from "../core/garbage.js";
import type { PieceKind } from "../core/pieces.js";
import { bottomCellsOf } from "../core/pieces.js";
import { classifyPlacement } from "../core/tspin.js";
import type { AiExecutionPlan } from "../ui/types.js";
import { DEFAULTS } from "./config.js";
import {
  type BeamEvaluation,
  type BeamFireWeights,
  createBeamEvaluation,
  type HardVeto,
  type PlyContext,
  type PlyScorer,
  type ScoreAdjust,
} from "./evaluation.js";
import { extractFeatures, extractFireFeatures, type FeatureVector } from "./features.js";
import {
  enumerateKickPlacements,
  enumerateScored,
  type PlacementGenerator,
  type ScoredPlacement,
} from "./search.js";
import { DU_WEIGHTS, FIRE_WEIGHTS, scoreFire, scorePlacement, type Weights } from "./weights.js";

export type {
  BeamAfterstateInput,
  BeamEvaluation,
  BeamEvaluationDefinition,
  BeamFireWeights,
  BeamRanker,
  BeamRankInput,
  BeamScorer,
  BeamVeto,
  HardVeto,
  PlyContext,
  PlyScorer,
  ScoreAdjust,
} from "./evaluation.js";
export { createBeamEvaluation } from "./evaluation.js";

export interface BeamOptions {
  readonly weights?: Weights | undefined;
  readonly fireWeights?: BeamFireWeights | undefined;
  readonly width?: number | undefined;
  readonly depth?: number | undefined;
  readonly topK?: number | undefined;
  readonly useHold?: boolean | undefined;
  readonly scoreAdjust?: ScoreAdjust | undefined;
  readonly scorer?: PlyScorer | undefined;
  readonly veto?: HardVeto | undefined;
  readonly evaluation?: BeamEvaluation | undefined;
  readonly pending?: number | undefined;
  readonly useKick?: boolean | undefined;
  readonly placementGenerator?: PlacementGenerator | undefined;
  readonly sourceRotation?: number | undefined;
  readonly sourceX?: number | undefined;
}

export interface BeamMove {
  readonly rotation: number;
  readonly x: number;
  readonly useHold: boolean;
  readonly score: number;
  readonly after: Board;
  readonly linesCleared: number;
  readonly fireScore: number;
  readonly isTspin: boolean;
  readonly searchDepth: number;
  readonly execution?: AiExecutionPlan;
}

interface BeamNode {
  readonly board: Board;
  readonly hold: PieceKind | null;
  readonly canHold: boolean;
  readonly b2b: boolean;
  readonly combo: number;
  readonly queueIndex: number;
  readonly totalScore: number;
  readonly firstRotation: number;
  readonly firstX: number;
  readonly firstHold: boolean;
  readonly firstExecution: AiExecutionPlan | null;
  readonly after: Board;
  readonly linesCleared: number;
  readonly fireScore: number;
  readonly isTspin: boolean;
  readonly pending: number;
}

export const SETUP_GAMMA = DEFAULTS.setupGamma;

export const SETUP_WELL_STEP = DEFAULTS.wellStepDefault;

export const SUSTAIN_WELL_STEP = 160;

export const SUSTAIN_MIN_DEPTH = 5;

export const SUSTAIN_MAX_HEIGHT = 12;

function wellColOf(after: Board): number {
  const heights: number[] = new Array<number>(10).fill(0);
  for (let x = 0; x < 10; x += 1) {
    for (let y = after.length - 1; y >= 0; y -= 1) {
      if (((after[y] ?? 0) & (1 << x)) !== 0) {
        heights[x] = y + 1;
        break;
      }
    }
  }
  let col = 0;
  let best = heights[0] ?? 0;
  for (let x = 1; x < 10; x += 1) {
    const v = heights[x] ?? 0;
    if (v < best || (v === best && (x === 0 || x === 9))) {
      best = v;
      col = x;
    }
  }
  return col;
}

export function sustainCredit(after: Board, lines: number, tspin: boolean, ply: number): number {
  if (lines > 0 || tspin) return 0;
  const shape: FeatureVector = extractFeatures(after, 0, 0);
  if (shape.holes > 0) return 0;
  if (shape.maxHeight < SUSTAIN_MIN_DEPTH || shape.maxHeight > SUSTAIN_MAX_HEIGHT) return 0;
  const depth = wellDepthOf(after);
  if (depth < SUSTAIN_MIN_DEPTH) return 0;
  const col = wellColOf(after);
  if (col !== 0 && col !== 9) return 0;
  if (ply > 2) return 0;
  return SETUP_GAMMA ** ply * Math.min(6, depth) * SUSTAIN_WELL_STEP;
}

export function setupCredit(
  after: Board,
  lines: number,
  tspin: boolean,
  ply: number,
  fire: BeamFireWeights,
): number {
  const ws = fire.wellStep ?? SETUP_WELL_STEP;
  if (ws === 0 && (fire.tslotStep ?? 0) === 0) return 0;
  if (lines > 0 || tspin) return 0;
  const shape: FeatureVector = extractFeatures(after, 0, 0);
  if (shape.holes > 0 || shape.maxHeight < 6 || shape.maxHeight > 7) return 0;
  const depth = wellDepthOf(after);
  if (depth < 4) return 0;
  if (ply <= 1 && depth < 6) return 0;
  const well = SETUP_GAMMA ** ply * Math.min(6, depth) * ws;
  return well + SETUP_GAMMA ** ply * Math.min(2, countTslots(after)) * (fire.tslotStep ?? 0);
}

const DEFAULT_WIDTH = DEFAULTS.width;
const DEFAULT_DEPTH = DEFAULTS.depth;
const DEFAULT_TOP_K = DEFAULTS.topK;

export { DEFAULT_WIDTH, DEFAULT_DEPTH, DEFAULT_TOP_K };

function boardFingerprint(board: Board): string {
  return Array.from(board, (row) => row & 0x3ff).join(",");
}

function attachExecutionPrecondition(
  move: BeamMove,
  board: Board,
  current: PieceKind,
  hold: PieceKind | null,
  canHold: boolean,
  sourceRotation: number,
  sourceX: number,
): BeamMove {
  if (move.execution === undefined) return move;
  return {
    ...move,
    execution: {
      ...move.execution,
      sourceActiveKind: current,
      sourceRotation,
      sourceX,
      sourceBoardFingerprint: boardFingerprint(board),
      sourceHold: hold,
      sourceCanHold: canHold,
    },
  };
}

export function beamBestMove(
  board: Board,
  current: PieceKind,
  queue: readonly PieceKind[],
  hold: PieceKind | null,
  canHold: boolean,
  b2b: boolean,
  combo: number,
  options: BeamOptions = {},
): BeamMove | null {
  const weights = options.weights ?? DU_WEIGHTS;
  const fire: BeamFireWeights = { ...FIRE_WEIGHTS, ...(options.fireWeights ?? {}) };
  const width = options.width ?? DEFAULTS.width;
  // A depth-D search places the current piece plus D-1 lookahead pieces, so the
  // clamp must allow queue.length + 1 (previous code capped at queue.length).
  const depth = Math.min(options.depth ?? DEFAULTS.depth, queue.length + 1);
  const topK = options.topK ?? DEFAULTS.topK;
  const useHold = options.useHold ?? true;
  const evaluation =
    options.evaluation ??
    createBeamEvaluation({
      ...(options.scorer === undefined ? {} : { scorer: options.scorer }),
      ...(options.scoreAdjust === undefined ? {} : { scoreAdjust: options.scoreAdjust }),
      ...(options.veto === undefined ? {} : { legacyVeto: options.veto }),
    });
  const pendingRoot = options.pending ?? 0;
  const useKick = options.useKick ?? false;
  const sourceRotation = options.sourceRotation ?? 0;
  const sourceX = options.sourceX ?? 3;
  const placementGenerator: PlacementGenerator =
    options.placementGenerator ??
    (useKick
      ? enumerateKickPlacements
      : (placementBoard, placementKind) => enumerateScored(placementBoard, placementKind, weights));

  const pieces: readonly PieceKind[] = [current, ...queue.slice(0, depth)];
  if (pieces.length === 0) return null;
  const PLIES = depth;

  let beam: BeamNode[] = [
    {
      board: cloneBoard(board),
      hold,
      canHold,
      b2b,
      combo,
      queueIndex: 0,
      totalScore: 0,
      firstRotation: 0,
      firstX: 0,
      firstHold: false,
      firstExecution: null,
      after: cloneBoard(board),
      linesCleared: 0,
      fireScore: 0,
      isTspin: false,
      pending: pendingRoot,
    },
  ];

  let firstMoves: BeamMove[] = [];

  for (let ply = 0; ply < PLIES; ply += 1) {
    const nextBeam: BeamNode[] = [];
    for (const node of beam) {
      const piece = pieces[node.queueIndex];
      if (piece === undefined) {
        nextBeam.push(node);
        continue;
      }
      const nextPiece: PieceKind | undefined = pieces[node.queueIndex + 1];
      const expanded = expandWithHold(
        node,
        piece,
        nextPiece,
        ply === 0,
        ply,
        useHold,
        weights,
        fire,
        topK,
        evaluation,
        useKick,
        placementGenerator,
      );
      for (const child of expanded) {
        if (ply === 0) {
          firstMoves.push({
            rotation: child.firstRotation,
            x: child.firstX,
            useHold: child.firstHold,
            score: child.totalScore,
            after: child.after,
            linesCleared: child.linesCleared,
            fireScore: child.fireScore,
            isTspin: child.isTspin,
            searchDepth: PLIES,
            ...(child.firstExecution === null ? {} : { execution: child.firstExecution }),
          });
        }
        nextBeam.push(child);
      }
    }
    if (nextBeam.length === 0) break;
    nextBeam.sort((a: BeamNode, b: BeamNode) => b.totalScore - a.totalScore);
    beam = dedupe(nextBeam).slice(0, width);
    if (ply === 0) {
      firstMoves.sort((a: BeamMove, b: BeamMove) => b.score - a.score);
      firstMoves = dedupeMoves(firstMoves).slice(0, Math.max(width, topK));
    }
  }

  if (beam.length === 0 || firstMoves.length === 0) return null;
  const bestLeaf = beam[0];
  if (bestLeaf === undefined) return null;
  const match = firstMoves.find(
    (m) =>
      m.rotation === bestLeaf.firstRotation &&
      m.x === bestLeaf.firstX &&
      m.useHold === bestLeaf.firstHold,
  );
  if (match !== undefined) {
    return attachExecutionPrecondition(
      match,
      board,
      current,
      hold,
      canHold,
      sourceRotation,
      sourceX,
    );
  }
  return attachExecutionPrecondition(
    {
      rotation: bestLeaf.firstRotation,
      x: bestLeaf.firstX,
      useHold: bestLeaf.firstHold,
      score: bestLeaf.totalScore,
      after: bestLeaf.after,
      linesCleared: bestLeaf.linesCleared,
      fireScore: bestLeaf.fireScore,
      isTspin: bestLeaf.isTspin,
      searchDepth: PLIES,
      ...(bestLeaf.firstExecution === null ? {} : { execution: bestLeaf.firstExecution }),
    },
    board,
    current,
    hold,
    canHold,
    sourceRotation,
    sourceX,
  );
}

function boardKey(board: Board, hold: PieceKind | null, canHold: boolean): string {
  let h = 0;
  for (let y = 0; y < board.length; y += 1) {
    h = (Math.imul(h, 31) + (board[y] ?? 0)) | 0;
  }
  return `${h}:${hold ?? "-"}:${canHold ? 1 : 0}`;
}

function dedupe(nodes: BeamNode[]): BeamNode[] {
  const seen = new Set<string>();
  const out: BeamNode[] = [];
  for (const n of nodes) {
    const k = boardKey(n.board, n.hold, n.canHold);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

function dedupeMoves(moves: BeamMove[]): BeamMove[] {
  const seen = new Set<string>();
  const out: BeamMove[] = [];
  for (const m of moves) {
    const k = `${m.rotation},${m.x},${m.useHold ? 1 : 0}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out;
}

function expandWithHold(
  node: BeamNode,
  piece: PieceKind,
  nextPiece: PieceKind | undefined,
  isFirst: boolean,
  ply: number,
  useHold: boolean,
  weights: Weights,
  fire: BeamFireWeights,
  topK: number,
  evaluation: BeamEvaluation,
  useKick: boolean,
  placementGenerator: PlacementGenerator,
): BeamNode[] {
  const out: BeamNode[] = [];
  const scored = rankWithEvaluation(
    node,
    piece,
    weights,
    fire,
    topK,
    evaluation,
    undefined,
    useKick,
    ply,
    placementGenerator,
    nextPiece,
  );
  for (const s of scored) {
    const child = applyPlacement(
      node,
      piece,
      s,
      false,
      isFirst,
      ply,
      weights,
      fire,
      evaluation,
      nextPiece,
    );
    if (child !== null) out.push(child);
  }
  if (useHold && node.canHold) {
    const held: PieceKind | null = node.hold;
    if (held !== null) {
      const scoredHold = rankWithEvaluation(
        { ...node, board: node.board },
        held,
        weights,
        fire,
        topK,
        evaluation,
        held,
        useKick,
        ply,
        placementGenerator,
        nextPiece,
      );
      for (const s of scoredHold) {
        const child = applyPlacement(
          node,
          held,
          s,
          true,
          isFirst,
          ply,
          weights,
          fire,
          evaluation,
          nextPiece,
        );
        if (child !== null) out.push(child);
      }
    } else {
      if (nextPiece !== undefined) {
        const scoredNext = rankWithEvaluation(
          node,
          nextPiece,
          weights,
          fire,
          topK,
          evaluation,
          undefined,
          useKick,
          ply,
          placementGenerator,
          nextPiece,
        );
        for (const s of scoredNext) {
          const child = applyPlacement(
            node,
            nextPiece,
            s,
            true,
            isFirst,
            ply,
            weights,
            fire,
            evaluation,
            nextPiece,
          );
          if (child !== null) out.push({ ...child, queueIndex: child.queueIndex + 1 });
        }
      }
    }
  }
  return out;
}

function rankWithEvaluation(
  node: BeamNode,
  piece: PieceKind,
  weights: Weights,
  fire: BeamFireWeights,
  topK: number,
  evaluation: BeamEvaluation,
  heldPiece?: PieceKind,
  useKick?: boolean,
  rankPly?: number,
  placementGenerator?: PlacementGenerator,
  nextPiece?: PieceKind,
): ScoredPlacement[] {
  void heldPiece;
  const kickHere = useKick === true && (rankPly ?? 0) === 0;
  const list = (
    (rankPly ?? 0) === 0 && placementGenerator !== undefined
      ? placementGenerator(node.board, piece)
      : kickHere
        ? enumerateKickPlacements(node.board, piece)
        : enumerateScored(node.board, piece, weights)
  ).slice();
  const ctx: PlyContext = {
    ply: 0,
    combo: node.combo,
    b2b: node.b2b,
    pending: node.pending,
    pendingAfter: node.pending,
    weights,
    fire,
    piece,
    hold: heldPiece !== undefined ? piece : node.hold,
    nextPiece,
  };
  const rescored = list.map((s) => {
    const tspin =
      piece === "T" && isTspinShape(s.after, bottomCellsOf(piece, s.rotation), s.x, s.y);
    const tspinKind = classifyPlacement(node.board, piece, s.rotation, s.x, s.y);
    const pendingAfter = Math.max(0, node.pending - s.linesCleared);
    const c: PlyContext = { ...ctx, pendingAfter, tspinKind };
    const input = { after: s.after, lines: s.linesCleared, tspin, context: c };
    if (evaluation.veto(input)) return { s, total: Number.NEGATIVE_INFINITY };
    return {
      s,
      total: evaluation.rank({ placement: s, piece, tspin, context: c }),
    };
  });
  return rescored
    .filter((e) => e.total > Number.NEGATIVE_INFINITY)
    .sort((a, b) => b.total - a.total)
    .slice(0, topK)
    .map((e) => e.s);
}

function applyPlacement(
  node: BeamNode,
  piece: PieceKind,
  s: ScoredPlacement,
  usedHold: boolean,
  isFirst: boolean,
  ply: number,
  weights: Weights,
  fire: BeamFireWeights,
  evaluation: BeamEvaluation,
  nextPiece?: PieceKind,
): BeamNode | null {
  const cells = bottomCellsOf(piece, s.rotation);
  const isExecutable = s.execution !== undefined;
  const y = isExecutable ? s.y : dropY(node.board, cells, s.x, node.board.length + 4);
  if (collides(node.board, cells, s.x, y)) return null;
  const transition = computeLockAfterstate(node.board, cells, s.x, y);
  if (transition.topOut && transition.linesCleared === 0) return null;
  if (
    isExecutable &&
    (transition.y !== s.y ||
      transition.linesCleared !== s.linesCleared ||
      transition.after.length !== s.after.length ||
      !transition.after.every((row, index) => row === s.after[index]))
  ) {
    return null;
  }
  const test = transition.after;
  const beforeRows = countFilledRows(node.board);
  const tspin = piece === "T" && isTspinShape(test, cells, s.x, y);
  // Engine verdict (what the lock awards) vs. the post-clear shape heuristic.
  const tspinKind = classifyPlacement(node.board, piece, s.rotation, s.x, y);
  const pendingAfter = Math.max(0, node.pending - transition.linesCleared);
  const nextHold: PieceKind | null = usedHold ? piece : node.hold;
  const ctx: PlyContext = {
    ply,
    combo: node.combo,
    b2b: node.b2b,
    pending: node.pending,
    pendingAfter,
    weights,
    fire,
    piece,
    hold: nextHold,
    nextPiece,
    tspinKind,
  };
  const evaluationInput = { after: test, lines: transition.linesCleared, tspin, context: ctx };
  if (evaluation.veto(evaluationInput)) return null;
  const avgLanding = cells.reduce((sum, c) => sum + (y + c.y + 1), 0) / cells.length;
  const eroded = transition.linesCleared * transition.pieceCellsInClearedRows;
  const feat = extractFeatures(test, avgLanding, eroded);
  const perfectClear = beforeRows > 0 && isEmpty(test);
  const nextCombo = transition.linesCleared > 0 ? node.combo + 1 : -1;
  const fireScore = scoreFire(
    extractFireFeatures({
      linesCleared: transition.linesCleared,
      tspin,
      tspinLines: tspin && tspinKind !== "mini" ? transition.linesCleared : 0,
      b2bActive: node.b2b,
      combo: nextCombo,
      perfectClear,
    }),
    fire,
  );
  const placementScore = scorePlacement(feat, transition.linesCleared, weights);
  const totalScore =
    node.totalScore +
    placementScore +
    fireScore +
    setupCredit(test, transition.linesCleared, tspin, ply, fire) +
    sustainCredit(test, transition.linesCleared, tspin, ply) +
    evaluation.score(evaluationInput);
  // Same predicate the engine applies on lock (issue #27).
  const nextB2b =
    transition.linesCleared > 0 ? isDifficultClear(transition.linesCleared, tspinKind) : node.b2b;
  return {
    board: test,
    hold: nextHold,
    canHold: usedHold ? false : node.canHold,
    b2b: nextB2b,
    combo: nextCombo,
    queueIndex: node.queueIndex + 1,
    totalScore,
    firstRotation: isFirst ? s.rotation : node.firstRotation,
    firstX: isFirst ? s.x : node.firstX,
    firstHold: isFirst ? usedHold : node.firstHold,
    firstExecution: isFirst ? (s.execution ?? null) : node.firstExecution,
    after: test,
    linesCleared: transition.linesCleared,
    fireScore,
    isTspin: tspin,
    pending: pendingAfter,
  };
}
function countFilledRows(board: Board): number {
  let n = 0;
  for (let y = 0; y < board.length; y += 1) {
    if ((board[y] ?? 0) !== 0) n += 1;
  }
  return n;
}

function countTslots(after: Board): number {
  let n = 0;
  for (let y = 1; y <= 14 && y < after.length; y += 1) {
    for (let x = 0; x < 10; x += 1) {
      if (((after[y] ?? 0) & (1 << x)) !== 0) continue;
      if (((after[y - 1] ?? 0) & (1 << x)) === 0) continue;
      let filled = 0;
      if (x === 0 || ((after[y] ?? 0) & (1 << (x - 1))) !== 0) filled += 1;
      if (x === 9 || ((after[y] ?? 0) & (1 << (x + 1))) !== 0) filled += 1;
      if (y + 1 >= after.length || ((after[y + 1] ?? 0) & (1 << x)) !== 0) filled += 1;
      if (filled >= 2) {
        n += 1;
        if (n >= 2) return 2;
      }
    }
  }
  return n;
}

function wellDepthOf(after: Board): number {
  const heights: number[] = new Array<number>(10).fill(0);
  for (let x = 0; x < 10; x += 1) {
    for (let y = after.length - 1; y >= 0; y -= 1) {
      if (((after[y] ?? 0) & (1 << x)) !== 0) {
        heights[x] = y + 1;
        break;
      }
    }
  }
  let best = 0;
  for (let x = 0; x < 10; x += 1) {
    const left = x === 0 ? Number.POSITIVE_INFINITY : (heights[x - 1] ?? 0);
    const right = x === 9 ? Number.POSITIVE_INFINITY : (heights[x + 1] ?? 0);
    const depth = Math.min(left, right) - (heights[x] ?? 0);
    if (depth > best) best = depth;
  }
  return best;
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
