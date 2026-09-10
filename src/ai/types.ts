/**
 * Shared AI types. Self-contained: does not depend on core/* (core is empty).
 *
 * Board model: Uint16Array bitboard, index 0 = bottom row.
 * Each row uses the low 10 bits (LSB = x 0), FULL_ROW = 0x3FF.
 * Board height = array length (usually 20). Cells above the top are
 * treated as empty space during search; placements fully above are skipped.
 */

export const COLS = 10;

export const ROWS = 20;

export const FULL_ROW = 0x3ff;

export type PieceKind = "I" | "O" | "T" | "S" | "Z" | "J" | "L";

export type Board = Uint16Array;

export interface Cell {
  readonly x: number;
  readonly y: number;
}

/** One hard-drop landing candidate with its resulting afterstate. */
export interface Placement {
  readonly rotation: number;
  readonly x: number;
  /** Rest height (bottom-relative) of the piece origin. */
  readonly y: number;
  /** Average bottom-relative height of the 4 locked cells. */
  readonly landingHeight: number;
  readonly linesCleared: number;
  /** Dellacherie eroded cells = linesCleared * pieceCellsInClearedRows. */
  readonly erodedCells: number;
  /** Board after locking the piece and clearing lines. */
  readonly after: Board;
}

export interface BestMove {
  readonly rotation: number;
  readonly x: number;
}
