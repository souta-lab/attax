import { describe, expect, test } from "bun:test";
import {
  MINO_I,
  MINO_J,
  nativeBestMove,
  NextMino,
  type NativeInput,
} from "../src/ai/native/index.js";
import { trustRange } from "../src/ai/native/nextmino.js";

describe("NextMino (SPEC_Search §4)", () => {
  test("pins the real queue and sets the trust window for viewNext=2", () => {
    const next = new NextMino();
    next.viewNext = 2;
    next.init([MINO_I, MINO_J]);
    expect(next.at(0)).toBe(MINO_I);
    expect(next.at(1)).toBe(MINO_J);
    // trustEnd = (viewNext - 1) + trustRange(bagRemains=6) = 1 + 2
    expect(next.trustEnd).toBe(3);
    expect(next.bagRemains).toBe(6);
  });

  test("trustRange follows the native bag.remains table", () => {
    expect(trustRange(6)).toBe(2);
    expect(trustRange(5)).toBe(1);
    expect(trustRange(4)).toBe(0);
    expect(trustRange(0)).toBe(3);
  });
});

describe("nativeBestMove sanity", () => {
  test("empty board with I picks a legal floor placement", () => {
    const input: NativeInput = {
      board: [],
      current: "I",
      queue: ["O", "T", "S", "Z", "J", "L", "I", "O"],
      hold: null,
      combo: 0,
      btb: 0,
    };
    const move = nativeBestMove(input, {
      timeLimitMs: Number.POSITIVE_INFINITY,
      adapt: false,
    });
    expect(move).not.toBeNull();
    expect([0, 1, 2, 3]).toContain(move?.rotation);
    expect(move?.x).toBeGreaterThanOrEqual(-2);
    expect(move?.x).toBeLessThanOrEqual(9);
    expect(move?.useHold).toBe(false);
  });

  test("returns null when the board already tops out", () => {
    const full = new Array<number>(20).fill(1023);
    const input: NativeInput = {
      board: full,
      current: "I",
      queue: ["O", "T", "S", "Z", "J", "L"],
      hold: null,
      combo: 0,
      btb: 0,
    };
    const move = nativeBestMove(input, {
      timeLimitMs: Number.POSITIVE_INFINITY,
      adapt: false,
    });
    expect(move).toBeNull();
  });
});
