// Moved verbatim from src/ai/bot/features.ts in Phase C (2026-11-19): the TS search was
// removed and the GPU driver is the only engine left; the shapes and constants it
// needs live here now. Only import paths were adjusted.
/**
 * Board features for the bot's evaluation — each one a plain, explainable number.
 *
 * Shape features (Dellacherie / Cold-Clear family) are computed on the board after a
 * placement and its line clears. The bot's score is a weighted sum (see `weights.ts`);
 * nothing here knows about weights.
 */
import { type BitBoard, COLS, FULL_ROW } from "./board.js";

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

/** Cell at column x and height y (0 is the floor); below-floor cells are filled. */
function cellUp(board: BitBoard, x: number, y: number): boolean {
  if (y < 0) return true;
  if (y >= board.length) return false;
  return ((board[board.length - 1 - y] as number) & (1 << x)) !== 0;
}

function columnBits(board: BitBoard, x: number, y: number, n: number): number {
  let bits = 0;
  for (let i = 0; i < n; i += 1) if (cellUp(board, x, y + i)) bits |= 1 << i;
  return bits;
}

const DONATION_CELLS = {
  down: [
    [-1, 0],
    [0, 0],
    [1, 0],
    [0, -1],
  ],
  left: [
    [0, -1],
    [0, 0],
    [0, 1],
    [-1, 0],
  ],
  right: [
    [0, -1],
    [0, 0],
    [0, 1],
    [1, 0],
  ],
} as const;
type DonationSlot = { x: number; y: number; shape: keyof typeof DONATION_CELLS };

function findDonationSlot(board: BitBoard, h: Int32Array): DonationSlot | null {
  for (let x = 0; x < COLS - 2; x += 1) {
    const h0 = h[x] as number,
      h1 = h[x + 1] as number,
      h2 = h[x + 2] as number;
    if (h0 > h1 && h0 + 1 < h2) {
      const y = h0 - 1;
      if (
        columnBits(board, x, y, 3) === 1 &&
        columnBits(board, x + 1, y, 3) === 0 &&
        columnBits(board, x + 2, y, 3) === 5
      )
        return { x: x + 1, y: h0, shape: "down" };
    }
    if (h2 > h1 && h2 + 1 < h0) {
      const y = h2 - 1;
      if (
        columnBits(board, x, y, 3) === 5 &&
        columnBits(board, x + 1, y, 3) === 0 &&
        columnBits(board, x + 2, y, 3) === 1
      )
        return { x: x + 1, y: h2, shape: "down" };
    }
    if (h1 >= h0 && h1 + 1 < h2) {
      const y = h1 - 3;
      if (
        (columnBits(board, x, y, 5) & 24) === 0 &&
        (columnBits(board, x + 1, y, 5) & 30) === 4 &&
        columnBits(board, x + 2, y, 5) === 16 &&
        (cellUp(board, x + 1, y) || cellUp(board, x + 2, y - 1))
      )
        return { x: x + 2, y: h1 - 2, shape: "left" };
    }
    if (h1 >= h2 && h1 + 1 < h0) {
      const y = h1 - 3;
      if (
        columnBits(board, x, y, 5) === 16 &&
        (columnBits(board, x + 1, y, 5) & 30) === 4 &&
        (columnBits(board, x + 2, y, 5) & 24) === 0 &&
        (cellUp(board, x + 1, y) || cellUp(board, x, y - 1))
      )
        return { x, y: h1 - 2, shape: "right" };
    }
  }
  return null;
}

/** C2 T-spin donation counts indexed by lines cleared; scans a private board copy. */
export function tSlotDonations(board: BitBoard, depth: number): [number, number, number, number] {
  const counts: [number, number, number, number] = [0, 0, 0, 0];
  let current = board;
  for (let i = 0; i < depth; i += 1) {
    const slot = findDonationSlot(current, columnHeights(current, new Int32Array(COLS)));
    if (slot === null) break;
    const next = current.slice(),
      len = next.length;
    for (const [dx, dy] of DONATION_CELLS[slot.shape]) {
      const y = slot.y + dy;
      if (y >= 0 && y < len)
        next[len - 1 - y] = (next[len - 1 - y] as number) | (1 << (slot.x + dx));
    }
    let write = len - 1,
      cleared = 0;
    for (let read = len - 1; read >= 0; read -= 1) {
      const row = next[read] as number;
      if (row === FULL_ROW) {
        cleared += 1;
        continue;
      }
      next[write--] = row;
    }
    for (; write >= 0; write -= 1) next[write] = 0;
    counts[cleared] = (counts[cleared] as number) + 1;
    if (cleared < 2) break;
    current = next;
  }
  return counts;
}

/**
 * W8 setup value (2026-11-25): TS mirror of the GPU kernel's near_tslot32
 * (persistent/pfl_r15_serve.comp, generated by gen_r15_serve.py step 6b).
 * Returns 1 when the board holds a T-slot shape exactly ONE added cell away
 * from a complete bestTSlot slot, else 0. Defects are counted against the
 * complete-slot conditions at the same centre column and stem height: a
 * missing lower corner cell counts 1, and the missing overhang (neither
 * roof cell present two rows above the stem) counts 1. Anything an added
 * cell cannot fix disqualifies the candidate: a filled flat-row cell
 * (those are the T's own cells), both roofs present (no open side), or a
 * blocked open side. A complete slot has 0 defects and is not near.
 * Deliberately NOT part of BOARD_FEATURES: the board-feature vector and
 * its weights are the config-O shape the GPU codec/gate verify; the W8
 * credit lives in the kernel's leaf value, gated by tables slot 172.
 */
export function nearTSlot(board: BitBoard): number {
  const h = columnHeights(board, new Int32Array(COLS));
  for (let x = 1; x < COLS - 1; x += 1) {
    const hx = h[x] as number;
    if (hx > board.length - 3) continue;
    let defects = 0;
    if (!cellUp(board, x - 1, hx)) defects += 1;
    if (!cellUp(board, x + 1, hx)) defects += 1;
    const f = hx + 1;
    if (cellUp(board, x - 1, f) || cellUp(board, x, f) || cellUp(board, x + 1, f)) continue;
    const leftRoof = cellUp(board, x - 1, hx + 2);
    const rightRoof = cellUp(board, x + 1, hx + 2);
    if (leftRoof && rightRoof) continue;
    if (!leftRoof && !rightRoof) defects += 1;
    else {
      const openSide = leftRoof ? x + 1 : x - 1;
      if ((h[openSide] as number) > hx + 2) continue;
    }
    if (defects === 1) return 1;
  }
  return 0;
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
