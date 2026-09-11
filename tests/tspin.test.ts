import { describe, expect, test } from "bun:test";
import { createBoard } from "../src/core/board.js";
import { classifyTspin } from "../src/core/tspin.js";

const T_CELLS = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: 1, y: 1 },
  { x: 2, y: 1 },
] as const;

function boardWithCorners(corners: readonly number[]): Uint16Array {
  const board = createBoard(20);
  for (const x of corners) board[1] = (board[1] ?? 0) | (1 << x);
  return board;
}

describe("T-spin classification", () => {
  test("requires a nonzero SRS result", () => {
    expect(classifyTspin(boardWithCorners([0]), T_CELLS, 0, 0, 0, 0)).toBe("none");
  });

  test("classifies three corners as mini when adjacent corners differ", () => {
    expect(classifyTspin(boardWithCorners([0]), T_CELLS, 0, 0, 0, 1)).toBe("mini");
  });

  test("classifies matching adjacent corners as full", () => {
    expect(classifyTspin(boardWithCorners([0, 2]), T_CELLS, 0, 0, 0, 5)).toBe("full");
  });
});
