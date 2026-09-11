/**
 * Native Hoiko piece/shape model.
 *
 * Native MinoType codes (Tetriz_Common.h): I=0, J=1, L=2, O=3, T=4, S=5, Z=6,
 * None=7. `src/core/pieces.ts` stores `NATIVE_CELLS` with the SAME
 * leftmost=0 cell offsets as the native `minoCoordinate` table, so those cells
 * are used verbatim. A native cell `(cx, cy)` for a piece anchored at
 * `(p.x, p.y)` occupies board column `p.x + cx` and board row `p.y - cy`
 * (rows count upward from the floor; bits use `9 - col`).
 */

import { cellsFor, type PieceKind } from "../../core/pieces.js";
import type { Rotation } from "../../core/srs.js";

export const MINO_I = 0;
export const MINO_J = 1;
export const MINO_L = 2;
export const MINO_O = 3;
export const MINO_T = 4;
export const MINO_S = 5;
export const MINO_Z = 6;
export const MINO_NONE = 7;

export type MinoType = number;

export const ACT_NONE = 0;
export const ACT_SINGLE = 1;
export const ACT_DOUBLE = 2;
export const ACT_TRIPLE = 3;
export const ACT_QUAD = 4;
export const ACT_TSS = 5;
export const ACT_TSD = 6;
export const ACT_TST = 7;
export const ACT_TSM = 8;
export const ACT_PC = 9;

export type ClearAct = number;

const KIND_BY_MINO: readonly (PieceKind | null)[] = [
  "I",
  "J",
  "L",
  "O",
  "T",
  "S",
  "Z",
  null,
];

const MINO_BY_KIND: Readonly<Record<PieceKind, MinoType>> = {
  I: MINO_I,
  J: MINO_J,
  L: MINO_L,
  O: MINO_O,
  T: MINO_T,
  S: MINO_S,
  Z: MINO_Z,
};

export function minoToKind(m: MinoType): PieceKind | null {
  return KIND_BY_MINO[m] ?? null;
}

export function kindToMino(kind: PieceKind): MinoType {
  return MINO_BY_KIND[kind];
}

export interface MinoCell {
  readonly x: number;
  readonly y: number;
}

export interface Shape {
  readonly cells: readonly MinoCell[];
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  /** rowMask[cy] = OR over cells at local y=cy of (1 << (9 - cx)). */
  readonly rowMask: readonly number[];
}

const EMPTY_SHAPE: Shape = {
  cells: [],
  minX: 0,
  maxX: 0,
  minY: 0,
  maxY: 0,
  rowMask: [0, 0, 0, 0],
};

function buildShape(kind: PieceKind | null, r: number): Shape {
  if (kind === null) return EMPTY_SHAPE;
  const cells = cellsFor(kind, r).map((c) => ({ x: c.x, y: c.y }));
  if (cells.length === 0) return EMPTY_SHAPE;
  let minX = cells[0]?.x ?? 0;
  let maxX = minX;
  let minY = cells[0]?.y ?? 0;
  let maxY = minY;
  const rowMask = [0, 0, 0, 0];
  for (const c of cells) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
    const k = c.y;
    if (k >= 0 && k < 4) rowMask[k] = (rowMask[k] ?? 0) | (1 << (9 - c.x));
  }
  return { cells, minX, maxX, minY, maxY, rowMask };
}

const SHAPE_CACHE: readonly (readonly Shape[])[] = (() => {
  const out: Shape[][] = [];
  for (let m = 0; m <= 7; m += 1) {
    const row: Shape[] = [];
    const kind = KIND_BY_MINO[m] ?? null;
    for (let r = 0; r < 4; r += 1) row.push(buildShape(kind, r));
    out.push(row);
  }
  return out;
})();

export function shapeFor(m: MinoType, r: number): Shape {
  const rr = ((r % 4) + 4) % 4;
  const row = SHAPE_CACHE[m] ?? SHAPE_CACHE[MINO_NONE] ?? [];
  return row[rr] ?? EMPTY_SHAPE;
}

export function asRotation(n: number): Rotation {
  return (((n % 4) + 4) % 4) as Rotation;
}
