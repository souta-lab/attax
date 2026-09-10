// Hoiko exact evaluator (geometry + action), ported from decompiled EvaluateAI.
// Weight slot == file line index: column->50..59, comboAtk->60..64, nexus->scale (byte264 double /100).
import type { Board } from "../core/board.js";
import { COLS } from "../core/board.js";
import type { PieceKind } from "../core/pieces.js";

export interface HoikoWeights {
  readonly w: readonly number[];
  readonly scale: number;
}

export interface HoikoCtx {
  readonly combo: number;
  readonly b2b: boolean;
  readonly piece: PieceKind;
  readonly pending: number;
  readonly ply: number;
  readonly clear: number;
  readonly tspin: boolean;
  readonly hold: PieceKind | null;
  readonly canHold: boolean;
}

function at(a: readonly number[], i: number): number {
  return a[i] ?? 0;
}

function popcount(v: number): number {
  let n = v & 0x3ff;
  n -= (n >> 1) & 0x555;
  n = (n & 0x333) + ((n >> 2) & 0x333);
  return ((((n + (n >> 4)) & 0xf0f) * 0x101) >> 8) & 0x3ff;
}

function log2(v: number): number {
  let r = 0;
  let x = v & -v;
  while ((x & 1) === 0) {
    x >>= 1;
    r += 1;
  }
  return r;
}

export function columnHeights(board: Board): number[] {
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

function maxOf(v: readonly number[]): number {
  let m = 0;
  for (const x of v) if (x > m) m = x;
  return m;
}

function minOf(v: readonly number[]): number {
  let m = 99;
  for (const x of v) if (x < m) m = x;
  return m;
}

function rowAt(board: Board, y: number): number {
  return (board[y] ?? 0) & 0x3ff;
}

/** GetHeight (exact): (maxHeight+1)*w0 + over10/over15 on center cols 3..6. */
export function getHeight(board: Board, w: readonly number[]): number {
  const h = columnHeights(board);
  const mh = maxOf(h);
  let s = (mh + 1) * at(w, 0);
  if (mh > 9) {
    const c = Math.min(10, Math.max(at(h, 3), at(h, 4), at(h, 5), at(h, 6)));
    s += at(w, 1) * (c - 9);
    if (c > 14) s += at(w, 2) * (c - 14);
  }
  return s;
}

/** GetWellColumn (exact). */
export function getWellColumn(board: Board, minH: number, w: readonly number[]): number {
  const row = rowAt(board, minH + 1);
  if (popcount(row) !== 9) return 0;
  const wc = popcount(row + 1) - 1;
  if (wc < 0) return 0;
  let depth = 1;
  for (let y = minH + 2; y < board.length; y += 1) {
    if (rowAt(board, y) === row) depth += 1;
    else break;
  }
  const mask = (1280 >> wc) & 0x3ff;
  let width = 1;
  for (let y = minH + 2; y < board.length; y += 1) {
    if ((mask & rowAt(board, y)) === mask) width += 1;
    else break;
  }
  const peak = at(w, 12);
  const depthC = depth === 2 ? 1 : Math.min(depth, peak);
  const widthC = width === 2 ? 1 : Math.min(width, peak);
  return at(w, 50 + wc) + at(w, 11) * depthC + at(w, 10) * widthC;
}

/** GetUpDown (exact). */
export function getUpDown(
  h: readonly number[],
  wellCol: number,
  wellDepth: number,
  w: readonly number[],
): number {
  const c = h.slice();
  if (wellCol >= 0) c[wellCol] = at(c, wellCol) + Math.min(wellDepth, at(w, 12));
  let d = at(c, 0) - at(c, 1);
  let s = (d >= 0 ? 1 : 2) * d * d;
  for (let x = 1; x < 8; x += 1) {
    d = at(c, x) - at(c, x + 1);
    s += d * d;
  }
  d = at(c, 8) - at(c, 9);
  s += (d <= 0 ? 1 : 2) * d * d;
  return at(w, 3) * s;
}

/** GetUnderground (exact). */
export function getUnderground(
  board: Board,
  h: readonly number[],
  minH: number,
  w: readonly number[],
): number {
  if (minH === -1) return 0;
  let cover = 0;
  let donate = 0;
  let prevEmpty = rowAt(board, minH) ^ 0x3ff;
  let bits = prevEmpty;
  while (bits !== 0) {
    const low = bits & -bits;
    cover += Math.min(5, at(h, log2(low)) - minH);
    bits &= ~low;
  }
  for (let row = minH - 1; row >= 0; row -= 1) {
    const empty = rowAt(board, row) ^ 0x3ff;
    if ((~prevEmpty & empty) !== 0) {
      const low = empty & -empty;
      if ((~low & empty) === 0) {
        donate += Math.min(5, at(h, log2(low)) - row);
      } else {
        let b = empty;
        while (b !== 0) {
          const l = b & -b;
          cover += at(h, log2(l)) - row;
          b &= ~l;
        }
      }
    }
    prevEmpty = empty;
  }
  return at(w, 4) * cover + at(w, 5) * donate;
}

/** GetGround (exact). */
export function getGround(
  board: Board,
  h: readonly number[],
  y0: number,
  w: readonly number[],
): number {
  let pierce = 0;
  let badRoof = 0;
  let roof = 0;
  let isolated = 0;
  let roofCount = 0;
  const surf = maxOf(h);
  let covered = 0;
  for (let row = surf - 1; row >= y0; row -= 1) {
    const r = rowAt(board, row);
    let bits = (r ^ 0x3ff) & covered;
    while (bits !== 0) {
      const low = bits & -bits;
      const col = log2(low);
      const depth = at(h, col) - (surf - 1);
      const hr = col < 8 ? at(h, col + 1) < surf - 1 : false;
      const hrr = col < 7 ? at(h, col + 2) < surf - 1 : false;
      const hl = col > 1 ? at(h, col - 1) < surf - 1 : false;
      const hll = col > 2 ? at(h, col - 2) < surf - 1 : false;
      if ((col < 8 && hr && hrr) || (col > 1 && hl && hll)) {
        roof += depth;
        roofCount += 1;
      } else if ((col < 8 && hr) || (col > 1 && hl)) {
        badRoof += depth;
      } else {
        isolated = Math.max(isolated, depth);
      }
      bits &= ~low;
    }
    pierce += isolated;
    covered |= r;
  }
  if (roofCount === 1) roof = 1;
  return at(w, 8) * pierce + at(w, 7) * badRoof + at(w, 6) * roof;
}

/** GetResource (exact). */
export function getResource(board: Board, minH: number, w: readonly number[]): number {
  let anabara = 0;
  let prev = rowAt(board, minH);
  for (let y = minH - 1; y >= 0; y -= 1) {
    const r = rowAt(board, y);
    if ((r | prev) !== prev) anabara += 1;
    prev = r;
  }
  let num2 = 0;
  for (let y = minH + 1; y < board.length; y += 1) {
    const pc = popcount(rowAt(board, y));
    if (num2 + pc >= at(w, 17)) {
      num2 = at(w, 17);
      break;
    }
    num2 += pc;
  }
  let num7 = 0;
  const row = rowAt(board, minH);
  if (popcount(row) === 9) {
    const wc = popcount(row + 1) - 1;
    if (wc >= 0) num7 = at(w, 50 + wc) * 0.5;
  }
  return at(w, 16) * num2 + at(w, 9) * anabara + num7;
}

/** Action/clear weights (exact from GetFinalAction/GetContBonus). */
export function actionScore(ctx: HoikoCtx, w: readonly number[]): number {
  const clear = ctx.clear;
  let s = 0;
  s += ctx.combo * at(w, 29);
  if (ctx.tspin) {
    if (clear === 1) s += at(w, 38);
    else if (clear === 2) s += at(w, 39);
    else if (clear === 3) s += at(w, 40);
  } else if (clear === 1) s += at(w, 34);
  else if (clear === 2) s += at(w, 35);
  else if (clear === 3) s += at(w, 36);
  else if (clear === 4) s += at(w, 37);
  if (clear > 0) {
    s += at(w, 45);
    s += at(w, 60 + Math.min(4, Math.max(0, ctx.combo - 1)));
    if (ctx.b2b) s += at(w, 41);
    if (ctx.b2b && ctx.combo >= 1) s += at(w, 43);
  }
  if (ctx.piece === "T" && !(ctx.tspin && clear > 0)) s += at(w, 33);
  if (ctx.piece === "I" && clear !== 4) s += at(w, 32);
  if (ctx.piece === "T") s += at(w, 31);
  if (ctx.piece === "I") s += at(w, 30);
  return s;
}

/** Geometry + resource + action (searches added separately). */
export function scoreHoikoCore(after: Board, ctx: HoikoCtx, w: HoikoWeights): number {
  const h = columnHeights(after);
  const minH = minOf(h);
  const row = rowAt(after, minH + 1);
  const wc = popcount(row) === 9 ? popcount(row + 1) - 1 : -1;
  let wellDepth = 0;
  if (wc >= 0) {
    wellDepth = 1;
    for (let y = minH + 2; y < after.length; y += 1) {
      if (rowAt(after, y) === row) wellDepth += 1;
      else break;
    }
  }
  let s = 0;
  s += getHeight(after, w.w);
  s += getWellColumn(after, minH, w.w);
  s += getUpDown(h, wc, wellDepth, w.w);
  s += getUnderground(after, h, minH, w.w);
  s += getGround(after, h, wellDepth + minH, w.w);
  s += getResource(after, minH, w.w);
  s += actionScore(ctx, w.w);
  return s;
}

/** parse weights positionally (index = line); column->50..59, comboAtk->60..64, nexus->scale. */
export function parseHoikoWeights(text: string): HoikoWeights {
  const w: number[] = new Array<number>(68).fill(0);
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  lines.forEach((line, idx) => {
    const parts = line.split(",").map((s) => Number(s.trim()));
    if (idx === 13) {
      for (let i = 0; i < 10; i += 1) w[50 + i] = parts[i + 1] ?? 0;
    } else if (idx === 44) {
      const vals = parts.slice(1).filter((v) => Number.isFinite(v));
      const base = vals[0] ?? 0;
      w[60] = base;
      for (let i = 1; i < 5; i += 1) w[60 + i] = vals[i] ?? base * (i + 1);
    } else {
      const v = parts[1];
      if (Number.isFinite(v)) w[idx] = v ?? 0;
    }
  });
  const nexus = w[46] ?? 0;
  const scale = Math.min(100, Math.max(0, nexus)) * 0.01;
  return { w, scale };
}
