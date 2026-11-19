import { expect, test } from "bun:test";
import { search as sharedSearch } from "../src/ai/bot/search.js";
import { DEFAULT_WEIGHTS } from "../src/ai/bot/weights.js";
import {
  type SearchInput as S2LabInput,
  type SearchOptions as S2LabOptions,
  toSharedInput,
} from "../tools/s2-lab/s2-input.js";

/**
 * The former lab search is the shared core under rules profile "s2": map the
 * lab-shaped input (numeric exact chain in `b2b`) onto the shared input
 * exactly as the player does, then search with profile "s2".
 */
function search(input: S2LabInput, options: S2LabOptions) {
  return sharedSearch(toSharedInput(input), { ...options, profile: "s2" });
}

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
  // Flags are in board row-index order (as projectAttax produces): the quad
  // clears board rows 36-39, so flag the bottom two cleared rows directly,
  // and for the uncleared case a row the quad does not clear (35).
  const flags = (...rows: number[]) => {
    const out = Array<number>(40).fill(0);
    for (const row of rows) out[row] = 1;
    return out;
  };
  const garbage = search({ ...input, garbageRows: flags(38, 39) }, options);
  const uncleared = search({ ...input, garbageRows: flags(35) }, options);
  expect(clean?.best.linesCleared).toBe(4);
  // Frame 14550 sits on a SIM-003 boundary: the referee's per-frame IEEE
  // accumulator yields M = 1.499999999999945, so floor(4 * M) = 5, not 6.
  // The search mirrors the accumulator, so it must agree with the referee.
  expect(clean?.best.attack).toBe(5);
  expect(garbage?.best.attack).toBe(6);
  expect(uncleared?.best.attack).toBe(5);
});

function conversionInput() {
  const board = new Uint16Array(40);
  for (let row = 36; row < 40; row++) board[row] = 0b1111111110;
  board[35] = 1 << 9; // Prevent a perfect clear.
  return {
    board,
    active: { kind: "I" as const, rotation: 0, x: 3, y: 19 },
    hold: null,
    canHold: false,
    preview: [],
    b2b: 0,
    combo: -1,
    pending: 2,
    dueThisLock: 0,
    frame: 14550,
  };
}

test("S2 conversion rewards only root attack exceeding pending garbage", () => {
  const input = conversionInput();
  const baseline = search(input, { weights: DEFAULT_WEIGHTS, width: 32 });
  const shaped = search(input, {
    weights: { ...DEFAULT_WEIGHTS, conversion: 1000 },
    width: 32,
  });
  if (!baseline || !shaped) throw new Error("Expected both searches to find a line");
  expect(shaped?.best.placement).toEqual(baseline?.best.placement);
  expect(shaped?.best.attack).toBe(5);
  expect(shaped.best.reward - baseline.best.reward).toBe(3000);
  expect(shaped.value - baseline.value).toBe(3000);

  const cancelledInput = { ...input, pending: 8 };
  const cancelled = search(cancelledInput, { weights: DEFAULT_WEIGHTS, width: 32 });
  const cancelledShaped = search(cancelledInput, {
    weights: { ...DEFAULT_WEIGHTS, conversion: 1000 },
    width: 32,
  });
  expect(cancelled).not.toBeNull();
  expect(cancelledShaped).toEqual(cancelled);
});

test("S2 conversion does not reward attacks in deeper plies", () => {
  const input = {
    ...conversionInput(),
    active: { kind: "O" as const, rotation: 0, x: 3, y: 19 },
    preview: ["I" as const],
    // Keep the quad well open for the second placement.
    acceptRoot: (placement: { x: number; rotation: number }) =>
      placement.x === 3 && placement.rotation === 0,
  };
  const baseline = search(input, { weights: DEFAULT_WEIGHTS, width: 32 });
  const shaped = search(input, {
    weights: { ...DEFAULT_WEIGHTS, conversion: 1000 },
    width: 32,
  });
  expect(baseline?.line).toHaveLength(2);
  expect(baseline?.best.attack).toBe(0);
  expect(baseline?.line[1]?.attack).toBeGreaterThan(0);
  expect(shaped).toEqual(baseline);
});
