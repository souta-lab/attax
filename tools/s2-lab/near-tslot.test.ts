/**
 * W8 near-T-slot detector (features.ts nearTSlot, mirror of the GPU
 * kernel's near_tslot32). Boards are built from (x, y) cells with y
 * measured up from the floor, on a 20-row board.
 *
 * The slot under test is centred at x=4 with stem height 2. The outer
 * columns are walled off (solid to y4) so no neighbouring centre can
 * accidentally form a second candidate: every assertion below is about
 * the x=4 candidate alone.
 */
import { describe, expect, test } from "bun:test";

import type { BitBoard } from "./board.js";
import { nearTSlot } from "./features.js";

type Cell = readonly [number, number];

function boardWith(cells: readonly Cell[]): BitBoard {
  const board = new Uint16Array(20);
  for (const [x, y] of cells) {
    board[board.length - 1 - y] = (board[board.length - 1 - y] as number) | (1 << x);
  }
  return board;
}

const WALLS: Cell[] = [0, 1, 2, 6, 7, 8, 9].flatMap((x) =>
  [0, 1, 2, 3, 4].map((y) => [x, y] as Cell),
);

/** Complete T-slot centred at x=4 with stem height 2, roof on the left. */
const COMPLETE: readonly Cell[] = [
  ...WALLS,
  [3, 0],
  [3, 1],
  [3, 2], // left lower corner (stem row)
  [3, 4], // left roof (overhang), right side open
  [4, 0],
  [4, 1], // centre column, height 2
  [5, 0],
  [5, 1],
  [5, 2], // right lower corner
];

const without = (cells: readonly Cell[], ...drop: Cell[]): Cell[] =>
  cells.filter(([x, y]) => !drop.some(([dx, dy]) => dx === x && dy === y));

describe("nearTSlot (W8 setup value)", () => {
  test("empty board has no near slot", () => {
    expect(nearTSlot(boardWith([]))).toBe(0);
  });

  test("a complete slot is not near (0 defects)", () => {
    expect(nearTSlot(boardWith(COMPLETE))).toBe(0);
  });

  test("one missing lower corner is near", () => {
    expect(nearTSlot(boardWith(without(COMPLETE, [5, 2])))).toBe(1);
  });

  test("a missing overhang (no roof on either side) is near", () => {
    expect(nearTSlot(boardWith(without(COMPLETE, [3, 4])))).toBe(1);
  });

  test("two missing corners are not near (2 defects)", () => {
    expect(nearTSlot(boardWith(without(COMPLETE, [3, 2], [5, 2])))).toBe(0);
  });

  test("a filled flat-row cell disqualifies the candidate", () => {
    const cells: Cell[] = [...without(COMPLETE, [5, 2]), [3, 3]];
    expect(nearTSlot(boardWith(cells))).toBe(0);
  });

  test("both roofs present disqualifies the candidate (no open side)", () => {
    const cells: Cell[] = [...without(COMPLETE, [5, 2]), [5, 4]];
    expect(nearTSlot(boardWith(cells))).toBe(0);
  });
});
