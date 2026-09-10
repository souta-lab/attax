import type { Board } from "../core/board.js";
import { COLS } from "../core/board.js";

export type DsEmerg = 0 | 1 | 2;

export function dsHeights(after: Board): number[] {
  const h: number[] = new Array<number>(COLS).fill(0);
  for (let x = 0; x < COLS; x += 1) {
    for (let y = after.length - 1; y >= 0; y -= 1) {
      if (((after[y] ?? 0) & (1 << x)) !== 0) {
        h[x] = y + 1;
        break;
      }
    }
  }
  return h;
}

export interface DsWell {
  readonly col: number;
  readonly depth: number;
  readonly maxExWell: number;
  readonly globalMax: number;
  readonly edge: boolean;
}

export function dsWell(after: Board, h: readonly number[], cap: number): DsWell {
  let col = 0;
  let best = h[0] ?? 0;
  for (let x = 1; x < COLS; x += 1) {
    const v = h[x] ?? 0;
    if (v < best || (v === best && (x === 0 || x === COLS - 1))) {
      best = v;
      col = x;
    }
  }
  let depth = 0;
  for (let y = 0; y < after.length && depth < cap; y += 1) {
    if (((after[y] ?? 0) & (1 << col)) !== 0) break;
    let filled = true;
    for (let x = 0; x < COLS; x += 1) {
      if (x === col) continue;
      if (((after[y] ?? 0) & (1 << x)) === 0) {
        filled = false;
        break;
      }
    }
    if (!filled) break;
    depth += 1;
  }
  let maxEx = 0;
  for (let x = 0; x < COLS; x += 1) {
    if (x === col) continue;
    const v = h[x] ?? 0;
    if (v > maxEx) maxEx = v;
  }
  let global = 0;
  for (const v of h) if (v > global) global = v;
  return {
    col,
    depth: Math.min(depth, cap),
    maxExWell: maxEx,
    globalMax: global,
    edge: col === 0 || col === COLS - 1,
  };
}

export interface DsFloatWell {
  readonly col: number;
  readonly depth: number;
  readonly edge: boolean;
}

// W3: floating (sky-line-anchored) well. Unlike dsWell (floor-anchored,
// counted from y=0, stays 0 on holed stacks), this measures the deepest drop
// from the local skyline: min(neighbors) - h[col]. Fires on messy stacks.
export function dsFloatWell(h: readonly number[], cap: number): DsFloatWell {
  let col = 0;
  let best = 0;
  for (let x = 0; x < COLS; x += 1) {
    const left = x === 0 ? Number.POSITIVE_INFINITY : (h[x - 1] ?? 0);
    const right = x === COLS - 1 ? Number.POSITIVE_INFINITY : (h[x + 1] ?? 0);
    const depth = Math.max(0, Math.min(Math.min(left, right) - (h[x] ?? 0), cap));
    if (depth > best || (depth === best && depth > 0 && (x === 0 || x === COLS - 1))) {
      best = depth;
      col = x;
    }
  }
  return { col, depth: best, edge: col === 0 || col === COLS - 1 };
}

export function dsBumpExWell(h: readonly number[], well: number): number {
  let bump = 0;
  let prev = -1;
  for (let x = 0; x < COLS; x += 1) {
    if (x === well) continue;
    const v = h[x] ?? 0;
    if (prev >= 0) bump += Math.abs(v - prev);
    prev = v;
  }
  return bump;
}

export function dsCountTslots(after: Board, cap: number): number {
  let n = 0;
  const top = Math.min(after.length - 1, 14);
  for (let y = 1; y <= top; y += 1) {
    for (let x = 0; x < COLS; x += 1) {
      if (((after[y] ?? 0) & (1 << x)) !== 0) continue;
      if (((after[y - 1] ?? 0) & (1 << x)) === 0) continue;
      const l = x === 0 || ((after[y] ?? 0) & (1 << (x - 1))) !== 0;
      const r = x === COLS - 1 || ((after[y] ?? 0) & (1 << (x + 1))) !== 0;
      const u = y + 1 >= after.length || ((after[y + 1] ?? 0) & (1 << x)) !== 0;
      if ((l ? 1 : 0) + (r ? 1 : 0) + (u ? 1 : 0) >= 2) {
        n += 1;
        if (n >= cap) return n;
      }
    }
  }
  return n;
}

export function dsCountHoles(after: Board, h: readonly number[]): number {
  let n = 0;
  for (let x = 0; x < COLS; x += 1) {
    const top = h[x] ?? 0;
    for (let y = 0; y < top; y += 1) if (((after[y] ?? 0) & (1 << x)) === 0) n += 1;
  }
  return n;
}

export function dsCapped(after: Board, h: readonly number[]): number {
  let n = 0;
  for (let x = 0; x < COLS; x += 1) {
    const top = h[x] ?? 0;
    for (let y = 1; y < top && y < after.length - 1; y += 1) {
      if (((after[y] ?? 0) & (1 << x)) !== 0) continue;
      if (((after[y + 1] ?? 0) & (1 << x)) !== 0 && ((after[y - 1] ?? 0) & (1 << x)) !== 0) n += 1;
    }
  }
  return n;
}

export function dsHigh(after: Board): number {
  let n = 0;
  for (let y = 14; y < after.length; y += 1) {
    let r = after[y] ?? 0;
    while (r !== 0) {
      n += r & 1;
      r >>>= 1;
    }
  }
  return n;
}

export function dsEmergency(pending: number, maxH: number): DsEmerg {
  if (pending >= 9 || maxH >= 16) return 2;
  if (pending >= 4 || maxH >= 11) return 1;
  return 0;
}

export function dsVeto(after: Board, lines: number, pending: number, tspin = false): boolean {
  const h = dsHeights(after);
  if (tspin && lines > 0) {
    const holes = dsCountHoles(after, h);
    let global = 0;
    for (const v of h) if (v > global) global = v;
    if (holes >= 10 && global >= 14 && pending > 0) return true;
    if (holes >= 12 && global >= 15) return true;
  }
  if (lines > 0) return false;
  const well = dsWell(after, h, 6);
  const ceil = pending > 0 ? 16 : 18;
  if (well.globalMax < ceil) return false;
  if (well.edge && well.depth >= 4 && well.maxExWell <= 14) return false;
  return true;
}

export function dsHeightPressure(maxH: number): number {
  if (maxH >= 16) return (maxH - 15) * 500;
  if (maxH >= 11) return (maxH - 10) * 150;
  return 0;
}

export function dsGamma(ply: number): number {
  if (ply <= 1) return 1;
  if (ply === 2) return 0.55;
  return 0.3;
}
