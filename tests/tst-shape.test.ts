import { describe, expect, test } from "bun:test";
import { enumerateKickPlacements } from "../src/ai/search.js";

describe("TST shape", () => {
  test("kick-only placements exist on uneven stack", () => {
    const board = new Uint16Array(20);
    board[0] = 0x1f;
    board[1] = 0x1f;
    board[2] = 0x0f;
    board[3] = 0x1f;
    board[4] = 0x07;
    const moves = enumerateKickPlacements(board, "T");
    const kicked = moves.filter((m) => m.viaKick);
    expect(kicked.length).toBeGreaterThan(0);
  });

  test("hard-drop set unchanged on empty board", () => {
    const board = new Uint16Array(20);
    const moves = enumerateKickPlacements(board, "T");
    expect(moves.filter((m) => !m.viaKick).length).toBe(34);
  });

  test("spin execution: T double via placed slot", () => {
    const board = new Uint16Array(20);
    board[0] = 0x3ff ^ (1 << 4);
    board[1] = 0x3ff ^ (1 << 3) ^ (1 << 4) ^ (1 << 5);
    const moves = enumerateKickPlacements(board, "T");
    const best = moves.filter((m) => m.linesCleared >= 2);
    expect(best.length).toBeGreaterThan(0);
    expect(Math.max(...moves.map((m) => m.linesCleared))).toBeGreaterThanOrEqual(2);
  });
});
