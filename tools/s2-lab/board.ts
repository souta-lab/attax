/**
 * Board representation primitives the lab's GPU path needs, vendored from
 * src/ai/bot/movegen.ts in Phase C (2026-11-19) when the TS search was
 * removed. The BFS generator itself is gone with the search; what remains
 * here is the board model (row masks, low 10 bits per row, bit x = column
 * x), the Placement record shape and the spawn position — the pieces the
 * GPU codec, the lab input projection and the witness keys are built on.
 */
import { cellsFor, type PieceKind } from "../../src/core/pieces.js";
import type { TspinKind } from "../../src/core/tspin.js";

export const COLS = 10;
export const ROWS = 20;
export const FULL_ROW = 0x3ff;

export type BitBoard = Uint16Array;

export interface Placement {
  readonly kind: PieceKind;
  readonly rotation: number;
  readonly x: number;
  /** Engine `topRow` for `placeMinoAt`. */
  readonly y: number;
  /** `lastSrs` to report to the engine: 0 = arrived by shift/drop, >0 = by rotation. */
  readonly lastSrs: number;
  readonly tspin: TspinKind;
}

/** Lowest cell row of one rotation of one piece (movegen's buildShape minY). */
function shapeMinY(kind: PieceKind, rotation: number): number {
  let minY = 9;
  for (const c of cellsFor(kind, rotation)) minY = Math.min(minY, c.y);
  return minY;
}

/** Spawn position of a piece on a board with `rows` rows (verbatim movegen semantics). */
export function spawnPosition(
  kind: PieceKind,
  rows = ROWS,
): { rotation: number; x: number; y: number } {
  return { rotation: 0, x: 3, y: rows > ROWS ? rows - 21 : -shapeMinY(kind, 0) };
}
