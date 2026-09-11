import type { Board } from "./board.js";

export type TspinKind = "none" | "mini" | "full";

interface CellLike {
  readonly x: number;
  readonly y: number;
}

function filled(board: Board, x: number, y: number): boolean {
  if (x < 0 || x >= 10 || y < 0) return true;
  if (y >= board.length) return false;
  return ((board[y] ?? 0) & (1 << x)) !== 0;
}

/**
 * Indices into the `corners` array ([BL, BR, TR, TL]) that form the two
 * corners on the side the T points toward. A T-spin is a mini exactly when
 * those two front corners are not both occupied, so the pair must follow the
 * piece's facing per rotation rather than a single fixed adjacent pair.
 */
const FRONT_CORNER_PAIRS: Readonly<Record<number, readonly [number, number]>> = {
  0: [2, 3],
  1: [1, 2],
  2: [0, 1],
  3: [3, 0],
};

/** Classify a locked T using the native four-corner and last-SRS rule. */
export function classifyTspin(
  board: Board,
  cells: readonly CellLike[],
  px: number,
  py: number,
  rotation: number,
  lastSrs: number,
): TspinKind {
  if (cells.length === 0 || lastSrs === 0) return "none";
  let maxY = 0;
  for (const cell of cells) if (cell.y > maxY) maxY = cell.y;
  const nativePy = py + maxY;
  const corners = [
    [px, nativePy],
    [px + 2, nativePy],
    [px + 2, nativePy - 2],
    [px, nativePy - 2],
  ] as const;
  const occupied = corners.map(([x, y]) => filled(board, x, y));
  let count = 0;
  for (const corner of occupied) if (corner) count += 1;
  if (count < 3) return "none";

  const index = ((rotation % 4) + 4) % 4;
  const [frontA, frontB] = FRONT_CORNER_PAIRS[index] ?? [0, 1];
  return occupied[frontA] !== occupied[frontB] && lastSrs !== 5 ? "mini" : "full";
}
