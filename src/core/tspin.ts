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
  const next = (index + 1) % 4;
  return occupied[index] !== occupied[next] && lastSrs !== 5 ? "mini" : "full";
}
