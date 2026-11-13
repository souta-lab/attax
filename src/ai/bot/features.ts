/**
 * Board features for the bot's evaluation — each one a plain, explainable number.
 *
 * Shape features (Dellacherie / Cold-Clear family) are computed on the board after a
 * placement and its line clears. The bot's score is a weighted sum (see `weights.ts`);
 * nothing here knows about weights.
 */
import { type BitBoard, COLS, FULL_ROW } from "./movegen.js";

export const BOARD_FEATURES = [
  /** Height of the tallest column (0..20) plus garbage rows that will land under it. */
  "maxHeight",
  /** Squared excess of (tallest column + incoming garbage) over the safe line. */
  "danger",
  /** Empty cells with at least one filled cell above them in the same column. */
  "holes",
  /** Filled cells stacked above holes (cost of digging them out), capped per hole. */
  "holeCover",
  /** Rows that contain at least one hole. */
  "holeRows",
  /** Sum of |height difference| between neighbouring columns, ignoring the well. */
  "bumpiness",
  /** Sum of squared neighbour height differences, ignoring the well. */
  "bumpinessSq",
  /** Filled/empty changes along each row (Dellacherie row transitions). */
  "rowTransitions",
  /** Depth of the main well, capped at 4 (a ready Tetris). */
  "wellDepth",
  /** Columns other than the main well that sit 3+ below both neighbours. */
  "extraWells",
  /** Lines a T-spin into the best open T-slot would clear (0, 1 or 2). */
  "tSlot",
] as const;

export type BoardFeature = (typeof BOARD_FEATURES)[number];
export type BoardFeatures = Record<BoardFeature, number>;

/** Stack height at which garbage pressure starts to matter. */
export const SAFE_HEIGHT = 10;

const heights = new Int32Array(COLS);

export function columnHeights(board: BitBoard, out: Int32Array = heights): Int32Array {
  out.fill(0);
  let seen = 0;
  for (let row = 0; row < board.length && seen !== FULL_ROW; row += 1) {
    const fresh = (board[row] as number) & ~seen;
    if (fresh === 0) continue;
    for (let x = 0; x < COLS; x += 1) if ((fresh & (1 << x)) !== 0) out[x] = board.length - row;
    seen |= fresh;
  }
  return out;
}

/** Feature vector for a board that will additionally be lifted by `lift` garbage rows. */
export function boardFeatures(board: BitBoard, lift: number): BoardFeatures {
  const h = columnHeights(board);
  let maxHeight = 0;
  let well = 0;
  for (let x = 0; x < COLS; x += 1) {
    const v = h[x] as number;
    if (v > maxHeight) maxHeight = v;
    if (v < (h[well] as number)) well = x;
  }

  // Holes, their cover and hole rows: walk down from the top keeping a mask of columns
  // that already have a block above, plus per-column count of blocks seen so far.
  let holes = 0;
  let holeCover = 0;
  let holeRows = 0;
  let rowTransitions = 0;
  let covered = 0;
  const blocksAbove = new Int32Array(COLS);
  for (let row = 0; row < board.length; row += 1) {
    const bits = board[row] as number;
    const holeBits = covered & ~bits;
    if (holeBits !== 0) {
      holeRows += 1;
      for (let x = 0; x < COLS; x += 1) {
        if ((holeBits & (1 << x)) !== 0) {
          holes += 1;
          holeCover += Math.min(blocksAbove[x] as number, 4);
        }
      }
    }
    if (bits !== 0) {
      for (let x = 0; x < COLS; x += 1)
        if ((bits & (1 << x)) !== 0) blocksAbove[x] = (blocksAbove[x] as number) + 1;
      // Transitions with walls counted as filled.
      const withWalls = (bits << 1) | 1 | (1 << (COLS + 1));
      rowTransitions += popcount((withWalls ^ (withWalls >> 1)) & ((1 << (COLS + 1)) - 1));
    }
    covered |= bits;
  }

  let bumpiness = 0;
  let bumpinessSq = 0;
  for (let x = 0; x < COLS - 1; x += 1) {
    if (x === well || x + 1 === well) continue;
    const d = Math.abs((h[x] as number) - (h[x + 1] as number));
    bumpiness += d;
    bumpinessSq += d * d;
  }
  const left = well > 0 ? (h[well - 1] as number) : board.length;
  const right = well < COLS - 1 ? (h[well + 1] as number) : board.length;
  const wellDepth = Math.min(4, Math.min(left, right) - (h[well] as number));

  let extraWells = 0;
  for (let x = 0; x < COLS; x += 1) {
    if (x === well) continue;
    const l = x > 0 ? (h[x - 1] as number) : board.length;
    const r = x < COLS - 1 ? (h[x + 1] as number) : board.length;
    if (Math.min(l, r) - (h[x] as number) >= 3) extraWells += 1;
  }

  const over = Math.max(0, maxHeight + lift - SAFE_HEIGHT);
  return {
    maxHeight: maxHeight + lift,
    danger: over * over,
    holes,
    holeCover,
    holeRows,
    bumpiness,
    bumpinessSq,
    rowTransitions,
    wellDepth,
    extraWells,
    tSlot: bestTSlot(board, h),
  };
}

function popcount(v: number): number {
  let n = v - ((v >> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >> 2) & 0x33333333);
  return (((n + (n >> 4)) & 0xf0f0f0f) * 0x1010101) >> 24;
}

function filled(board: BitBoard, x: number, row: number): boolean {
  if (x < 0 || x >= COLS || row >= board.length) return true;
  if (row < 0) return false;
  return ((board[row] as number) & (1 << x)) !== 0;
}

/**
 * Best T-spin slot on the surface: a T pointing down into column `x` whose stem row is
 * `row`. Requires the stem cell empty with both lower corners filled, the three cells of
 * the T's flat row empty, an overhang on at least one upper corner (so it is a spin, not a
 * plain drop), and the other side open from above so the T can reach it. Scores the lines
 * the spin would clear: 2 = a ready T-spin double, 1 = a single.
 */
function bestTSlot(board: BitBoard, h: Int32Array): number {
  let best = 0;
  for (let x = 1; x < COLS - 1; x += 1) {
    // The stem sits one row below the lowest of the slot's three surface columns.
    const row = board.length - (h[x] as number) - 1;
    if (row < 2 || row >= board.length) continue;
    if (filled(board, x, row)) continue;
    if (!filled(board, x - 1, row) || !filled(board, x + 1, row)) continue;
    const flat = row - 1;
    if (filled(board, x - 1, flat) || filled(board, x, flat) || filled(board, x + 1, flat))
      continue;
    const leftRoof = filled(board, x - 1, flat - 1);
    const rightRoof = filled(board, x + 1, flat - 1);
    if (leftRoof === rightRoof) continue; // need exactly one overhang: one side roofed, one open
    const openSide = leftRoof ? x + 1 : x - 1;
    if ((h[openSide] as number) > board.length - flat) continue;
    let lines = 0;
    if (((board[row] as number) | (1 << x)) === FULL_ROW) lines += 1;
    if (((board[flat] as number) | (7 << (x - 1))) === FULL_ROW) lines += 1;
    if (lines > best) best = lines;
  }
  return best;
}
