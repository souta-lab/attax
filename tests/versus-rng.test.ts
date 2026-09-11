import { describe, expect, test } from "bun:test";
import { seededRandom } from "../src/versus/controller.js";

describe("versus seeded RNG", () => {
  test("is deterministic for a fixed seed", () => {
    const a = seededRandom(12345);
    const b = seededRandom(12345);

    const seqA = Array.from({ length: 32 }, () => a());
    const seqB = Array.from({ length: 32 }, () => b());

    expect(seqA).toEqual(seqB);
  });

  test("stays in [0,1) and is non-degenerate", () => {
    const rng = seededRandom(987654321);
    const seq = Array.from({ length: 200 }, () => rng());

    for (const value of seq) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(new Set(seq).size).toBeGreaterThan(50);
  });

  test("matches the 32-bit LCG without float precision loss", () => {
    const rng = seededRandom(12345);

    expect(rng()).toBe(0.6551540484651923);
    expect(rng()).toBe(0.30481432331725955);
    expect(rng()).toBe(0.6749606337398291);
  });
});
