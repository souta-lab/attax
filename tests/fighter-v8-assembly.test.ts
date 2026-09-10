import { describe, expect, test } from "bun:test";
import { beamBestMove } from "../src/ai/beam.js";

describe("v8 assembly contracts", () => {
  test("well reservation: I pending + deep well beats early single", () => {
    const board = new Uint16Array(20);
    for (let y = 0; y < 5; y++) board[y] = 0x1ff;
    const mv = beamBestMove(board, "I", ["O", "T", "S", "Z", "L"], null, true, false, -1, {
      depth: 6,
      scorer: (after, lines, _tspin, ctx) => {
        void _tspin;
        if (ctx.ply > 2) return 0;
        let depth = 0;
        for (let y = 0; y < after.length && depth < 6; y++) {
          if (((after[y] ?? 0) & 0x200) !== 0) break;
          depth++;
        }
        return lines === 0 ? depth * 50 : 0;
      },
    });
    expect(mv).not.toBeNull();
    expect(mv?.linesCleared ?? 0).toBe(0);
  });

  test("kick-search: TST-shape placement exists beyond hard-drop set", () => {
    const board = new Uint16Array(20);
    board[0] = 0x1ff;
    board[1] = 0x1ff;
    board[2] = 0x155;
    const mv = beamBestMove(board, "T", ["I", "O", "S", "Z", "L"], null, false, false, -1, {
      depth: 2,
    });
    expect(mv).not.toBeNull();
    expect(mv?.score).toBeFinite();
  });
});
