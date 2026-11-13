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
