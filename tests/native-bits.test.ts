import { describe, expect, test } from "bun:test";
import { Board, log2, popCount } from "../src/ai/native/index.js";

describe("native Bit.PopCount / Bit.Log2", () => {
  test("popcount of 10-bit rows (SPEC_Search §1.3)", () => {
    expect(popCount(0)).toBe(0);
    expect(popCount(1)).toBe(1);
    expect(popCount(512)).toBe(1);
    expect(popCount(0b1010101010)).toBe(5);
    expect(popCount(1023)).toBe(10);
  });

  test("log2 is the column index of a single set bit", () => {
    expect(log2(512)).toBe(0);
    expect(log2(256)).toBe(1);
    expect(log2(2)).toBe(8);
    expect(log2(1)).toBe(9);
  });
});

describe("native Board.GetColumnHeight", () => {
  test("fills per-column heights and returns the garbage height", () => {
    const b = new Board();
    b.line[0] = 1023;
    b.line[1] = 0b0000000011;
    b.stackHeight = 1;
    const ch = new Int32Array(10).fill(-1);
    const garbage = b.getColumnHeight(ch);
    expect(garbage).toBe(0);
    expect(Array.from(ch)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
  });

  test("empty board returns -1 and all columns -1", () => {
    const b = new Board();
    b.init();
    const ch = new Int32Array(10).fill(-1);
    expect(b.getColumnHeight(ch)).toBe(-1);
    expect(Array.from(ch)).toEqual(Array.from({ length: 10 }, () => -1));
  });
});
