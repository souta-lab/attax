import { describe, expect, test } from "bun:test";
import { createEngine } from "../src/core/engine.js";
import type { ClearInfo } from "../src/core/garbage.js";
import type { PieceKind } from "../src/core/pieces.js";
import {
  awardLock,
  RULES_PROFILES,
  s2ComboAttack,
  s2GarbageMultiplier,
  s2Surge,
} from "../src/core/rules.js";
import { classifyS2Spin } from "../src/core/s2-spin.js";

const clear = (lines: number, extra: Partial<ClearInfo> = {}): ClearInfo => ({
  lines,
  tspinLines: 0,
  combo: 0,
  b2bActive: false,
  perfectClear: false,
  ...extra,
});
const award = (lines: number, chain = 0, extra: Partial<ClearInfo> = {}) =>
  awardLock("tetrio-s2", clear(lines, extra), chain);

describe("S2-SPEC: Attack table and complete combo rule", () => {
  test("every pinned base and continued B2B row", () => {
    for (const [lines, normal, mini, full] of [
      [1, 0, 0, 2],
      [2, 1, 1, 4],
      [3, 2, 2, 6],
    ]) {
      expect(award(lines).attack).toBe(normal);
      for (const [kind, base] of [
        ["mini", mini],
        ["full", full],
      ] as const) {
        expect(award(lines, 0, { tspinKind: kind }).attack).toBe(base);
        expect(award(lines, 1, { tspinKind: kind }).attack).toBe(base + 1);
      }
    }
    expect(award(4).attack).toBe(4);
    expect(award(4, 1).attack).toBe(5);
    for (const tspinKind of ["none", "mini", "full"] as const) {
      expect(award(0, 9, { tspinKind, combo: 10, perfectClear: true })).toEqual({
        attack: 0,
        difficultChain: 9,
        surgeReleased: 0,
      });
    }
  });
  test("all chart combo cells and the unbounded logarithmic floor", () => {
    const rows = [
      [0, 0, 1, 1, 1, 1, 2, 2, 2],
      [1, 1, 1, 1, 2, 2, 2, 2, 3],
      [2, 2, 3, 3, 4, 4, 5, 5, 6],
      [3, 3, 4, 5, 6, 6, 7, 8, 9],
      [4, 5, 6, 7, 8, 9, 10, 11, 12],
      [5, 6, 7, 8, 10, 11, 12, 13, 15],
      [6, 7, 9, 10, 12, 13, 15, 16, 18],
      [7, 8, 10, 12, 14, 15, 17, 19, 21],
    ];
    rows.forEach((row, a) => row.forEach((value, c) => expect(s2ComboAttack(a, c)).toBe(value)));
    expect(s2ComboAttack(0, 100)).toBe(4);
    expect(s2ComboAttack(4, 100)).toBe(104);
    expect(award(4, 1, { combo: 4 }).attack).toBe(10);
  });
  test("PC adds five after combo and advances exactly once (Unpinned #1 resolved)", () => {
    expect(award(2, 0, { perfectClear: true })).toEqual({
      attack: 6,
      difficultChain: 1,
      surgeReleased: 0,
    });
    expect(award(2, 1, { perfectClear: true, combo: 1 })).toEqual({
      attack: 7,
      difficultChain: 2,
      surgeReleased: 0,
    });
    expect(award(4, 5, { perfectClear: true }).difficultChain).toBe(6);
  });
  test("engine exotic rows retain B2B and combo composition", () => {
    for (const tspinKind of ["mini", "full"] as const) {
      for (const [lines, base] of [
        [4, 10],
        [5, 12],
      ]) {
        expect(award(lines, 0, { tspinKind }).attack).toBe(base);
        expect(award(lines, 2, { tspinKind, combo: 3 }).attack).toBe(s2ComboAttack(base + 1, 3));
      }
    }
    expect(award(5).attack).toBe(5);
    expect(award(6).attack).toBe(6);
  });
  test("unit staging preserves unstaged awards across the attack grid", () => {
    for (const lines of [0, 1, 2, 3, 4, 5, 6])
      for (const tspinKind of ["none", "mini", "full"] as const)
        for (const combo of [-1, 0, 1, 4, 10])
          for (const chain of [0, 1, 5, 9])
            for (const perfectClear of [false, true]) {
              const info = clear(lines, { tspinKind, combo, perfectClear });
              expect(
                awardLock("tetrio-s2", info, chain, { multiplier: 1, garbageCleared: 0 }),
              ).toEqual(awardLock("tetrio-s2", info, chain));
              expect(
                awardLock("guideline", info, chain, { multiplier: 1.5, garbageCleared: 2 }),
              ).toEqual(awardLock("guideline", info, chain));
            }
  });
  test("referee multiplies raw, adds special, floors PC separately, then adds surge", () => {
    const stage = { multiplier: 1.5, garbageCleared: 2 };
    expect(awardLock("tetrio-s2", clear(4), 0, stage).attack).toBe(7);
    expect(awardLock("tetrio-s2", clear(2), 0, stage).attack).toBe(1);
    expect(awardLock("tetrio-s2", clear(2, { tspinKind: "full" }), 0, stage).attack).toBe(7);
    expect(awardLock("tetrio-s2", clear(2, { perfectClear: true }), 0, stage).attack).toBe(8);
    // The released surge is margin-multiplied too: the referee's
    // calculateSurge takes the garbage multiplier, so this is
    // floor(1 * 1.5) + floor(s2Surge(5) * 1.5) = 1 + 6 = 7.
    expect(awardLock("tetrio-s2", clear(2), 5, stage).attack).toBe(7);
  });
  test("margin multiplier uses logical frames", () => {
    expect(s2GarbageMultiplier(0)).toBe(1);
    expect(s2GarbageMultiplier(10800)).toBe(1);
    expect(s2GarbageMultiplier(18300)).toBeCloseTo(2, 12);
  });
});

describe("S2-SPEC: B2B charging and surge", () => {
  test("displayed x4 and x8 thresholds; no documented cap", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9, 11, 101].map(s2Surge)).toEqual([
      0, 0, 0, 0, 0, 4, 5, 8, 10, 100,
    ]);
  });
  test("blank preserves; each difficult clear charges once regardless of combo/lines", () => {
    for (const lines of [1, 2, 3]) {
      expect(award(lines, 5, { tspinKind: "mini", combo: 20 }).difficultChain).toBe(6);
    }
    expect(award(4, 5).difficultChain).toBe(6);
    expect(award(0, 5).difficultChain).toBe(5);
  });
  test("ordinary breaking clear releases alongside ordinary attack, with no B2B +1", () => {
    for (const [lines, base] of [
      [1, 0],
      [2, 1],
      [3, 2],
    ]) {
      expect(award(lines, 5)).toEqual({ attack: base + 4, difficultChain: 0, surgeReleased: 4 });
      expect(award(lines, 4).surgeReleased).toBe(0);
    }
  });
});

describe("S2-SPEC: Spin detection: All-Mini versus All-Mini+", () => {
  const placement = { kind: "T" as PieceKind, rotation: 0, x: 3, y: 10, lastSrs: 1 };
  const corners = (indices: number[]) => (x: number, y: number) =>
    [
      [3, 10],
      [5, 10],
      [5, 12],
      [3, 12],
    ].some(([cx, cy], i) => indices.includes(i) && x === cx && y === cy);
  test("T facing corners, minis, fifth quarter-turn kick and rotation requirement", () => {
    expect(classifyS2Spin(placement, corners([0, 1, 2]), () => true)).toBe("full");
    expect(classifyS2Spin(placement, corners([0, 2, 3]), () => true)).toBe("mini");
    expect(classifyS2Spin({ ...placement, lastSrs: 5 }, corners([0, 2, 3]), () => true)).toBe(
      "full",
    );
    expect(classifyS2Spin({ ...placement, lastSrs: 0 }, corners([0, 1, 2]), () => false)).toBe(
      "none",
    );
    for (let r = 0; r < 4; r++) {
      expect(
        classifyS2Spin(
          { ...placement, rotation: r },
          corners([r, (r + 1) % 4, (r + 2) % 4]),
          () => true,
        ),
      ).toBe("full");
    }
  });
  test("every piece including O and fallback T needs immobility in all four directions", () => {
    for (const kind of ["T", "I", "J", "L", "S", "Z", "O"] as const) {
      expect(
        classifyS2Spin(
          { ...placement, kind },
          () => false,
          () => false,
        ),
      ).toBe("mini");
      expect(
        classifyS2Spin(
          { ...placement, kind, lastSrs: 0 },
          () => false,
          () => false,
        ),
      ).toBe("none");
      for (const [mx, my] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        expect(
          classifyS2Spin(
            { ...placement, kind },
            () => false,
            (dx, dy) => dx === mx && dy === my,
          ),
        ).toBe("none");
      }
    }
  });
});

test("S2 board convention (LAB-RECON: Timing and adapter requirements): 10x40, 20 visible", () => {
  expect(RULES_PROFILES["tetrio-s2"]).toEqual({ cols: 10, rows: 40, visibleRows: 20 });
  const engine = createEngine({ rulesProfile: "tetrio-s2", random: () => 0.5 });
  expect(engine.getSnapshot().board.rows).toBe(40);
  engine.hardDrop();
  expect(engine.getLastLockTransition()?.boardAfterLockClear).toHaveLength(40);
  expect(engine.getSnapshot().gameOver).toBe(false);
  engine.reset();
  expect(engine.getSnapshot().board.grid).toHaveLength(40);
  expect(createEngine().getSnapshot().board.rows).toBe(20);
});

test("S2-SPEC: B2B charging and surge / Attack table: engine blank resets combo to inactive zero", () => {
  const engine = createEngine({ rulesProfile: "tetrio-s2", random: () => 0.999 });
  const place = (rotation: number, x: number, y: number) => engine.placeMinoAt?.(rotation, x, y, 0);
  // Real piece cells complete the bottom row: I, O, T, then vertical S.
  expect(place(0, 0, 38)).toBe(true);
  expect(place(0, 3, 38)).toBe(true);
  expect(place(0, 6, 38)).toBe(true);
  expect(place(3, 8, 37)).toBe(true);
  expect(engine.getSnapshot().combo).toBe(0);
  expect(engine.getSnapshot().nativeCombo).toBe(1);
  expect(engine.getLastLockTransition()?.rawAttack).toBe(0);
  expect(place(0, 0, 38)).toBe(true);
  expect(engine.getSnapshot().combo).toBe(-1);
  expect(engine.getSnapshot().nativeCombo).toBe(0);
});

test("S2-SPEC: Spin detection: walls count as T corners", () => {
  const wallSlot = { kind: "T" as const, rotation: 1, x: -1, y: 10, lastSrs: 1 };
  // Legal right-facing T in column 0: two left corners are wall, upper right is roof.
  const occupied = (x: number, y: number) => x < 0 || x >= 10 || y >= 40 || (x === 1 && y === 10);
  expect(classifyS2Spin(wallSlot, occupied, () => true)).toBe("mini");
  expect(classifyS2Spin({ ...wallSlot, lastSrs: 5 }, occupied, () => true)).toBe("full");
});
