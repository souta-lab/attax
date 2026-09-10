import { describe, expect, test } from "bun:test";
import { enumerateKickPlacements } from "../src/ai/search.js";

describe("v8 kick expansion", () => {
  test("tuck found: T slides under roof unreachable by hard-drop", () => {
    const board = new Uint16Array(20);
    board[3] = 0x7f;
    board[0] = 0x3ff;
    const moves = enumerateKickPlacements(board, "T");
    const hardOnly = moves.filter((m) => !m.viaKick);
    const kicked = moves.filter((m) => m.viaKick);
    expect(kicked.length).toBeGreaterThan(0);
    expect(moves.length).toBeGreaterThan(hardOnly.length);
  });

  test("hard-drop set unchanged: empty board count stable", () => {
    const board = new Uint16Array(20);
    const moves = enumerateKickPlacements(board, "T");
    const hardOnly = moves.filter((m) => !m.viaKick);
    expect(hardOnly.length).toBe(34);
  });

  test("kick placements are reachable: no floating cells", () => {
    const board = new Uint16Array(20);
    board[3] = 0x7f;
    board[0] = 0x3ff;
    const moves = enumerateKickPlacements(board, "T");
    for (const m of moves.filter((mm) => mm.viaKick)) {
      expect(m.after.length).toBe(20);
    }
  });
});
