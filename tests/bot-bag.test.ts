import { describe, expect, test } from "bun:test";
import { BagTracker } from "../src/ai/bot/bag.js";
import { selectBeam } from "../src/ai/bot/search.js";

describe("observed seven-bag", () => {
  test("counts previews once and crosses bag boundaries", () => {
    const bag = new BagTracker();
    expect(bag.observe(["I", "O", "T", "S", "Z", "J"])).toEqual(["L"]);
    expect(bag.observe(["O", "T", "S", "Z", "J", "L"])).toHaveLength(7);
    expect(bag.observe(["S", "Z", "J", "L", "T", "O"])).toHaveLength(5);
    expect(bag.observe(["S", "Z", "J", "L", "T", "O"])).toHaveLength(5);
    bag.reset();
    expect(bag.observe(["L"])).toHaveLength(6);
  });
  test("disables speculation on contradictory or discontinuous streams", () => {
    const bag = new BagTracker();
    expect(bag.observe(["T", "T"])).toEqual([]);
    bag.reset();
    bag.observe(["I", "O"]);
    expect(bag.observe(["T", "S"])).toEqual([]);
  });
});

test("beam preserves legal and attack-economy distinctions", () => {
  const base = {
    board: new Uint16Array(20),
    next: 2,
    hold: null,
    canHold: true,
    b2b: false,
    combo: 0,
    lift: 0,
    root: 0,
    value: 10,
  };
  const states = [
    base,
    { ...base, combo: 1 },
    { ...base, lift: 1 },
    { ...base, canHold: false },
    { ...base, b2b: true },
    { ...base, next: 3 },
    { ...base, value: 9 },
  ];
  expect(selectBeam(states, 20)).toHaveLength(6);
});

test("beam reserves alternative roots within its bounded pool", () => {
  const states = Array.from({ length: 40 }, (_, i) => ({
    board: new Uint16Array([i]),
    next: 2,
    hold: null,
    canHold: true,
    b2b: false,
    combo: 0,
    lift: 0,
    root: i < 30 ? 0 : i - 29,
    value: 100 - i,
  }));
  expect(new Set(selectBeam(states, 24).map((node) => node.root)).size).toBeGreaterThanOrEqual(4);
});

test("authoritative mid-bag resync does not consume previews twice", () => {
  const bag = new BagTracker();
  bag.seed(["I", "O"]);
  expect(bag.observe(["S", "T", "L", "J", "Z", "S"])).toEqual(["I", "O"]);
  expect(bag.observe(["T", "L", "J", "Z", "S", "I"])).toEqual(["O"]);
});

test("chance continuation averages possible pieces without exposing guessed moves", async () => {
  const { search } = await import("../src/ai/bot/search.js");
  const { DEFAULT_WEIGHTS } = await import("../src/ai/bot/weights.js");
  const input = {
    board: new Uint16Array(20),
    active: { kind: "O" as const, rotation: 0, x: 3, y: 0 },
    hold: null,
    canHold: false,
    preview: [],
    b2b: false,
    combo: -1,
    pending: 0,
  };
  const options = { weights: DEFAULT_WEIGHTS, width: 32, diverse: true };
  const i = search({ ...input, speculativePieces: ["I"] }, options);
  const t = search({ ...input, speculativePieces: ["T"] }, options);
  const mixed = search({ ...input, speculativePieces: ["I", "T"] }, options);
  expect(i).not.toBeNull();
  expect(t).not.toBeNull();
  expect(mixed).not.toBeNull();
  if (!i || !t || !mixed) throw new Error("missing continuation");
  expect(mixed.value).toBeLessThanOrEqual((i.value + t.value) / 2 + 1e-9);
  expect(mixed.line).toHaveLength(1);
  expect(mixed.nodes).toBeGreaterThan(i.nodes);
});
