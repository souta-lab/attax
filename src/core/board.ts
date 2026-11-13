/** Bottom-up bitboard used by T-spin classification: 10 columns, index 0 = bottom row. */

export const COLS = 10 as const;

export type Board = Uint16Array;

export function createBoard(rows: number): Board {
  return new Uint16Array(rows);
}
