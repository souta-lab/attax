import { expect, test } from "bun:test";
import { boardFeatures } from "../src/ai/bot/features.js";
import { generatePlacements, lockPlacement, spawnPosition } from "../src/ai/bot/movegen.js";

test("extended external board preserves low-stack geometry and clear outcomes", () => {
  const low = new Uint16Array(20);
  low[19] = 0b1111111100;
  low[18] = 0b1111111100;
  const full = new Uint16Array(40);
  full.set(low, 20);
  expect(boardFeatures(full, 0)).toEqual(boardFeatures(low, 0));
  const a = generatePlacements(low, "O");
  const b = generatePlacements(full, "O");
  const keys = (placements: typeof a, offset: number) =>
    placements.map((p) => `${p.rotation},${p.x},${p.y - offset},${p.tspin}`).sort();
  expect(keys(b, 20)).toEqual(keys(a, 0));
  for (const p of a) {
    const x = lockPlacement(low, p);
    const y = lockPlacement(full, { ...p, y: p.y + 20 });
    expect(y.linesCleared).toBe(x.linesCleared);
    expect(y.perfectClear).toBe(x.perfectClear);
    expect([...y.board.slice(20)]).toEqual([...x.board]);
  }
});

test("external spawn retries higher and keeps cells above the visible field", () => {
  const full = new Uint16Array(40);
  full[20] = 1 << 4;
  expect(spawnPosition("O", 40).y).toBe(19);
  expect(generatePlacements(full, "O").length).toBeGreaterThan(0);
  full[18] = 1;
  expect(boardFeatures(full, 0).maxHeight).toBe(22);
  const p = generatePlacements(full, "I")[0];
  expect(p).toBeDefined();
  if (!p) throw new Error("no move");
  expect(lockPlacement(full, p).board[18]).toBeGreaterThan(0);
});

test("external profile does not invent combo or perfect-clear attack", async () => {
  const { search } = await import("../src/ai/bot/search.js");
  const { DEFAULT_WEIGHTS } = await import("../src/ai/bot/weights.js");
  const board = new Uint16Array(20);
  board[19] = 0b1111111100;
  board[18] = 0b1111111100;
  const input = {
    board,
    active: { kind: "O" as const, rotation: 0, x: 3, y: 0 },
    hold: null,
    canHold: false,
    preview: [],
    b2b: false,
    combo: 5,
    pending: 0,
  };
  const normal = search(input, { weights: DEFAULT_WEIGHTS, width: 32 });
  const guideline = search(input, { weights: DEFAULT_WEIGHTS, width: 32, guideline: true });
  expect(normal?.best.attack).toBe(14);
  expect(guideline?.best.attack).toBe(1);
});
