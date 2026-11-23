import { describe, expect, test } from "bun:test";
import {
  judgeHs1,
  summariseHs1Decomposition,
  supplyRegretRow,
  type SupplySearchLike,
} from "./regret.js";

function row(
  lock: number,
  pending: number,
  best: SupplySearchLike["best"],
  candidates: SupplySearchLike["candidates"],
) {
  const r = supplyRegretRow({ best, candidates }, lock, pending);
  if (!r) throw new Error("row null");
  return r;
}

describe("HS1 stage-0 row additions", () => {
  test("spin candidate presence is recorded independently of argmax", () => {
    const r = row(15, 0, { attack: 2, linesCleared: 2, spin: "none" }, [
      { attack: 2, linesCleared: 2, spin: "none" },
      { attack: 1, linesCleared: 1, spin: "mini" },
    ]);
    expect(r.spinCandidateCount).toBe(1);
    expect(r.anySpinCandidate).toBe(true);
    expect(r.missedSpinPremiumAeff).toBe(false); // argmax is not spin
  });
  test("missedSpinPremiumAeff fires on Aeff-argmax spin miss", () => {
    const r = row(15, 0, { attack: 1, linesCleared: 1, spin: "none" }, [
      { attack: 1, linesCleared: 1, spin: "none" },
      { attack: 4, linesCleared: 1, spin: "full" },
    ]);
    expect(r.missedSpinPremiumAeff).toBe(true);
  });
});

describe("summariseHs1Decomposition", () => {
  const rows = [
    // D1: chosen 0, candidate max 3 (single)
    row(12, 0, { attack: 0, linesCleared: 0, spin: "none" }, [
      { attack: 0, linesCleared: 0, spin: "none" },
      { attack: 3, linesCleared: 1, spin: "none" },
    ]),
    // D2 spin miss: chosen 1, spin candidate 4
    row(22, 2, { attack: 1, linesCleared: 1, spin: "none" }, [
      { attack: 1, linesCleared: 1, spin: "none" },
      { attack: 4, linesCleared: 1, spin: "full" },
    ]),
    // D3: no candidate clears, no spin candidate
    row(32, 0, { attack: 0, linesCleared: 0, spin: "none" }, [
      { attack: 0, linesCleared: 0, spin: "none" },
    ]),
    // clean turn: chosen is the max, spin candidate present
    row(25, 0, { attack: 4, linesCleared: 1, spin: "full" }, [
      { attack: 4, linesCleared: 1, spin: "full" },
      { attack: 1, linesCleared: 1, spin: "none" },
    ]),
  ];
  const d = summariseHs1Decomposition(rows);
  test("D1/D2/D3 split", () => {
    expect(d.turns).toBe(4);
    expect(d.d1.turns).toBe(1);
    expect(d.d1.sumMaxAeff).toBe(3);
    expect(d.d1.bySubBand["10-19"]?.turns).toBe(1);
    expect(d.d1.byMaxLines["1"]?.turns).toBe(1);
    expect(d.d2.turns).toBe(2);
    expect(d.d2.sumAeffRegret).toBe(3);
    expect(d.d2.spinMissTurns).toBe(1);
    expect(d.d2.spinMissAeffRegret).toBe(3);
    expect(d.d2.opportunity.turns).toBe(1); // only the pending=2 row
    expect(d.d3.noCandidateTurns).toBe(1);
    expect(d.d3.noSpinCandidateTurns).toBe(2); // D1 row + D3 row have no spin candidate
    expect(d.d3.absentTurns).toBe(2);
  });
  test("coverage: D1 + D2 + no-candidate-chosen0 turns = all turns", () => {
    const neither = rows.filter((r) => r.chosenAeff === 0 && r.maxCandidateAeff === 0).length;
    expect(d.d1.turns + d.d2.turns + neither).toBe(d.turns);
  });
});

describe("judgeHs1 (§3.2, gap=580, half=290)", () => {
  const base = summariseHs1Decomposition([]);
  test("D1 over half -> HS1-A", () => {
    const d = structuredClone(base);
    d.d1.sumMaxAeff = 300;
    expect(judgeHs1(d, 580)).toBe("HS1-A");
  });
  test("D1+D2 over half with spin-majority D2 -> HS1-A-spin", () => {
    const d = structuredClone(base);
    d.d1.sumMaxAeff = 100;
    d.d2.sumAeffRegret = 200;
    d.d2.spinMissAeffRegret = 150;
    expect(judgeHs1(d, 580)).toBe("HS1-A-spin");
  });
  test("spin-present pool over half -> HS1-C", () => {
    const d = structuredClone(base);
    d.d1.sumMaxAeff = 10;
    d.d2.sumAeffRegret = 10;
    d.spinPresentRegret.sumAeffRegret = 300;
    expect(judgeHs1(d, 580)).toBe("HS1-C");
  });
  test("no-spin majority -> HS1-B", () => {
    const d = structuredClone(base);
    d.d3.noSpinShare = 0.8;
    expect(judgeHs1(d, 580)).toBe("HS1-B");
  });
});
