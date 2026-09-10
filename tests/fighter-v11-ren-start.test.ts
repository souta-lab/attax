import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { beamBestMove } from "../src/ai/beam.js";

// GREEN-v10-ren-threshold (T8 characterization of reverted behavior).
// Reverted v10: fighterA.ts:45 `const REN_START = 2` + :169-171
//   `if (lines > 0 && ncombo >= REN_START) { const renStep = pieces >= REN_LATE_N ? REN_LATE_STEP : REN_STEP; s += ncombo * renStep * late; }`
//   where ncombo = ctx.combo + 1, late = pieces >= LATE_PIECE_N(60) ? 1.15 : 1.
//   So incoming combo=0 + lines>0 => ncombo=1 earns 1*55*late (early) / 1*110*late (late).
// GREEN expectation: gate the chain at >= 2, so ncombo=1 earns 0;
//   only ncombo>=2 keeps the bonus. This file characterizes the reverted
//   v10 behavior and passes after the T8 revert.

describe("GREEN-v10-ren-threshold: REN chain bonus ordering", () => {
  test("GREEN-v10-ren-threshold: ncombo=1 remains gated, ncombo=2 earns REN_STEP", () => {
    const src = readFileSync(new URL("../src/ai/fighterA.ts", import.meta.url), "utf8");
    const m = src.match(/const REN_START\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    const renStart = Number(m?.[1]);
    // Document reverted threshold.
    expect(renStart).toBe(2);

    // Exact replica of fighterA.ts:44,46-47,68,169-171 math.
    const REN_STEP = 55;
    const REN_LATE_STEP = 110;
    const REN_LATE_N = 150;
    const renBonusCurrent = (ncombo: number, lines: number, pieces: number): number => {
      if (!(lines > 0 && ncombo >= renStart)) return 0;
      const renStep = pieces >= REN_LATE_N ? REN_LATE_STEP : REN_STEP;
      const late = pieces >= 60 ? 1.15 : 1;
      return ncombo * renStep * late;
    };
    const renBonusGated = (ncombo: number, lines: number, pieces: number): number => {
      if (!(lines > 0 && ncombo >= 2)) return 0;
      const renStep = pieces >= REN_LATE_N ? REN_LATE_STEP : REN_STEP;
      const late = pieces >= 60 ? 1.15 : 1;
      return ncombo * renStep * late;
    };

    // Reverted threshold gates ncombo=1 (incoming combo=0 + lines>0).
    expect(renBonusCurrent(1, 1, 10)).toBe(0);
    expect(renBonusGated(1, 1, 10)).toBe(0);
    // Late-mult path remains gated: ncombo=1 earns 0.
    expect(renBonusCurrent(1, 1, 200)).toBe(0);
    expect(renBonusGated(1, 1, 200)).toBe(0);
    // Two-ply combo keeps bonus under both (ncombo=2): 2*55=110.
    expect(renBonusCurrent(2, 1, 10)).toBe(110);
    expect(renBonusGated(2, 1, 10)).toBe(110);

    // Same ordering through a mock scorer ctx (mirrors PlyContext combo semantics:
    // ncombo = lines>0 ? ctx.combo+1 : -1).
    const scorerFor = (threshold: number) => (lines: number, combo: number): number => {
      const ncombo = lines > 0 ? combo + 1 : -1;
      if (!(lines > 0 && ncombo >= threshold)) return 0;
      return ncombo * REN_STEP;
    };
    expect(scorerFor(1)(1, 0)).toBe(55);
    expect(scorerFor(2)(1, 0)).toBe(0);
    expect(scorerFor(2)(1, 1)).toBe(110);

    // Black-box: the scorer seam plugs into the real beamBestMove path deterministically.
    const board = new Uint16Array(20);
    const mv = beamBestMove(board, "T", ["I", "O", "S", "Z", "L"], null, true, false, -1, {
      depth: 1,
      scorer: (after, lines, tspin, ctx) => {
        void after;
        void tspin;
        return scorerFor(1)(lines, ctx.combo);
      },
    });
    expect(mv).not.toBeNull();
    expect(mv?.score).toBeFinite();

    // GREEN expectation: threshold remains gated at >= 2.
    // Reverted v10: `const REN_START = 2` at fighterA.ts:45 (or `ncombo >= 2` at :169).
    expect(renStart).toBe(2);
  });
});
