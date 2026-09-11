/** Tetromino shapes using Hoiko's fixed 4x4 rotation anchors. */

export type PieceKind = "I" | "O" | "T" | "S" | "Z" | "J" | "L";

export interface Cell {
  readonly x: number;
  readonly y: number;
}

type NativeCoord = readonly [number, number];

const NATIVE_CELLS: Readonly<Record<PieceKind, readonly (readonly NativeCoord[])[]>> = {
  I: [
    [[0, 1], [1, 1], [2, 1], [3, 1]],
    [[2, 0], [2, 1], [2, 2], [2, 3]],
    [[0, 2], [1, 2], [2, 2], [3, 2]],
    [[1, 0], [1, 1], [1, 2], [1, 3]],
  ],
  J: [
    [[0, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [2, 2]],
    [[1, 0], [1, 1], [0, 2], [1, 2]],
  ],
  L: [
    [[2, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [1, 2], [2, 2]],
    [[0, 1], [1, 1], [2, 1], [0, 2]],
    [[0, 0], [1, 0], [1, 1], [1, 2]],
  ],
  O: [[[1, 0], [2, 0], [1, 1], [2, 1]]],
  T: [
    [[1, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [1, 2]],
    [[1, 0], [0, 1], [1, 1], [1, 2]],
  ],
  S: [
    [[1, 0], [2, 0], [0, 1], [1, 1]],
    [[1, 0], [1, 1], [2, 1], [2, 2]],
    [[1, 1], [2, 1], [0, 2], [1, 2]],
    [[0, 0], [0, 1], [1, 1], [1, 2]],
  ],
  Z: [
    [[0, 0], [1, 0], [1, 1], [2, 1]],
    [[2, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [1, 2], [2, 2]],
    [[1, 0], [0, 1], [1, 1], [0, 2]],
  ],
} as const;

export function rotationCount(kind: PieceKind): number {
  return kind === "O" ? 1 : 4;
}

export function bottomCellsOf(kind: PieceKind, rotation: number): readonly Cell[] {
  const cells = cellsFor(kind, rotation);
  let maxY = 0;
  for (const c of cells) if (c.y > maxY) maxY = c.y;
  return cells.map((c) => ({ x: c.x, y: maxY - c.y }));
}

export function cellsFor(kind: PieceKind, rotation: number): readonly Cell[] {
  const n = ((rotation % 4) + 4) % 4;
  const shape = NATIVE_CELLS[kind][kind === "O" ? 0 : n];
  if (shape === undefined) return [];
  return shape.map(([x, y]) => ({ x, y }));
}

export function pieceCellValue(kind: PieceKind): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  switch (kind) {
    case "I":
      return 1;
    case "O":
      return 2;
    case "T":
      return 3;
    case "S":
      return 4;
    case "Z":
      return 5;
    case "J":
      return 6;
    case "L":
      return 7;
  }
}
