import { describe, expect, test } from "bun:test";
import { createBoard } from "../src/core/board.js";
import { classifyTspin } from "../src/core/tspin.js";

const PX = 3;
const NY = 6;

// Corners of the T's 3x3 box on the bottom-up board: [TL, TR, BR, BL] (NY is the top row).
const CORNERS = [
  { x: PX, y: NY },
  { x: PX + 2, y: NY },
  { x: PX + 2, y: NY - 2 },
  { x: PX, y: NY - 2 },
] as const;

const T_CELLS = [{ x: 1, y: 0 }] as const;

function boardWithCorners(indices: readonly number[]): Uint16Array {
  const board = createBoard(20);
  for (const index of indices) {
    const corner = CORNERS[index];
    if (corner === undefined) continue;
    board[corner.y] = (board[corner.y] ?? 0) | (1 << corner.x);
  }
  return board;
}

function classify(indices: readonly number[], rotation: number, lastSrs: number) {
  return classifyTspin(boardWithCorners(indices), T_CELLS, PX, NY, rotation, lastSrs);
}

describe("T-spin classification", () => {
  test("requires a nonzero SRS result", () => {
    expect(classify([0, 2, 3], 0, 0)).toBe("none");
  });

  test("none when fewer than three corners are occupied", () => {
    expect(classify([0, 2], 0, 1)).toBe("none");
  });

  test("full when both front corners are filled facing up (rot0: TL, TR)", () => {
    expect(classify([0, 1, 2], 0, 1)).toBe("full");
  });

  test("full when both front corners are filled facing down (rot2: BR, BL) — a real TSD", () => {
    expect(classify([0, 2, 3], 2, 1)).toBe("full");
  });

  test("full for matching front corners on rot1 and rot3", () => {
    expect(classify([0, 1, 2], 1, 1)).toBe("full");
    expect(classify([0, 2, 3], 3, 1)).toBe("full");
  });

  test("mini when front corners differ while facing up (rot0)", () => {
    expect(classify([0, 2, 3], 0, 1)).toBe("mini");
  });

  test("mini when front corners differ while facing down (rot2)", () => {
    expect(classify([0, 1, 2], 2, 1)).toBe("mini");
  });

  test("mini when front corners differ on rot1 and rot3", () => {
    expect(classify([0, 2, 3], 1, 1)).toBe("mini");
    expect(classify([0, 1, 2], 3, 1)).toBe("mini");
  });

  test("the last SRS kick promotes a differing front pair to full (TST)", () => {
    expect(classify([0, 2, 3], 0, 5)).toBe("full");
    expect(classify([0, 1, 2], 2, 5)).toBe("full");
  });
});
