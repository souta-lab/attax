import { type Board, COLS } from "../core/board.js";

export interface FeatureVector {
  readonly landingHeight: number;
  readonly erodedCells: number;
  readonly rowTransitions: number;
  readonly colTransitions: number;
  readonly holes: number;
  readonly wells: number;
  readonly holeDepth: number;
  readonly rowsWithHoles: number;
  readonly bumpiness: number;
  readonly maxHeight: number;
}

export interface FireContext {
  readonly linesCleared: number;
  readonly tspin: boolean;
  readonly tspinLines: number;
  readonly b2bActive: boolean;
  readonly combo: number;
  readonly perfectClear: boolean;
}

export interface FireFeatures {
  readonly isTetris: boolean;
  readonly isTspin: boolean;
  readonly isTspinSingle: boolean;
  readonly isTspinDouble: boolean;
  readonly isTspinTriple: boolean;
  readonly b2bBonus: boolean;
  readonly comboCount: number;
  readonly isPerfectClear: boolean;
}

export function extractFeatures(
  after: Board,
  landingHeight: number,
  erodedCells: number,
): FeatureVector {
  const rows = after.length;
  const heights = new Array<number>(COLS).fill(0);
  for (let x = 0; x < COLS; x += 1) {
    for (let y = rows - 1; y >= 0; y -= 1) {
      if (((after[y] ?? 0) & (1 << x)) !== 0) {
        heights[x] = y + 1;
        break;
      }
    }
  }
  const heightsPre: readonly number[] = heights;

  let holes = 0;
  let holeDepth = 0;
  let holeRowsMask = 0;
  let colTransitions = 0;

  for (let x = 0; x < COLS; x += 1) {
    const top = heightsPre[x] ?? 0;
    let prev = 1;
    for (let y = rows - 1; y >= 0; y -= 1) {
      const row = after[y] ?? 0;
      const filled = (row & (1 << x)) !== 0;
      if (!filled && y < top) {
        holes += 1;
        holeDepth += top - y;
        holeRowsMask |= 1 << y;
      }
      const cur = filled ? 1 : 0;
      if (cur !== prev) colTransitions += 1;
      prev = cur;
    }
    if (prev === 0) colTransitions += 1;
  }

  let rowsWithHoles = 0;
  let m = holeRowsMask;
  while (m !== 0) {
    rowsWithHoles += m & 1;
    m >>>= 1;
  }

  let rowTransitions = 0;
  for (let y = 0; y < rows; y += 1) {
    const row = after[y] ?? 0;
    const d = (row | 0b1_00000_00000) ^ (1 | (row << 1));
    rowTransitions += popcount11(d);
  }

  let wells = 0;
  for (let x = 0; x < COLS; x += 1) {
    const h = heights[x] ?? 0;
    const left = x === 0 ? Number.POSITIVE_INFINITY : (heights[x - 1] ?? 0);
    const right = x === COLS - 1 ? Number.POSITIVE_INFINITY : (heights[x + 1] ?? 0);
    const wall = Math.min(left, right);
    if (wall > h) wells += wall - h;
  }

  return {
    landingHeight,
    erodedCells,
    rowTransitions,
    colTransitions,
    holes,
    wells,
    holeDepth,
    rowsWithHoles,
    bumpiness: bumpinessOf(heights),
    maxHeight: maxOf(heights),
  };
}

function bumpinessOf(heights: readonly number[]): number {
  let sum = 0;
  for (let i = 1; i < heights.length; i += 1) {
    sum += Math.abs((heights[i] ?? 0) - (heights[i - 1] ?? 0));
  }
  return sum;
}

function maxOf(heights: readonly number[]): number {
  let m = 0;
  for (const h of heights) if (h > m) m = h;
  return m;
}

export function extractFireFeatures(ctx: FireContext): FireFeatures {
  const lines = ctx.linesCleared;
  const tspin = ctx.tspin && ctx.tspinLines > 0;
  return {
    isTetris: lines === 4,
    isTspin: tspin,
    isTspinSingle: tspin && ctx.tspinLines === 1,
    isTspinDouble: tspin && ctx.tspinLines === 2,
    isTspinTriple: tspin && ctx.tspinLines === 3,
    b2bBonus: ctx.b2bActive && (lines === 4 || tspin),
    comboCount: Math.max(0, ctx.combo),
    isPerfectClear: ctx.perfectClear,
  };
}

function popcount11(v: number): number {
  let n = v & 0x7ff;
  n -= (n >> 1) & 0x555;
  n = (n & 0x333) + ((n >> 2) & 0x333);
  return ((((n + (n >> 4)) & 0xf0f) * 0x101) >> 8) & 0x7;
}
