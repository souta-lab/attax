// Issue #27: mini T-spins, B2B and combo must follow one attack spec that the
// engine applies and the bot predicts.
import { describe, expect, test } from "bun:test";
import { generatePlacements, lockPlacement } from "../src/ai/bot/movegen.js";
import {
  attackForClear,
  comboBonus,
  isDifficultClear,
  type TspinAttackKind,
} from "../src/core/garbage.js";

const FULL = 0x3ff;
const base = { combo: -1, b2bActive: false, perfectClear: false } as const;

function info(lines: number, kind: TspinAttackKind, extra: Partial<typeof base> = {}) {
  return { ...base, ...extra, lines, tspinLines: kind === "full" ? lines : 0, tspinKind: kind };
}

describe("B2B: a mini keeps the chain and earns the bonus", () => {
  test("mini T-spin single / double with B2B attack for 1 / 2", () => {
    expect(attackForClear(info(1, "mini", { b2bActive: true }))).toBe(1);
    expect(attackForClear(info(2, "mini", { b2bActive: true }))).toBe(2);
  });

  test("the B2B bonus is granted exactly when the clear continues B2B", () => {
    for (const kind of ["none", "mini", "full"] as const) {
      for (let lines = 1; lines <= 4; lines += 1) {
        if (kind !== "none" && lines === 4) continue;
        const on = attackForClear(info(lines, kind, { b2bActive: true }));
        const off = attackForClear(info(lines, kind));
        expect(on - off).toBe(isDifficultClear(lines, kind) ? 1 : 0);
      }
    }
  });

  test("plain singles/doubles/triples neither continue nor earn B2B", () => {
    expect(isDifficultClear(1, "none")).toBe(false);
    expect(isDifficultClear(3, "none")).toBe(false);
    expect(isDifficultClear(4, "none")).toBe(true);
    expect(isDifficultClear(0, "full")).toBe(false);
  });
});

describe("combo: the 0-based counter maps onto the guideline table", () => {
  test("first clear of a chain is combo 0 and earns nothing", () => {
    expect(comboBonus(-1)).toBe(0);
    expect(comboBonus(0)).toBe(0);
  });

  test("the second consecutive clear (1 REN) already earns +1", () => {
    expect(comboBonus(1)).toBe(1);
    expect(attackForClear(info(1, "none", { combo: 1 }))).toBe(1);
  });

  test("full ladder 0,1,1,2,2,3,3,4,4,4,5", () => {
    const ladder = [0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5, 5, 5];
    expect(ladder.map((_, i) => comboBonus(i))).toEqual(ladder);
  });
});

describe("the bot sees minis as minis", () => {
  // Bottom-up fixtures (row 0 = floor). Wall notch: row0 misses col 0. A T kicked into it
  // against the wall clears the row with only one front corner filled: a mini.
  const MINI_WALL = Uint16Array.from([FULL ^ 1, ...new Array<number>(19).fill(0)]);
  // A real TSD slot: stem hole at col 4, flat row open at cols 3-5, roof over col 3.
  const TSD = Uint16Array.from([
    FULL ^ (1 << 4),
    FULL ^ (1 << 3) ^ (1 << 4) ^ (1 << 5),
    0b1111,
    ...new Array<number>(18).fill(0),
  ]).slice(0, 20);
  // The same notch with no roof: a T dropped in touches only two corners, so the engine
  // awards a plain Double. (The pre-overhaul AI's helper misread this as a T-spin double.)
  const OPEN_NOTCH = Uint16Array.from([
    FULL ^ (1 << 4),
    FULL ^ (1 << 3) ^ (1 << 4) ^ (1 << 5),
    ...new Array<number>(18).fill(0),
  ]);

  // The bot's move generator uses engine (top-down) row order; these fixtures are bottom-up.
  function clears(bottomUp: Uint16Array) {
    const board = Uint16Array.from(bottomUp).reverse();
    return generatePlacements(board, "T")
      .map((p) => ({ lines: lockPlacement(board, p).linesCleared, kind: p.tspin }))
      .filter((c) => c.lines > 0);
  }

  test("a wall-kick T-spin single is generated flagged as a mini", () => {
    const singles = clears(MINI_WALL).filter((c) => c.lines === 1);
    expect(singles.some((c) => c.kind === "mini")).toBe(true);
    expect(singles.some((c) => c.kind === "full")).toBe(false);
    // Minis attack by the mini table: single 0, double 1 (not the TSD value 4).
    expect(attackForClear(info(1, "mini"))).toBe(0);
    expect(attackForClear(info(2, "mini"))).toBe(1);
  });

  test("a real TSD is a full T-spin", () => {
    const doubles = clears(TSD).filter((c) => c.lines === 2);
    expect(doubles.some((c) => c.kind === "full")).toBe(true);
  });

  test("an open notch without a roof is not a T-spin", () => {
    const doubles = clears(OPEN_NOTCH).filter((c) => c.lines === 2);
    expect(doubles.length).toBeGreaterThan(0);
    for (const c of doubles) expect(c.kind).toBe("none");
  });
});
