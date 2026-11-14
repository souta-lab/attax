import { describe, expect, test } from "bun:test";
import { DEFAULT_WEIGHTS } from "../../src/ai/bot/weights.js";
import { cellKey, type PublicDecision, placementCells, projectAttax } from "./attax-player.js";
import { search } from "./search.js";

function decision(b2b = 0, combo = 0): PublicDecision {
  return {
    board: { width: 10, height: 40, cells: "_".repeat(400) },
    pieces: { current: "I", known: ["O", "T"], hold: "S", holdAvailable: false },
    chain: { b2b, combo },
    incoming: { pendingRows: 20, dueThisLockRows: 8 },
  };
}

describe("stage-2 public state conversion", () => {
  test("reverses board rows without changing columns, retains the buffer", () => {
    const d = decision();
    const cells = [...d.board.cells];
    cells[2] = "G";
    cells[399] = "T";
    d.board.cells = cells.join("");
    const input = projectAttax(d);
    expect(input.board[39]).toBe(1 << 2);
    expect(input.board[0]).toBe(1 << 9);
    expect(input.board.length).toBe(40);
    expect(input.canHold).toBe(false);
    expect(input.hold).toBe("S");
    expect(input.preview).toEqual(["O", "T"]);
    expect(input.pending).toBe(20);
    expect(input.dueThisLock).toBe(8);
    expect(input.speculativePieces).toEqual([]);
  });
  test("preserves every B2B charge state and converts combo exactly", () => {
    for (const b2b of [0, 1, 4, 5, 100]) {
      for (const combo of [0, 1, 2, 20]) {
        const input = projectAttax(decision(b2b, combo));
        expect(input.b2b).toBe(b2b);
        expect(input.combo).toBe(combo - 1);
      }
    }
  });
  test("rejects a hidden queue tail and invalid counters", () => {
    const d = decision();
    d.pieces.known = Array(14).fill("I");
    expect(() => projectAttax(d)).toThrow("public queue");
    d.pieces.known = ["O"];
    d.chain.combo = -1;
    expect(() => projectAttax(d)).toThrow("counters");
  });
  test("rejects all roots when no independent referee witness exists", () => {
    const input = projectAttax(decision());
    expect(
      search({ ...input, acceptRoot: () => false }, { width: 48, weights: DEFAULT_WEIGHTS }),
    ).toBeNull();
  });
  test("maps core piece cells to bottom-origin canonical cells", () => {
    expect(cellKey(placementCells({ kind: "I", rotation: 0, x: 0, y: 38 }))).toBe(
      "0,0;1,0;2,0;3,0",
    );
  });
  test("search awards an S2 Quad with the exact active chain", () => {
    const input = {
      ...projectAttax(decision(5, 0)),
      hold: null,
      preview: [],
      pending: 0,
      dueThisLock: 0,
    };
    // Four rows with a one-column well; an I fills the well for a PC.
    for (let y = 36; y < 40; y++) input.board[y] = 0x3fe;
    const found = search(input, { width: 48, weights: DEFAULT_WEIGHTS });
    expect(found?.best.linesCleared).toBe(4);
    expect(found?.best.attack).toBe(10); // continued Quad 5 + separate PC 5
  });
});
