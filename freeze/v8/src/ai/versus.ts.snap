import { type Board, cloneBoard, collides, dropY, lockAndClear } from "../core/board.js";
import { bottomCellsOf, type PieceKind } from "../core/pieces.js";
import { extractFeatures, extractFireFeatures } from "./features.js";
import { DU_WEIGHTS, FIRE_WEIGHTS, scoreFire, scorePlacement } from "./weights.js";

export interface VersusOptions {
  readonly tspinBias?: number | undefined;
  readonly tetrisBias?: number | undefined;
  readonly openerDepth?: number | undefined;
}

export interface VersusMove {
  readonly rotation: number;
  readonly x: number;
  readonly useHold: boolean;
  readonly score: number;
  readonly fireScore: number;
  readonly linesCleared: number;
  readonly isTspin: boolean;
  readonly opener: string | null;
}

const OPENER_DEPTH = 7;

const OPENERS: ReadonlyArray<{
  readonly name: string;
  readonly match: (q: readonly PieceKind[]) => boolean;
}> = [
  {
    name: "TKI-3",
    match: (q) => q.length >= 3 && q[0] === "T" && q[1] === "S" && q[2] === "Z",
  },
  {
    name: "DT",
    match: (q) => q.length >= 4 && q[0] === "T" && q[1] === "O" && q[2] === "I" && q[3] === "L",
  },
  {
    name: "Albatross",
    match: (q) => q.length >= 3 && q[0] === "S" && q[1] === "J" && q[2] === "Z",
  },
];

export function detectOpener(queue: readonly PieceKind[]): string | null {
  for (const o of OPENERS) {
    if (o.match(queue)) return o.name;
  }
  return null;
}

export function versusBestMove(
  board: Board,
  current: PieceKind,
  queue: readonly PieceKind[],
  hold: PieceKind | null,
  canHold: boolean,
  combo: number,
  b2b: boolean,
  options: VersusOptions = {},
): VersusMove | null {
  const tspinBias = options.tspinBias ?? 260;
  const tetrisBias = options.tetrisBias ?? 120;
  const openerDepth = options.openerDepth ?? OPENER_DEPTH;
  const seq: readonly PieceKind[] = [current, ...queue.slice(0, 5)];
  const opener = isEmptyBoard(board) && seq.length >= 3 ? detectOpener(seq) : null;

  const candA = bestForPiece(board, current, false, combo, b2b, tspinBias, tetrisBias);
  let best = candA;
  if (canHold && hold !== null) {
    const candH = bestForPiece(board, hold, true, combo, b2b, tspinBias, tetrisBias);
    if (candH !== null && (best === null || candH.score > best.score)) best = candH;
  }
  if (best === null) return null;
  if (opener !== null && isEmptyBoard(board) && countPieces(board) === 0) {
    void openerDepth;
    return { ...best, opener };
  }
  return { ...best, opener };
}

function isEmptyBoard(board: Board): boolean {
  for (let y = 0; y < board.length; y += 1) {
    if ((board[y] ?? 0) !== 0) return false;
  }
  return true;
}

function countPieces(board: Board): number {
  let n = 0;
  for (let y = 0; y < board.length; y += 1) {
    let r = board[y] ?? 0;
    while (r !== 0) {
      n += r & 1;
      r >>>= 1;
    }
  }
  return n;
}

function bestForPiece(
  board: Board,
  piece: PieceKind,
  useHold: boolean,
  combo: number,
  b2b: boolean,
  tspinBias: number,
  tetrisBias: number,
): VersusMove | null {
  let best: VersusMove | null = null;
  const rots = piece === "O" ? 1 : 4;
  for (let r = 0; r < rots; r += 1) {
    const cells = bottomCellsOf(piece, r);
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
      const test = cloneBoard(board);
      if (collides(test, cells, px, y)) continue;
      const info = lockAndClear(test, cells, px, y);
      if (info.topOut && info.linesCleared === 0) continue;
      const avgLanding = cells.reduce((s, c) => s + (y + c.y + 1), 0) / cells.length;
      const feat = extractFeatures(
        test,
        avgLanding,
        info.linesCleared * info.pieceCellsInClearedRows,
      );
      const tspin = piece === "T" && hasTslot(test, cells, px, y);
      const fire = extractFireFeatures({
        linesCleared: info.linesCleared,
        tspin,
        tspinLines: tspin ? info.linesCleared : 0,
        b2bActive: b2b,
        combo: info.linesCleared > 0 ? combo + 1 : -1,
        perfectClear: isEmptyBoard(test),
      });
      const fireScore =
        scoreFire(fire, FIRE_WEIGHTS) +
        (tspin && info.linesCleared > 0 ? tspinBias : 0) +
        (info.linesCleared === 4 ? tetrisBias : 0);
      const score = scorePlacement(feat, info.linesCleared, DU_WEIGHTS) + fireScore;
      if (best === null || score > best.score) {
        best = {
          rotation: r,
          x: px,
          useHold,
          score,
          fireScore,
          linesCleared: info.linesCleared,
          isTspin: tspin,
          opener: null,
        };
      }
    }
  }
  return best;
}

function hasTslot(
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
