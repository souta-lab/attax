/**
 * Versus opponent-aware EvaluateAI inputs (`PPT2AI.ObserveOpponent`, IL 3161-
 * 3195): the shipping binary feeds four statics to the search each turn. Shared
 * by the browser/harness adapter and the exe oracle differential so both engines
 * receive byte-identical values.
 */

import type { BoardView } from "../../core/types.js";

/** Top-down `BoardView` -> Hoiko native bottom-up rows, column c = bit (9-c). */
export function boardToNativeRows(board: BoardView): number[] {
  const rows: number[] = [];
  for (let y = 0; y < board.rows; y += 1) {
    const src = board.grid[board.rows - 1 - y];
    let bits = 0;
    for (let x = 0; x < board.cols; x += 1) {
      if ((src?.[x] ?? 0) !== 0) bits |= 1 << (board.cols - 1 - x);
    }
    rows.push(bits);
  }
  return rows;
}

/** `Board.UpdateMaxHeight` — highest non-empty native row, -1 when empty. */
export function nativeStackHeight(rows: readonly number[]): number {
  for (let y = rows.length - 1; y >= 0; y -= 1) {
    if ((rows[y] ?? 0) !== 0) return y;
  }
  return -1;
}

/** `Board.PopCount` — set bits over the live rows only. */
export function nativePopCount(rows: readonly number[], stackHeight: number): number {
  let total = 0;
  for (let y = 0; y <= stackHeight; y += 1) {
    let bits = rows[y] ?? 0;
    while (bits !== 0) {
      bits &= bits - 1;
      total += 1;
    }
  }
  return total;
}

/**
 * `EvaluateAI.OpponentIsPCBoard(Board*)` (IL 13690): a stack below 10 rows whose
 * popcount is even.
 */
export function opponentIsPCBoard(rows: readonly number[]): boolean {
  const stackHeight = nativeStackHeight(rows);
  if (stackHeight + 1 >= 10) return false;
  return nativePopCount(rows, stackHeight) % 2 === 0;
}

/**
 * `EvaluateAI.OpponentIsPowerfulBoard(Board*, combo, garbage)` (IL 13710).
 * `garbage` is the AI's own incoming garbage (`GetComingGarbage(self)`).
 */
export function opponentIsPowerfulBoard(
  rows: readonly number[],
  combo: number,
  garbage: number,
): boolean {
  if (combo >= 5) return true;
  if (garbage >= 6) return true;
  const stackHeight = nativeStackHeight(rows);
  const pop = nativePopCount(rows, stackHeight);
  let same = 0;
  let bara = 0;
  let well = 0;
  let prev = rows[0] ?? 0;
  for (let y = 1; y <= stackHeight; y += 1) {
    const row = rows[y] ?? 0;
    if ((row | prev) !== prev) {
      bara += 1;
      well += same >= 4 ? same : 0;
      same = 0;
    } else if (prev === row) {
      same += 1;
    }
    prev = row;
  }
  well += same >= 4 ? same : 0;
  if (pop % 2 === 0) {
    if (stackHeight + 1 >= 10 && bara >= 4 && well <= 6) return false;
  } else if (well <= 6) {
    return false;
  }
  return true;
}
