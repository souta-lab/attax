import { describe, expect, test } from "bun:test";
import { DEFAULT_WEIGHTS } from "../../src/ai/bot/weights.js";
import { projectAttax, type PublicDecision } from "./attax-player.js";
import { isOpportunityTurn, regretRow, summariseRegret } from "./regret.js";
import { search } from "./search.js";

function decision(pending: number): PublicDecision {
  return {
    board: { width: 10, height: 40, cells: "_".repeat(400) },
    pieces: { current: "I", known: ["O", "T"], hold: "S", holdAvailable: false },
    chain: { b2b: 0, combo: 0 },
    incoming: { pendingRows: pending, dueThisLockRows: 0 },
  };
}

describe("regret instrument scope", () => {
  test("band is locks 10-29 and pending > 0 only", () => {
    expect(isOpportunityTurn(9, 3)).toBe(false);
    expect(isOpportunityTurn(10, 3)).toBe(true);
    expect(isOpportunityTurn(29, 1)).toBe(true);
    expect(isOpportunityTurn(30, 3)).toBe(false);
    expect(isOpportunityTurn(15, 0)).toBe(false);
  });
});

describe("regret instrument on a real search", () => {
  test("candidates carry attack/lines and regret is consistent", () => {
    const input = projectAttax(decision(6));
    const result = search(input, { width: 48, weights: DEFAULT_WEIGHTS });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const c of result.candidates) {
      expect(Number.isFinite(c.attack)).toBe(true);
      expect(c.attack).toBeGreaterThanOrEqual(0);
    }
    // best is one of the candidates: its attack must appear in the set.
    expect(result.candidates.some((c) => c.attack === result.best.attack)).toBe(true);
    const row = regretRow(result, 15, 6);
    expect(row).not.toBeNull();
    if (!row) return;
    expect(row.chosenAeff).toBe(result.best.attack);
    expect(row.maxCandidateAeff).toBe(Math.max(...result.candidates.map((c) => c.attack)));
    expect(row.regret).toBe(row.maxCandidateAeff - row.chosenAeff);
    expect(row.regret).toBeGreaterThanOrEqual(0);
    // Out-of-band / no-pending turns record nothing.
    expect(regretRow(result, 5, 6)).toBeNull();
    expect(regretRow(result, 15, 0)).toBeNull();
  });

  test("summary aggregates band totals", () => {
    const s = summariseRegret([
      { lockIndex: 10, pendingBefore: 2, chosenAeff: 0, maxCandidateAeff: 2, regret: 2, chosenLines: 0, maxCandidateLines: 1, candidateCount: 5 },
      { lockIndex: 11, pendingBefore: 2, chosenAeff: 1, maxCandidateAeff: 1, regret: 0, chosenLines: 1, maxCandidateLines: 1, candidateCount: 5 },
    ]);
    expect(s.turns).toBe(2);
    expect(s.totalRegret).toBe(2);
    expect(s.meanRegret).toBe(1);
    expect(s.positiveShare).toBe(0.5);
  });
});
