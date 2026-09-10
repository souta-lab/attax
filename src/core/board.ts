/** Bitboard helpers: 10 cols x N rows, index 0 = bottom row, low 10 bits used. */

export const COLS = 10 as const;

export const FULL_ROW = 0x3ff as const;

export type Board = Uint16Array;

export function createBoard(rows: number): Board {
  return new Uint16Array(rows);
}

export function cloneBoard(board: Board): Board {
  return board.slice();
}

export function cellAt(board: Board, x: number, y: number): boolean {
  if (x < 0 || x >= COLS || y < 0 || y >= board.length) return false;
  const row = board[y];
  if (row === undefined) return false;
  return (row & (1 << x)) !== 0;
}

export function collides(
  board: Board,
  cells: readonly { readonly x: number; readonly y: number }[],
  px: number,
  py: number,
): boolean {
  for (const c of cells) {
    const x = px + c.x;
    const y = py + c.y;
    if (x < 0 || x >= COLS) return true;
    if (y < 0) return true;
    if (y < board.length && cellAt(board, x, y)) return true;
  }
  return false;
}

export function dropY(
  board: Board,
  cells: readonly { readonly x: number; readonly y: number }[],
  px: number,
  startY: number,
): number {
  let y = startY;
  let guard = board.length + 8;
  while (!collides(board, cells, px, y - 1)) {
    y -= 1;
    guard -= 1;
    if (guard <= 0) break;
  }
  return y;
}

export interface LockResult {
  readonly linesCleared: number;
  readonly pieceCellsInClearedRows: number;
  readonly topOut: boolean;
}

export interface LockAfterstate {
  readonly after: Board;
  readonly y: number;
  readonly linesCleared: number;
  readonly pieceCellsInClearedRows: number;
  readonly topOut: boolean;
}

function lockAndClearInPlace(
  board: Board,
  cells: readonly { readonly x: number; readonly y: number }[],
  px: number,
  py: number,
): LockResult {
  let topOut = false;
  for (const c of cells) {
    const x = px + c.x;
    const y = py + c.y;
    if (x < 0 || x >= COLS) continue;
    if (y >= board.length) {
      topOut = true;
      continue;
    }
    if (y < 0) {
      topOut = true;
      continue;
    }
    const row = board[y];
    if (row === undefined) continue;
    board[y] = row | (1 << x);
  }
  let cleared = 0;
  const kept: number[] = [];
  const lockedYs: number[] = [];
  for (const c of cells) {
    const y = py + c.y;
    if (y >= 0 && y < board.length) lockedYs.push(y);
  }
  let pieceCellsInCleared = 0;
  for (let y = 0; y < board.length; y += 1) {
    const row = board[y];
    if (row === FULL_ROW) {
      cleared += 1;
      pieceCellsInCleared += lockedYs.filter((v) => v === y).length;
    } else {
      kept.push(row ?? 0);
    }
  }
  for (let i = kept.length; i < board.length; i += 1) kept.push(0);
  for (let y = 0; y < board.length; y += 1) {
    const v = kept[y];
    if (v !== undefined) board[y] = v;
  }
  return { linesCleared: cleared, pieceCellsInClearedRows: pieceCellsInCleared, topOut };
}

/** Lock cells into board, clear FULL_ROW rows in place. Returns clear info. */
export function lockAndClear(
  board: Board,
  cells: readonly { readonly x: number; readonly y: number }[],
  px: number,
  py: number,
): LockResult {
  return lockAndClearInPlace(board, cells, px, py);
}

export function computeLockAfterstate(
  board: Board,
  cells: readonly { readonly x: number; readonly y: number }[],
  px: number,
  py: number,
): LockAfterstate {
  const after = cloneBoard(board);
  const info = lockAndClearInPlace(after, cells, px, py);
  return { after, y: py, ...info };
}
