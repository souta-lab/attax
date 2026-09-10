/**
 * Low-level Hoiko board-shape statistics.
 *
 * All quantities are computed from a single bitboard afterstate. Hoiko's native
 * feature names are reverse-engineered (evidence/hoiko/analysis.md); the exact
 * geometric definitions are not known, so each detector documents its
 * approximation. Signs and relative magnitudes of the weights are preserved by
 * keeping every feature non-negative (or a bounded count) so the sign of the
 * product is carried entirely by the weight.
 */

import { type Board, COLS } from "../core/board.js";

export interface HoikoBoardStats {
  /** Per-column height (highest filled row + 1). */
  readonly column: readonly number[];
  readonly maxHeight: number;
  /** Filled cells at or above row index 10 (height > 10). */
  readonly over10: number;
  /** Filled cells at or above row index 15 (height > 15). */
  readonly over15: number;
  /** Sum of squared adjacent column height differences. */
  readonly updown2: number;
  /** Covered empty cells whose roof is a single filled cell (donated cover). */
  readonly donateCover: number;
  /** Total covered empty cells (holes). */
  readonly cover: number;
  /** Filled cells with an empty cell directly below (overhang roofs). */
  readonly roof: number;
  /** Roofs whose cavity is at least two cells deep. */
  readonly badRoof: number;
  /** Empty cells with filled cells both above and below (vertical tunnels). */
  readonly pierce: number;
  /** Empty cells with both horizontal neighbours filled (scattered holes). */
  readonly anabara: number;
  /** 1 when a well of depth >= 2 exists. */
  readonly wellHint: number;
  /** Depth of the deepest well (capped at 6). */
  readonly wellDepth: number;
  /** Wall height of the deepest well (capped at 6). */
  readonly wellPeak: number;
  /** Rows on the stack when a hole-free 4-row multiple suggests a PC. */
  readonly pcStack: number;
  /** 1 when the hole-free stack is a 4-row multiple (PC chance). */
  readonly pcChance: number;
  /** 2-wide overhung pockets (T-spin double / cannon slots). */
  readonly spinDouble: number;
  /** 2-wide pockets three rows tall (T-spin triple slots). */
  readonly spinTriple: number;
  /** Spin pockets backed by a tall column (TD cannon). */
  readonly spinCannon: number;
  /** 1 when the surface is hole-free and nearly flat (connected nexus). */
  readonly nexus: number;
}

function filled(board: Board, x: number, y: number): boolean {
  if (x < 0 || x >= COLS) return true; // walls count as blocked
  if (y < 0) return true; // floor counts as blocked
  if (y >= board.length) return false;
  return ((board[y] ?? 0) & (1 << x)) !== 0;
}

function open(board: Board, x: number, y: number): boolean {
  return !filled(board, x, y);
}

/** True when coordinates are a solid wall/blocked cell (for side walls). */
function blocked(board: Board, x: number, y: number): boolean {
  if (x < 0 || x >= COLS) return true;
  return filled(board, x, y);
}

function columnHeights(board: Board): number[] {
  const h: number[] = new Array<number>(COLS).fill(0);
  for (let x = 0; x < COLS; x += 1) {
    for (let y = board.length - 1; y >= 0; y -= 1) {
      if (((board[y] ?? 0) & (1 << x)) !== 0) {
        h[x] = y + 1;
        break;
      }
    }
  }
  return h;
}

function maxOf(values: readonly number[]): number {
  let m = 0;
  for (const v of values) if (v > m) m = v;
  return m;
}

function popcount(v: number): number {
  let n = v & 0x3ff;
  n -= (n >> 1) & 0x555;
  n = (n & 0x333) + ((n >> 2) & 0x333);
  return ((((n + (n >> 4)) & 0xf0f) * 0x101) >> 8) & 0x3ff;
}

function scanHoles(
  board: Board,
  heights: readonly number[],
): {
  readonly cover: number;
  readonly donateCover: number;
  readonly roof: number;
  readonly badRoof: number;
  readonly pierce: number;
  readonly anabara: number;
  readonly over10: number;
  readonly over15: number;
} {
  let cover = 0;
  let donateCover = 0;
  let roof = 0;
  let badRoof = 0;
  let pierce = 0;
  let anabara = 0;
  let over10 = 0;
  let over15 = 0;
  // Top-down per column: `filledAbove` counts filled cells strictly above the
  // cursor, so every hole is classified in a single pass (no nested above-scan).
  for (let x = 0; x < COLS; x += 1) {
    const top = heights[x] ?? 0;
    let filledAbove = 0;
    for (let y = board.length - 1; y >= 0; y -= 1) {
      if (filled(board, x, y)) {
        filledAbove += 1;
        continue;
      }
      if (y >= top) continue;
      cover += 1;
      if (filledAbove === 1) donateCover += 1;
      if (blocked(board, x - 1, y) && blocked(board, x + 1, y)) anabara += 1;
      if (filled(board, x, y - 1) && filled(board, x, y + 1)) pierce += 1;
    }
  }
  // Row-wise bit ops for over-height cells and roofs.
  for (let y = 0; y < board.length; y += 1) {
    const row = (board[y] ?? 0) & 0x3ff;
    if (y >= 10) over10 += popcount(row);
    if (y >= 15) over15 += popcount(row);
    if (y === 0 || row === 0) continue;
    const below = board[y - 1] ?? 0;
    const roofBits = row & ~below & 0x3ff;
    if (roofBits === 0) continue;
    roof += popcount(roofBits);
    if (y >= 2) {
      const below2 = board[y - 2] ?? 0;
      badRoof += popcount(roofBits & ~below2 & 0x3ff);
    }
  }
  return { cover, donateCover, roof, badRoof, pierce, anabara, over10, over15 };
}

function scanWells(heights: readonly number[]): {
  readonly wellHint: number;
  readonly wellDepth: number;
  readonly wellPeak: number;
} {
  let wellHint = 0;
  let wellDepth = 0;
  let wellPeak = 0;
  for (let x = 0; x < COLS; x += 1) {
    const left = x === 0 ? 20 : (heights[x - 1] ?? 0);
    const right = x === COLS - 1 ? 20 : (heights[x + 1] ?? 0);
    const wall = Math.min(left, right);
    const depth = wall - (heights[x] ?? 0);
    if (depth >= 2) wellHint = 1;
    if (depth > wellDepth) {
      wellDepth = depth;
      wellPeak = wall;
    }
  }
  return { wellHint, wellDepth: Math.min(6, wellDepth), wellPeak: Math.min(6, wellPeak) };
}

/**
 * Approximate Hoiko spin-slot detection. A double slot is a 2-wide, 2-tall
 * empty pocket walled on both sides with a partial lid above (the overhang a T
 * spins under). A triple slot adds a third open row with another lid. A cannon
 * requires a tall back column beside the pocket. Counts are capped at one
 * because the weights are per-shape indicators.
 */
function scanPockets(board: Board): {
  readonly spinDouble: number;
  readonly spinTriple: number;
  readonly spinCannon: number;
} {
  let spinDouble = 0;
  let spinTriple = 0;
  let spinCannon = 0;
  for (let y = 0; y + 2 < board.length; y += 1) {
    for (let x = 0; x + 1 < COLS; x += 1) {
      if (!(open(board, x, y) && open(board, x + 1, y))) continue;
      if (!(open(board, x, y + 1) && open(board, x + 1, y + 1))) continue;
      if (!blocked(board, x - 1, y) || !blocked(board, x + 2, y)) continue;
      if (!blocked(board, x - 1, y + 1) || !blocked(board, x + 2, y + 1)) continue;
      const lidLeft = blocked(board, x, y + 2);
      const lidRight = blocked(board, x + 1, y + 2);
      if (!lidLeft && !lidRight) continue; // open top is a plain well, not a slot
      spinDouble = 1;
      if (open(board, x, y + 2) && open(board, x + 1, y + 2)) {
        if (blocked(board, x, y + 3) || blocked(board, x + 1, y + 3)) spinTriple = 1;
      }
      if (blocked(board, x - 1, y + 3) || blocked(board, x + 2, y + 3)) spinCannon = 1;
    }
  }
  return { spinDouble, spinTriple, spinCannon };
}

function countStackRows(board: Board): number {
  let rows = 0;
  for (let y = 0; y < board.length; y += 1) if ((board[y] ?? 0) !== 0) rows += 1;
  return rows;
}

/** Compute every board-geometry feature Hoiko weights score. */
export function scanHoikoBoard(after: Board): HoikoBoardStats {
  const column = columnHeights(after);
  const holes = scanHoles(after, column);
  const wells = scanWells(column);
  const pockets = scanPockets(after);
  let updown2 = 0;
  for (let x = 1; x < COLS; x += 1) {
    const d = (column[x] ?? 0) - (column[x - 1] ?? 0);
    updown2 += d * d;
  }
  const maxHeight = maxOf(column);
  const stackRows = countStackRows(after);
  const pcReady = holes.cover === 0 && stackRows > 0 && stackRows % 4 === 0;
  let bumpiness = 0;
  for (let x = 1; x < COLS; x += 1) {
    bumpiness += Math.abs((column[x] ?? 0) - (column[x - 1] ?? 0));
  }
  const nexus = holes.cover === 0 && maxHeight > 0 && bumpiness <= 4 ? 1 : 0;
  return {
    column,
    maxHeight,
    over10: holes.over10,
    over15: holes.over15,
    updown2,
    donateCover: holes.donateCover,
    cover: holes.cover,
    roof: holes.roof,
    badRoof: holes.badRoof,
    pierce: holes.pierce,
    anabara: holes.anabara,
    wellHint: wells.wellHint,
    wellDepth: wells.wellDepth,
    wellPeak: wells.wellPeak,
    pcStack: pcReady ? stackRows : 0,
    pcChance: pcReady ? 1 : 0,
    spinDouble: pockets.spinDouble,
    spinTriple: pockets.spinTriple,
    spinCannon: pockets.spinCannon,
    nexus,
  };
}
