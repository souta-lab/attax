import type { Board } from "../core/board.js";
import { COLS } from "../core/board.js";
import type { PieceKind } from "../core/pieces.js";

export function v8Heights(after: Board): number[] {
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

export function v8MaxOf(h: readonly number[]): number {
  let m = 0;
  for (const v of h) if (v > m) m = v;
  return m;
}

/** Lowest column; ties break toward the nearest edge (deliberate edge well). */
export function v8WellCol(h: readonly number[]): number {
  let well = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let x = 0; x < COLS; x += 1) {
    const v = h[x] ?? 0;
    const edgeBias = x === 0 || x === COLS - 1 ? -0.5 : 0;
    if (v + edgeBias < best) {
      best = v + edgeBias;
      well = x;
    }
  }
  return well;
}

/** Rows from the floor fully filled except the well column. */
export function v8WellDepth(after: Board, well: number, cap: number): number {
  let depth = 0;
  for (let y = 0; y < after.length && depth < cap; y += 1) {
    if (((after[y] ?? 0) & (1 << well)) !== 0) break;
    let filled = true;
    for (let x = 0; x < COLS; x += 1) {
      if (x === well) continue;
      if (((after[y] ?? 0) & (1 << x)) === 0) {
        filled = false;
        break;
      }
    }
    if (!filled) break;
    depth += 1;
  }
  return Math.min(depth, cap);
}

/**
 * Sky-anchored (floating) well depth: contiguous well-shaped rows counted
 * DOWN from the stack top instead of up from the floor. A row counts when
 * the well column is empty and at least 8 of the other 9 cells are filled,
 * so partial wells on messy stacks still register. Used to gate Tetris
 * fire triggers when no deep clean floor well exists.
 */
export function v8FloatWell(after: Board, h: readonly number[], cap: number): number {
  const well = v8WellCol(h);
  const mx = v8MaxOf(h);
  let depth = 0;
  for (let y = mx - 1; y >= 0 && depth < cap; y -= 1) {
    if (((after[y] ?? 0) & (1 << well)) !== 0) break;
    let filled = 0;
    for (let x = 0; x < COLS; x += 1) {
      if (x === well) continue;
      if (((after[y] ?? 0) & (1 << x)) !== 0) filled += 1;
    }
    if (filled < 8) break;
    depth += 1;
  }
  return Math.min(depth, cap);
}

/** Unrecoverable stack: too many holes + too tall with garbage still queued. */
export function v8Hopeless(after: Board, h: readonly number[], pending: number): boolean {
  if (pending <= 0) return false;
  return v8CountHoles(after, h) >= 10 && v8MaxOf(h) >= 14;
}

export function v8MaxExWell(h: readonly number[], well: number): number {
  let m = 0;
  for (let x = 0; x < COLS; x += 1) {
    if (x === well) continue;
    const v = h[x] ?? 0;
    if (v > m) m = v;
  }
  return m;
}

export function v8BumpExWell(h: readonly number[], well: number): number {
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

export function v8CountTslots(after: Board, cap: number): number {
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

export function v8CountHoles(after: Board, h: readonly number[]): number {
  let n = 0;
  for (let x = 0; x < COLS; x += 1) {
    const top = h[x] ?? 0;
    for (let y = 0; y < top; y += 1) if (((after[y] ?? 0) & (1 << x)) === 0) n += 1;
  }
  return n;
}

export function v8Capped(after: Board, h: readonly number[]): number {
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

export function v8High(after: Board): number {
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

export type V8Emerg = 0 | 1 | 2;

export function v8Emergency(pending: number, maxH: number): V8Emerg {
  if (pending >= 9 || maxH >= 16) return 2;
  if (pending >= 4 || maxH >= 11) return 1;
  return 0;
}

export function v8HeightPressure(maxH: number): number {
  if (maxH >= 16) return (maxH - 15) * 600;
  if (maxH >= 11) return (maxH - 10) * 180;
  return 0;
}

/**
 * TALL veto redesigned: never vetoes while garbage is pending (all options
 * needed to dig), and exempts deliberate edge wells (deep + low surroundings)
 * plus clean T-slot roofs so assembly is not killed at height.
 */
export function v8Veto(after: Board, lines: number, pending: number, tspin = false): boolean {
  if (lines > 0) return false;
  const h = v8Heights(after);
  if (tspin && v8Hopeless(after, h, pending)) return true;
  if (pending > 0) return false;
  const mx = v8MaxOf(h);
  if (mx < 18) return false;
  const well = v8WellCol(h);
  if ((well === 0 || well === COLS - 1) && v8WellDepth(after, well, 6) >= 3) {
    if (v8MaxExWell(h, well) <= 15) return false;
  }
  if (mx <= 19 && v8CountTslots(after, 1) > 0 && v8CountHoles(after, h) === 0) return false;
  return true;
}

/** I-budget: burning an I on anything but a Tetris (outside emergency). */
export function v8WastedI(piece: PieceKind | undefined, lines: number, emerg: V8Emerg): number {
  if (piece !== "I") return 0;
  if (emerg === 2) return 0;
  if (lines === 4) return 0;
  if (lines > 0) return -150;
  return -25;
}

/** T-budget: burning a T on a non-T-spin clear (waived when digging for life). */
export function v8WastedT(
  piece: PieceKind | undefined,
  lines: number,
  tspin: boolean,
  emerg?: V8Emerg,
): number {
  if (piece !== "T") return 0;
  if (tspin && lines > 0) return 0;
  if (emerg === 2) return 0;
  if (lines > 0) return -180;
  return -25;
}
