// Issue #27: mini T-spins, B2B and combo must follow one attack spec that the
// engine applies and the AI predicts.
import { describe, expect, test } from "bun:test";
import { beamBestMove } from "../src/ai/beam.js";
import type { PlyContext } from "../src/ai/evaluation.js";
import {
  attackForClear,
  comboBonus,
  isDifficultClear,
  type TspinAttackKind,
} from "../src/core/garbage.js";
import { classifyPlacement } from "../src/core/tspin.js";

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

describe("AI search sees minis as minis", () => {
  // Left-edge notch: row0 misses col0, row1 misses cols 0/1. A T in rotation 1
  // at x=-1 clears both rows; the engine's front-corner rule calls it a mini.
  const MINI_EDGE = Uint16Array.from([FULL ^ 1, FULL ^ 0b11, ...new Array<number>(18).fill(0)]);
  // Standard TSD notch (see deepseek-v2.test.ts).
  const TSD = Uint16Array.from([
    FULL ^ (1 << 4),
    FULL ^ (1 << 3) ^ (1 << 4) ^ (1 << 5),
    ...new Array<number>(18).fill(0),
  ]);

  test("classifyPlacement matches the engine verdict for both slots", () => {
    expect(classifyPlacement(MINI_EDGE, "T", 1, -1, 0)).toBe("mini");
    expect(classifyPlacement(TSD, "T", 2, 3, 0)).toBe("full");
  });

  function spinCalls(board: Uint16Array) {
    const calls: { lines: number; tspin: boolean; mini: boolean | undefined }[] = [];
    beamBestMove(board, "T", [], null, false, false, -1, {
      depth: 1,
      useHold: false,
      scorer: (_after, lines, tspin, ctx: PlyContext) => {
        if (tspin && lines > 0) calls.push({ lines, tspin, mini: ctx.tspinMini });
        return 0;
      },
    });
    return calls;
  }

  test("the mini T-spin double reaches the scorer flagged as a mini", () => {
    const calls = spinCalls(MINI_EDGE);
    const double = calls.filter((c) => c.lines === 2);
    expect(double.length).toBeGreaterThan(0);
    for (const c of double) expect(c.mini).toBe(true);
    // Its attack is the mini value (1), not the TSD value (4) it used to get.
    expect(attackForClear(info(2, "mini"))).toBe(1);
  });

  test("a real TSD is still a full T-spin", () => {
    const calls = spinCalls(TSD);
    const tsd = calls.filter((c) => c.lines === 2);
    expect(tsd.length).toBeGreaterThan(0);
    for (const c of tsd) expect(c.mini).toBe(false);
  });
});
