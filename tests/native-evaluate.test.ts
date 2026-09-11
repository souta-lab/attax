import { describe, expect, test } from "bun:test";
import {
  ACT_PC,
  ACT_TSD,
  GamePack,
  MINO_I,
  MINO_T,
  searchPcBoard,
  searchTsd,
} from "../src/ai/native/index.js";
import { getFinalAction } from "../src/ai/native/evaluate.js";
import { hoikoWeightList } from "../src/ai/hoiko-weights.js";

const ew = hoikoWeightList("we")[0];
if (ew === undefined) throw new Error("missing we preset");

function finalAction(
  act: number,
  locked: number,
  combo: number,
  btb: number,
  moveDelay: number,
): number {
  const g = new GamePack();
  g.act = act;
  g.lockedMino.m = locked;
  g.combo = combo;
  g.btb = btb;
  g.commands.moveDelay = moveDelay;
  return getFinalAction(g, ew, 0);
}

describe("GetFinalAction (SPEC_EvaluateAI §8 #8)", () => {
  test("TSD uses the Tsd reward plus combo debt (no btb bonus at btb=1)", () => {
    // moveDelay 0 -> no MoveDelay term; Tsd 300 + ComboDebt 250 = 550
    expect(finalAction(ACT_TSD, MINO_T, 1, 1, 0)).toBe(550);
  });

  test("Pc returns immediately after Pc + discounted moveDelay", () => {
    // base 112>>4=7*(-3)=-21 ; Pc 1500 ; 112>>5=3*(+3)=+9 ; btb=0 & I -> WasteI -100
    expect(finalAction(ACT_PC, MINO_I, 0, 0, 112)).toBe(1388);
  });

  test("None adds a WasteI penalty plus ComboDebt per combo", () => {
    expect(finalAction(0, MINO_I, 2, 0, 0)).toBe(-100 + 2 * 250);
  });
});

describe("SearchTsd / SearchPcBoard (SPEC_EvaluateAI §3-§4)", () => {
  test("flat board produces no TSD and no PC chance", () => {
    const g = new GamePack();
    g.board.init();
    g.board.line[0] = 1023;
    g.board.line[1] = 1023;
    g.board.updateMaxHeight();
    g.hold.m = 7;
    g.fallingMino.m = MINO_I;
    const ch = new Int32Array(10).fill(-1);
    const garbage = g.board.getColumnHeight(ch);
    expect(searchTsd(g, ch, garbage, ew)).toBe(0);
    expect(searchPcBoard(g, garbage, ew, true)).toBe(0);
  });

  test("a TSD notch on a flat board is rewarded", () => {
    const g = new GamePack();
    g.board.init();
    g.board.line[0] = 1023;
    g.board.line[1] = 1023;
    g.board.line[2] = (1 << 9) | (1 << 7);
    g.board.updateMaxHeight();
    g.hold.m = 7;
    g.fallingMino.m = MINO_I;
    const ch = new Int32Array(10).fill(-1);
    const garbage = g.board.getColumnHeight(ch);
    expect(searchTsd(g, ch, garbage, ew)).toBeGreaterThan(0);
  });

  test("PC chance with an even board and I falling on a 3-row board", () => {
    const g = new GamePack();
    g.board.init();
    g.board.line[0] = 1023 ^ (1 << 0);
    g.board.line[1] = 1023 ^ (1 << 0);
    g.board.line[2] = 1023 ^ (1 << 0);
    g.board.line[3] = 1023 ^ (1 << 0);
    g.board.updateMaxHeight();
    g.hold.m = 7;
    g.fallingMino.m = MINO_I;
    const ch = new Int32Array(10).fill(-1);
    const garbage = g.board.getColumnHeight(ch);
    expect(garbage).toBe(-1);
    expect(searchPcBoard(g, garbage, ew, false)).toBe(0);
  });
});
