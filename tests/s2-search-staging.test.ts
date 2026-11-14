import { expect, test } from "bun:test";
import { DEFAULT_WEIGHTS } from "../src/ai/bot/weights.js";
import { search } from "../tools/s2-lab/search.js";

test("S2 search prices root-frame margin and bottom-first garbage flags", () => {
  const board = new Uint16Array(40);
  for (let row = 36; row < 40; row++) board[row] = 0b1111111110;
  // Prevent PC so that only the quad attack and special bonus are measured.
  board[35] = 1 << 9;
  const input = {
    board,
    active: { kind: "I" as const, rotation: 0, x: 3, y: 19 },
    hold: null,
    canHold: false,
    preview: [],
    b2b: 0,
    combo: -1,
    pending: 0,
    dueThisLock: 0,
    frame: 14550, // M = 1.5
  };
  const options = { weights: DEFAULT_WEIGHTS, width: 32 };
  const clean = search(input, options);
  const garbage = search({ ...input, garbageRows: [1, 1] }, options);
  const uncleared = search({ ...input, garbageRows: [0, 0, 0, 0, 1] }, options);
  expect(clean?.best.linesCleared).toBe(4);
  expect(clean?.best.attack).toBe(6);
  expect(garbage?.best.attack).toBe(7);
  expect(uncleared?.best.attack).toBe(6);
});
