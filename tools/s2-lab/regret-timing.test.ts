import { describe, expect, test } from "bun:test";
import { DEFAULT_WEIGHTS } from "../../src/ai/bot/weights.js";
import { projectAttax, type PublicDecision } from "./attax-player.js";
import {
  summariseTimingRegret,
  timingRegretRow,
  type TimingSearchLike,
} from "./regret.js";
import { search } from "./search.js";

function synthetic(
  value: number,
  bestAttack: number,
  candidates: TimingSearchLike["candidates"],
): TimingSearchLike {
  return { value, best: { attack: bestAttack }, candidates };
}

describe("timing regret components (ALIGN-DESIGN §3.2)", () => {
  test("window-in: opponent pending > 0 counts maxOutgoing - chosenOutgoing", () => {
    // pendingBefore (own) 1: chosen attack 2 sends 1; best attack 5 sends 4.
    const row = timingRegretRow(
      synthetic(100, 2, [
        { attack: 2, value: 100 },
        { attack: 5, value: 90 },
        { attack: 0, value: 95 },
      ]),
      15,
      1,
      3,
    );
    expect(row).not.toBeNull();
    if (!row) return;
    expect(row.chosenOutgoing).toBe(1);
    expect(row.maxCandidateOutgoing).toBe(4);
    expect(row.timingRegretIn).toBe(3);
    expect(row.windowOutStake).toBe(0);
    expect(row.maxOutgoingValueRank).toBe(1);
    expect(row.maxOutgoingValueLoss).toBe(10);
  });

  test("window-out: stake recorded, zero-outgoing alternative loss is the minimum", () => {
    const row = timingRegretRow(
      synthetic(100, 4, [
        { attack: 4, value: 100 },
        { attack: 1, value: 80 }, // outgoing 0 only because own pending is 1... see below
        { attack: 0, value: 97 },
        { attack: 0, value: 88 },
      ]),
      5,
      0,
      0,
    );
    expect(row).not.toBeNull();
    if (!row) return;
    // own pending 0: attack 1 sends 1, so zero-outgoing candidates are attack 0.
    expect(row.hasZeroOutgoingCandidate).toBe(true);
    expect(row.bestZeroOutgoingValueLoss).toBe(3);
    expect(row.windowOutStake).toBe(4);
    expect(row.timingRegretIn).toBe(0);
  });

  test("unknown opponent pending: row recorded, both components zero", () => {
    const row = timingRegretRow(synthetic(10, 3, [{ attack: 3, value: 10 }]), 12, 0, null);
    expect(row?.opponentPendingBefore).toBeNull();
    expect(row?.timingRegretIn).toBe(0);
    expect(row?.windowOutStake).toBe(0);
  });

  test("no candidates -> null; band is a summary concern, not a recording one", () => {
    expect(timingRegretRow(synthetic(0, 0, []), 10, 0, 0)).toBeNull();
    const late = timingRegretRow(synthetic(10, 1, [{ attack: 1, value: 10 }]), 55, 0, 2);
    expect(late).not.toBeNull(); // recorded even outside locks 0-39
  });
});

describe("timing summary and the §3.2 verdict bands", () => {
  function rows() {
    return [
      // window-in turn: regret 3
      timingRegretRow(synthetic(100, 2, [{ attack: 2, value: 100 }, { attack: 5, value: 90 }]), 15, 1, 3)!,
      // window-out turn: stake 4, zero-alt loss 3
      timingRegretRow(
        synthetic(100, 4, [{ attack: 4, value: 100 }, { attack: 0, value: 97 }]),
        5,
        0,
        0,
      )!,
      // window-out turn: stake 6, no zero-outgoing alternative
      timingRegretRow(synthetic(100, 6, [{ attack: 6, value: 100 }, { attack: 2, value: 90 }]), 25, 0, 0)!,
    ];
  }

  test("threshold filters the window-out component only", () => {
    const loose = summariseTimingRegret(rows(), Number.POSITIVE_INFINITY);
    expect(loose.timingRegretIn).toBe(3);
    expect(loose.timingRegretOut).toBe(4); // second window-out turn has no zero alt
    expect(loose.windowOutOutgoing).toBe(10);
    expect(loose.shareOfWindowOut).toBeCloseTo(0.7);
    expect(loose.verdictBand).toBe("on1");

    const strict = summariseTimingRegret(rows(), 0);
    expect(strict.timingRegretOut).toBe(0); // zero-alt loss 3 > 0
    expect(strict.timingRegretTotal).toBe(3);
    expect(strict.shareOfWindowOut).toBeCloseTo(0.3);
  });

  test("verdict bands follow the fixed §3.2 thresholds", () => {
    const small = [
      timingRegretRow(synthetic(100, 20, [{ attack: 20, value: 100 }]), 5, 0, 0)!,
      timingRegretRow(synthetic(100, 1, [{ attack: 1, value: 100 }, { attack: 2, value: 99 }]), 6, 0, 1)!,
    ];
    const s = summariseTimingRegret(small, Number.POSITIVE_INFINITY);
    expect(s.shareOfWindowOut).toBeCloseTo(1 / 20);
    expect(s.verdictBand).toBe("close");
  });
});

describe("timing instrument on a real search", () => {
  test("row is internally consistent with the search result", () => {
    const decision: PublicDecision = {
      board: { width: 10, height: 40, cells: "_".repeat(400) },
      pieces: { current: "I", known: ["O", "T"], hold: "S", holdAvailable: false },
      chain: { b2b: 0, combo: 0 },
      incoming: { pendingRows: 0, dueThisLockRows: 0 },
    };
    const result = search(projectAttax(decision), { width: 48, weights: DEFAULT_WEIGHTS });
    expect(result).not.toBeNull();
    if (!result) return;
    const row = timingRegretRow(result, 20, 0, 2);
    expect(row).not.toBeNull();
    if (!row) return;
    expect(row.chosenOutgoing).toBe(Math.max(0, result.best.attack));
    expect(row.maxCandidateOutgoing).toBe(Math.max(...result.candidates.map((c) => Math.max(0, c.attack))));
    expect(row.timingRegretIn).toBe(row.maxCandidateOutgoing - row.chosenOutgoing);
    expect(row.timingRegretIn).toBeGreaterThanOrEqual(0);
    expect(row.maxOutgoingValueLoss).toBeGreaterThanOrEqual(0);
    expect(result.candidates[row.maxOutgoingValueRank]?.value).toBe(result.value - row.maxOutgoingValueLoss);
  });
});
