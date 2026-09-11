import { describe, expect, test } from "bun:test";
import { evalResource, getColumnHeight, type SourceBoard } from "../src/ai/hoiko-eval.js";
import { hoikoPresetWeights } from "../src/ai/hoiko-weights.js";

/**
 * EvalResource's S4W bonus scans for a "wide" row and aborts when the
 * accumulated fill already overlaps the reserved columns. Native
 * TetrizAI_Evaluate.cpp:481 guards the 0b11100'00111 (0x387) pattern with
 * `fill & 0b00011'11000` (= 0x078, bits 3-6). If the guard drops bit 6 the
 * bonus is added on setups it must reject.
 */
describe("Hoiko EvalResource S4W guard", () => {
  test("third wide pattern rejects bit 6 in the accumulated fill", () => {
    // y0..y7 bottom-up, in native source orientation. y6 is the 0x387 wide row;
    // y7 (above it) sets bit 6, which must abort the S4W bonus.
    const rowsAsc = [0x040, 0x040, 0x387, 0x387, 0x387, 0x387, 0x387, 0x040];
    const src: SourceBoard = {
      line: [...rowsAsc, ...new Array<number>(24).fill(0)],
      stackHeight: 7,
    };
    const columnHeight = new Array<number>(10).fill(-1);
    const garbageHeight = getColumnHeight(src, columnHeight);
    const ew = hoikoPresetWeights("we");

    const withS4W = evalResource(src, columnHeight, garbageHeight, ew, true, false, 0);
    const withoutS4W = evalResource(src, columnHeight, garbageHeight, ew, false, false, 0);

    expect(garbageHeight).toBe(-1);
    expect(withS4W).toBe(withoutS4W);
  });
});
