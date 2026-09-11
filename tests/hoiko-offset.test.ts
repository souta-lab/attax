import { describe, expect, test } from "bun:test";
import {
  calcOpponentsAtk,
  canWaitGarbage,
  computeOffsetData,
  getOpponentsAtk,
  isFirstInvalidLockDown,
  isInCoolTime,
  newGarbageData,
  opponentIsNewLockDown,
  setCoolTimeAfterClearing,
  setRemainingTime,
} from "../src/ai/hoiko-offset.js";
import { createBoard } from "../src/core/board.js";

describe("Hoiko OffsetAI", () => {
  test("rejects waiting when the current plan clears", () => {
    const ofs = computeOffsetData(createBoard(32), ["T", "I", "T"], null, 0, ["Double"], true);
    expect(ofs.canWaitGarbage).toBe(false);
  });

  test("uses the selected plan and back-to-back bonus", () => {
    const ofs = computeOffsetData(
      createBoard(32),
      ["S", "Z", "I"],
      null,
      1,
      ["None", "Tss", "None"],
      true,
    );
    expect(ofs.canWaitGarbage).toBe(true);
    expect(ofs.atk).toBe(3);
  });

  test("only enables perfect-clear chance on even boards", () => {
    const plan = ["None", "Single", "Pc"] as const;
    const even = computeOffsetData(createBoard(32), ["S", "Z", "I"], null, 0, plan, true);
    const odd = computeOffsetData(createBoard(32), ["S", "Z", "I"], null, 0, plan, false);
    expect(even.pcChance).toBe(true);
    expect(odd.pcChance).toBe(false);
  });

  test("does not inspect actions beyond the visible next range", () => {
    const plan = ["None", "Single", "None", "None", "Pc"] as const;
    const ofs = computeOffsetData(createBoard(32), ["S", "Z", "I"], null, 0, plan, true);
    expect(ofs.pcChance).toBe(false);
    expect(ofs.canWaitGarbage).toBe(false);
  });

  test("matches native clear timing values", () => {
    const gb = newGarbageData();
    setRemainingTime(gb, "Quad");
    setCoolTimeAfterClearing(gb, 100, 0, 4);
    expect(gb.remainingTime).toBe(5);
    expect(gb.coolTime).toBe(129);
    expect(isInCoolTime(gb, 128)).toBe(true);
    expect(isInCoolTime(gb, 129)).toBe(false);
  });

  test("tracks native opponent attack estimates and invalidation", () => {
    const gb = newGarbageData();
    calcOpponentsAtk(gb, 2, 1, 1, 3);
    expect(getOpponentsAtk(gb)).toBe(6);
    expect(opponentIsNewLockDown(gb, 4)).toBe(true);
    expect(opponentIsNewLockDown(gb, 4)).toBe(false);
    setRemainingTime(gb, "Double");
    setCoolTimeAfterClearing(gb, 100, 1, 4);
    expect(getOpponentsAtk(gb)).toBe(-1);
    expect(isFirstInvalidLockDown(gb)).toBe(true);
    expect(isFirstInvalidLockDown(gb)).toBe(false);
  });

  test("applies the native wait gate", () => {
    const ofs = {
      canWaitGarbage: true,
      center4Height: 3,
      garbageHeight: 0,
      atk: 2,
      pcChance: false,
      nearOffset: false,
    };
    expect(canWaitGarbage(ofs, 4, 0, false)).toBe(true);
    expect(canWaitGarbage(ofs, 2, 0, false)).toBe(false);
  });
});
