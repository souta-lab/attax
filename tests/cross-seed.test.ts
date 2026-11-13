/** Cross-seed gate must count paired seats as one independent observation. */
import { describe, expect, test } from "bun:test";
import { summarizeSeedPairs } from "../scripts/cross-seed.js";
import type { Oriented } from "../src/bench/summary.js";

function match(
  seed: number,
  aSide: "left" | "right",
  winner: "left" | "right" | "draw" | "cap",
): Oriented {
  return { seed, aSide, record: { winner } as Oriented["record"] };
}

describe("independent seed-pair validation", () => {
  test("counts two seat-swapped wins as one success", () => {
    const summary = summarizeSeedPairs([
      match(1, "left", "left"),
      match(1, "right", "right"),
      match(2, "left", "right"),
      match(2, "right", "left"),
    ]);
    expect(summary.seeds).toBe(2);
    expect(summary.wonBothSeats).toBe(1);
    expect(summary.failedSeeds).toBe(1);
    expect(summary.rate).toBe(0.5);
    expect(summary.failures.map((x) => x.seed)).toEqual([2]);
  });

  test("marks a seed failed when only one seat wins", () => {
    const summary = summarizeSeedPairs([
      match(7, "left", "left"),
      match(7, "right", "left"),
    ]);
    expect(summary.failedSeeds).toBe(1);
    expect(summary.seatDisagreements).toBe(1);
  });

  test("rejects duplicate and missing seat results", () => {
    const duplicates = [match(8, "left", "left"), match(8, "left", "left")];
    expect(() => summarizeSeedPairs(duplicates)).toThrow("duplicate");
    expect(() => summarizeSeedPairs([match(8, "left", "left")])).toThrow("missing seat");
  });
});
