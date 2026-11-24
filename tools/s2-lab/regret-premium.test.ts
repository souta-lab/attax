import { describe, expect, test } from "bun:test";
import {
  premiumOf, premiumRegretRow, summarisePremiumBand, judgePremiumStage0,
} from "./regret.js";

describe("premiumOf", () => {
  test("lineBase table [0,0,1,2,4,5]", () => {
    expect(premiumOf(0, 1)).toBe(0);
    expect(premiumOf(3, 2)).toBe(2);
    expect(premiumOf(7, 4)).toBe(3);
    expect(premiumOf(1, 4)).toBe(0);
  });
});

describe("premiumRegretRow", () => {
  test("max premium candidate need not be max Aeff candidate", () => {
    const r = premiumRegretRow(
      { aeff: 6, lines: 4, spin: "none" },
      [{ aeff: 5, lines: 2, spin: "normal" }],
      120, 0);
    expect(r.chosenPremium).toBe(2);
    expect(r.maxPremium).toBe(4);
    expect(r.maxPremiumLines).toBe(2);
    expect(r.premiumRegret).toBe(2);
  });
  test("no premium candidate -> D3 flag", () => {
    const r = premiumRegretRow({ aeff: 0, lines: 0 }, [{ aeff: 0, lines: 1 }], 150, 0);
    expect(r.anyPremiumCandidate).toBe(false);
  });
});

describe("stage0 decomposition + judge", () => {
  const mk = (over: Partial<Parameters<typeof premiumRegretRow>[0]>, cands: any[], lock = 120) =>
    premiumRegretRow({ aeff: 0, lines: 0, spin: "none", ...over }, cands, lock, 0);
  test("SB-2 when regret concentrates in lines 1/2", () => {
    const rows = Array.from({ length: 10 }, () =>
      mk({ aeff: 1, lines: 1 }, [{ aeff: 4, lines: 2, spin: "none" }]));
    const d = summarisePremiumBand(rows);
    expect(d.explained).toBe(20);
    const v = judgePremiumStage0([
      { denominator: 30, decomp: d }, { denominator: 30, decomp: d }, { denominator: 30, decomp: d }]);
    expect(v).toBe("SB-2");
  });
  test("SB-3 when candidates absent", () => {
    const rows = Array.from({ length: 10 }, () => mk({}, []));
    const d = summarisePremiumBand(rows);
    const v = judgePremiumStage0([
      { denominator: 40, decomp: d }, { denominator: 40, decomp: d }, { denominator: 40, decomp: d }]);
    expect(v).toBe("SB-3");
  });
});
