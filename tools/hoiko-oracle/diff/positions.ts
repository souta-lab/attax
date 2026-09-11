/**
 * Test positions for the Hoiko differential harness.
 *
 * Native orientation: `board[y]` is Board.line[y], row 0 = BOTTOM, and column c
 * is bit `9-c` (so column 9 is bit 0). `next` is the 28-int MinoType stream;
 * next[0] becomes the current piece.
 */

export const MINO: Record<string, number> = { I: 0, J: 1, L: 2, O: 3, T: 4, S: 5, Z: 6 };

export const COL_BIT = (c: number): number => 1 << (9 - c);

/** Set a column to `h` high (bottom-up). */
export function stack(line: number[], col: number, h: number): void {
  for (let y = 0; y < h; y += 1) line[y] = (line[y] ?? 0) | COL_BIT(col);
}

/** Set a column occupied over the inclusive row range [y0, y1] (bottom-up). */
export function stackRows(line: number[], col: number, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y += 1) line[y] = (line[y] ?? 0) | COL_BIT(col);
}

/** Fill a whole floor row (all 10 columns). */
export function floorRow(line: number[], y = 0): void {
  line[y] = 0x3ff;
}

export function makeBoard(build: (line: number[]) => void): number[] {
  const line = new Array<number>(32).fill(0);
  build(line);
  return line;
}

/** Default 28-piece queue used by the proven repro: I O T S Z J L I O ... */
export const REPRO_NEXT: number[] = [0, 3, 4, 5, 6, 1, 2, 0, 3, 4, 5, 6, 1, 2, 0, 3, 4, 5, 6, 1, 2, 0, 3, 4, 5, 6, 1, 2];

export interface Position {
  readonly name: string;
  readonly board: number[];
  readonly next: number[];
  readonly note: string;
}

export const POSITIONS: Position[] = [
  {
    name: "repro-asrun",
    // EXACT board the oracle ran for the "empty" repro: board=0x0 only zeroes
    // line[0]; the stub's defaults line[1..3]=0x001 (column 9) survive.
    board: makeBoard((l) => {
      // EXACT board the oracle ran: line[0]=0 (board=0x0 override), the stub's
      // surviving defaults line[1..3]=0x001 => column 9 occupied at rows 1..3.
      stackRows(l, 9, 1, 3);
    }),
    next: REPRO_NEXT,
    note: "repro board as actually tested (3-high stack at col9)",
  },
  {
    name: "empty",
    board: makeBoard(() => {}),
    next: REPRO_NEXT,
    note: "truly empty (all 32 rows zero)",
  },
  {
    name: "flat",
    board: makeBoard((l) => floorRow(l, 0)),
    next: REPRO_NEXT,
    note: "floor only",
  },
  {
    name: "well9",
    board: makeBoard((l) => {
      for (let c = 0; c <= 8; c += 1) stack(l, c, 1);
    }),
    next: REPRO_NEXT,
    note: "floor cols0-8, well at col9",
  },
  {
    name: "well0",
    board: makeBoard((l) => {
      for (let c = 1; c <= 9; c += 1) stack(l, c, 1);
      stack(l, 0, 3);
    }),
    next: REPRO_NEXT,
    note: "floor cols1-9, 3-high col0 (original default synthetic)",
  },
  {
    name: "overhang",
    board: makeBoard((l) => {
      for (let c = 0; c <= 9; c += 1) stack(l, c, 2);
      stack(l, 3, 5); // an overhang tower
      stack(l, 7, 4);
      l[2] = 0; // carve a hole under col-3 tower
    }),
    next: [4, 0, 5, 6, 1, 2, 3, 4, 0, 5, 6, 1, 2, 3, 4, 0, 5, 6, 1, 2, 3, 4, 0, 5, 6, 1, 2, 3],
    note: "T current, overhang + carved hole",
  },
  {
    name: "midgame",
    board: makeBoard((l) => {
      const heights = [1, 4, 2, 5, 3, 6, 2, 4, 1, 3];
      for (let c = 0; c < 10; c += 1) stack(l, c, heights[c] ?? 0);
      l[1] = (l[1] ?? 0) & ~COL_BIT(3); // hole in col3
      l[3] = (l[3] ?? 0) & ~COL_BIT(5); // hole in col5
    }),
    next: [4, 0, 5, 6, 1, 2, 3, 4, 0, 5, 6, 1, 2, 3, 4, 0, 5, 6, 1, 2, 3, 4, 0, 5, 6, 1, 2, 3],
    note: "mid-game irregular with holes, T current",
  },
  {
    name: "flat-I",
    board: makeBoard((l) => floorRow(l, 0)),
    next: [0, 3, 4, 5, 6, 1, 2, 0, 3, 4, 5, 6, 1, 2, 0, 3, 4, 5, 6, 1, 2, 0, 3, 4, 5, 6, 1, 2],
    note: "floor only, I current",
  },
  {
    name: "midgame-O",
    board: makeBoard((l) => {
      const heights = [2, 0, 4, 1, 5, 2, 6, 0, 3, 2];
      for (let c = 0; c < 10; c += 1) stack(l, c, heights[c] ?? 0);
    }),
    next: [3, 4, 0, 5, 6, 1, 2, 3, 4, 0, 5, 6, 1, 2, 3, 4, 0, 5, 6, 1, 2, 3, 4, 0, 5, 6, 1, 2],
    note: "mid-game, O current",
  },
];
