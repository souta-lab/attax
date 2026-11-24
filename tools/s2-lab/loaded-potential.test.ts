import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_WEIGHTS } from "../../src/ai/bot/weights.js";
import { createAttaxDecider } from "./attax-player.js";
import { isLoadedBand, loadedPotential, premiumClearWithinTwo } from "./loaded-potential.js";
import { type SearchInput, search } from "./search.js";

/** Bottom four rows filled except column 0, plus a cap cell against PC. */
function wellBoard(): Uint16Array {
  const board = new Uint16Array(40);
  for (let row = 36; row < 40; row++) board[row] = 0b1111111110;
  board[35] = 1 << 9;
  return board;
}

describe("loaded potential band", () => {
  test("band is root locks 0-19 only", () => {
    expect(isLoadedBand(0)).toBe(true);
    expect(isLoadedBand(19)).toBe(true);
    expect(isLoadedBand(20)).toBe(false);
    expect(isLoadedBand(undefined)).toBe(false);
  });
});

describe("premium clear existence", () => {
  test("quad in the well is found within two placements", () => {
    expect(premiumClearWithinTwo(wellBoard(), ["I"], 0, null, false)).toBe(true);
    // Also within two: a non-clearing O first, the I second.
    expect(premiumClearWithinTwo(wellBoard(), ["O", "I"], 0, null, false)).toBe(true);
  });

  test("empty board with no setup has no premium clear", () => {
    const empty = new Uint16Array(40);
    expect(premiumClearWithinTwo(empty, ["T", "O"], 0, null, false)).toBe(false);
  });
});

describe("loaded potential features", () => {
  test("empty board, no chain: total 0; active B2B alone: total 1", () => {
    const empty = new Uint16Array(40);
    const base = {
      board: empty,
      tSlot: 0,
      sequence: ["O"] as const,
      next: 0,
      hold: null,
      canHold: false,
    };
    expect(loadedPotential({ ...base, b2b: 0 }).total).toBe(0);
    const withB2b = loadedPotential({ ...base, b2b: 2 });
    expect(withB2b.b2bActive).toBe(true);
    expect(withB2b.total).toBe(1);
  });

  test("well board with I next carries the premium feature", () => {
    const p = loadedPotential({
      board: wellBoard(),
      b2b: 0,
      tSlot: 0,
      sequence: ["I"],
      next: 0,
      hold: null,
      canHold: false,
    });
    expect(p.premiumWithinTwo).toBe(true);
    expect(p.total).toBeGreaterThanOrEqual(1);
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

describe("mechanism B pricing in the S2 search", () => {
  test("default weight 0 is identical to the default profile in band", () => {
    const input = forcedRootInput(5);
    const baseline = search(input, { weights: DEFAULT_WEIGHTS, width: 32 });
    const zero = search(input, {
      weights: { ...DEFAULT_WEIGHTS, loadedPotential: 0 },
      width: 32,
    });
    expect(baseline).not.toBeNull();
    expect(zero).toEqual(baseline);
  });

  test("non-zero weight is unpriced outside the band and without a lock index", () => {
    const weights = { ...DEFAULT_WEIGHTS, loadedPotential: 1000 };
    for (const input of [forcedRootInput(20), forcedRootInput(undefined)]) {
      const baseline = search(input, { weights: DEFAULT_WEIGHTS, width: 32 });
      const shaped = search(input, { weights, width: 32 });
      expect(baseline).not.toBeNull();
      expect(shaped).toEqual(baseline);
    }
  });

  test("in band, the root child earns credit for retained potential", () => {
    const weight = 10;
    const input = forcedRootInput(5);
    const baseline = search(input, { weights: DEFAULT_WEIGHTS, width: 32 });
    const shaped = search(input, {
      weights: { ...DEFAULT_WEIGHTS, loadedPotential: weight },
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
  });
});

describe("profile wiring (cancelBonus pattern)", () => {
  test("explicit 0 keeps the default identity; 15 loads and changes it", () => {
    const dir = mkdtempSync(join(import.meta.dir, ".tmp-mech-b-profile-"));
    try {
      const zeroPath = join(dir, "zero.json");
      const onPath = join(dir, "on.json");
      writeFileSync(zeroPath, JSON.stringify({ loadedPotential: 0 }));
      writeFileSync(onPath, JSON.stringify({ loadedPotential: 15 }));
      const base = createAttaxDecider(undefined);
      const zero = createAttaxDecider(zeroPath);
      const on = createAttaxDecider(onPath);
      expect(zero.profileId).toBe(base.profileId);
      expect(zero.weights.loadedPotential).toBe(0);
      expect(on.weights.loadedPotential).toBe(15);
      expect(on.profileId).not.toBe(base.profileId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
