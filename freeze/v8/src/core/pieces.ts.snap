/** Tetromino shapes. Rotation = CW turns inside a 4x4 box, normalized to min 0. */

export type PieceKind = "I" | "O" | "T" | "S" | "Z" | "J" | "L";

export interface Cell {
  readonly x: number;
  readonly y: number;
}

const BASE_CELLS: Record<PieceKind, readonly (readonly [number, number])[]> = {
  I: [
    [0, 1],
    [1, 1],
    [2, 1],
    [3, 1],
  ],
  O: [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  T: [
    [1, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
  S: [
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1],
  ],
  Z: [
    [0, 0],
    [1, 0],
    [1, 1],
    [2, 1],
  ],
  J: [
    [0, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
  L: [
    [0, 1],
    [1, 1],
    [2, 1],
    [2, 0],
  ],
} as const;

export function rotationCount(kind: PieceKind): number {
  return kind === "O" ? 1 : 4;
}

function normalize(pts: readonly Cell[]): Cell[] {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return pts.map((p) => ({ x: p.x - minX, y: p.y - minY }));
}

export function bottomCellsOf(kind: PieceKind, rotation: number): readonly Cell[] {
  const cells = cellsFor(kind, rotation);
  let maxY = 0;
  for (const c of cells) if (c.y > maxY) maxY = c.y;
  return cells.map((c) => ({ x: c.x, y: maxY - c.y }));
}

export function cellsFor(kind: PieceKind, rotation: number): readonly Cell[] {
  const base = BASE_CELLS[kind].map(([x, y]) => ({ x, y }));
  if (kind === "O") return base;
  const n = ((rotation % 4) + 4) % 4;
  let pts: Cell[] = normalize(base);
  for (let i = 0; i < n; i += 1) {
    const h = Math.max(...pts.map((p) => p.y)) + 1;
    pts = normalize(pts.map((p) => ({ x: h - 1 - p.y, y: p.x })));
  }
  return pts;
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
