import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_WEIGHTS } from "../../src/ai/bot/weights.js";
import { createAttaxDecider } from "./attax-player.js";
import { isLoadedBand, isLoadedMidBand } from "./loaded-potential.js";
import { type SearchInput, search } from "./search.js";

/** Bottom four rows filled except column 0, plus a cap cell against PC. */
function wellBoard(): Uint16Array {
  const board = new Uint16Array(40);
  for (let row = 36; row < 40; row++) board[row] = 0b1111111110;
  board[35] = 1 << 9;
  return board;
}

describe("SB-3 loaded-potential-mid band", () => {
  test("band is root locks >= 40 only", () => {
    expect(isLoadedMidBand(40)).toBe(true);
    expect(isLoadedMidBand(41)).toBe(true);
    expect(isLoadedMidBand(200)).toBe(true);
    expect(isLoadedMidBand(39)).toBe(false);
    expect(isLoadedMidBand(0)).toBe(false);
    expect(isLoadedMidBand(undefined)).toBe(false);
  });

  test("locks 20-39 are priced by neither mechanism B nor SB-3", () => {
    for (const lock of [20, 29, 39]) {
      expect(isLoadedBand(lock)).toBe(false);
      expect(isLoadedMidBand(lock)).toBe(false);
    }
    // And the bands are disjoint at their edges.
    expect(isLoadedBand(19)).toBe(true);
    expect(isLoadedMidBand(19)).toBe(false);
    expect(isLoadedBand(40)).toBe(false);
    expect(isLoadedMidBand(40)).toBe(true);
  });
});

/** One forced root: the O must sit on the right edge, keeping the well. */
function forcedRootInput(lockIndex?: number): SearchInput {
  return {
    board: wellBoard(),
    active: { kind: "O", rotation: 0, x: 3, y: 19 },
    hold: null,
    canHold: false,
    preview: ["I"],
    b2b: 1,
    combo: -1,
    pending: 0,
    dueThisLock: 0,
    ...(lockIndex !== undefined ? { lockIndex } : {}),
    acceptRoot: (placement) => placement.x === 7,
  };
}

describe("SB-3 pricing in the S2 search", () => {
  test("default weight 0 is identical to the default profile in the mid band", () => {
    const input = forcedRootInput(50);
    const baseline = search(input, { weights: DEFAULT_WEIGHTS, width: 32 });
    const zero = search(input, {
      weights: { ...DEFAULT_WEIGHTS, loadedPotentialMid: 0 },
      width: 32,
    });
    expect(baseline).not.toBeNull();
    expect(zero).toEqual(baseline);
    expect(DEFAULT_WEIGHTS.loadedPotentialMid).toBe(0);
  });

  test("non-zero mid weight is unpriced outside the mid band", () => {
    const weights = { ...DEFAULT_WEIGHTS, loadedPotentialMid: 1000 };
    for (const input of [
      forcedRootInput(0),
      forcedRootInput(19),
      forcedRootInput(20),
      forcedRootInput(39),
      forcedRootInput(undefined),
    ]) {
      const baseline = search(input, { weights: DEFAULT_WEIGHTS, width: 32 });
      const shaped = search(input, { weights, width: 32 });
      expect(baseline).not.toBeNull();
      expect(shaped).toEqual(baseline);
    }
  });

  test("mechanism B weight does not leak into the mid band and vice versa", () => {
    // In the mid band, only loadedPotentialMid prices; loadedPotential alone is inert.
    const midInput = forcedRootInput(50);
    const baselineMid = search(midInput, { weights: DEFAULT_WEIGHTS, width: 32 });
    const bOnlyMid = search(midInput, {
      weights: { ...DEFAULT_WEIGHTS, loadedPotential: 1000 },
      width: 32,
    });
    expect(bOnlyMid).toEqual(baselineMid);
    // In the opening band, only loadedPotential prices; loadedPotentialMid alone is inert.
    const openInput = forcedRootInput(5);
    const baselineOpen = search(openInput, { weights: DEFAULT_WEIGHTS, width: 32 });
    const midOnlyOpen = search(openInput, {
      weights: { ...DEFAULT_WEIGHTS, loadedPotentialMid: 1000 },
      width: 32,
    });
    expect(midOnlyOpen).toEqual(baselineOpen);
  });

  test("in band, the root child earns credit for retained potential", () => {
    const weight = 10;
    for (const lock of [40, 50]) {
      const input = forcedRootInput(lock);
      const baseline = search(input, { weights: DEFAULT_WEIGHTS, width: 32 });
      const shaped = search(input, {
        weights: { ...DEFAULT_WEIGHTS, loadedPotentialMid: weight },
        width: 32,
      });
      if (!baseline || !shaped) throw new Error("expected both searches to find a line");
      // The forced root keeps B2B (no clear) and the I-quad in the well, so
      // the child total is at least 2 (b2bActive + premiumWithinTwo); the
      // credit enters the root reward unscaled (discount ** 0).
      const diff = shaped.value - baseline.value;
      expect(diff).toBeGreaterThanOrEqual(2 * weight);
      expect(diff).toBeLessThanOrEqual(3 * weight);
      expect(diff / weight).toBeCloseTo(Math.round(diff / weight), 6);
    }
  });
});

describe("SB-3 profile wiring (cancelBonus pattern)", () => {
  test("explicit 0 keeps the default identity; 15 loads and changes it", () => {
    const dir = mkdtempSync(join(import.meta.dir, ".tmp-sb3-profile-"));
    try {
      const zeroPath = join(dir, "zero.json");
      const onPath = join(dir, "on.json");
      writeFileSync(zeroPath, JSON.stringify({ loadedPotentialMid: 0 }));
      writeFileSync(onPath, JSON.stringify({ loadedPotentialMid: 15 }));
      const base = createAttaxDecider(undefined);
      const zero = createAttaxDecider(zeroPath);
      const on = createAttaxDecider(onPath);
      expect(zero.profileId).toBe(base.profileId);
      expect(zero.weights.loadedPotentialMid).toBe(0);
      expect(on.weights.loadedPotentialMid).toBe(15);
      expect(on.weights.loadedPotential).toBe(0);
      expect(on.profileId).not.toBe(base.profileId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
