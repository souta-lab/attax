import { describe, expect, test } from "bun:test";
import { DEFAULT_WEIGHTS } from "../../src/ai/bot/weights.js";
import { projectAttax, type PublicDecision } from "./attax-player.js";
import {
  isSupplyTurn,
  outgoingOf,
  summariseSupplyRegret,
  supplyRegretRow,
  type SupplySearchLike,
} from "./regret.js";
import { search } from "./search.js";

function synthetic(
  best: SupplySearchLike["best"],
  candidates: SupplySearchLike["candidates"],
): SupplySearchLike {
  return { best, candidates };
}

describe("supply instrument scope", () => {
  test("band is locks 10-39, all turns regardless of pending", () => {
    expect(isSupplyTurn(9)).toBe(false);
    expect(isSupplyTurn(10)).toBe(true);
    expect(isSupplyTurn(39)).toBe(true);
    expect(isSupplyTurn(40)).toBe(false);
    // Unlike the opportunity instrument, pending = 0 still records.
    const r = supplyRegretRow(
      synthetic({ attack: 1, linesCleared: 1, spin: "none" }, [
        { attack: 1, linesCleared: 1, spin: "none" },
      ]),
      25,
      0,
    );
    expect(r).not.toBeNull();
    expect(r?.opportunity).toBe(false);
    // Out of band records nothing.
    expect(
      supplyRegretRow(synthetic({ attack: 1, linesCleared: 1 }, [{ attack: 1, linesCleared: 1 }]), 40, 0),
    ).toBeNull();
  });

  test("outgoing is the post-cancel sent amount", () => {
    expect(outgoingOf(7, 5)).toBe(2);
    expect(outgoingOf(3, 5)).toBe(0);
    expect(outgoingOf(4, 0)).toBe(4);
  });
});

describe("supply regret decomposition", () => {
  test("supply regret separates the cancel-absorbed part", () => {
    // pending 5: chosen attack 3 sends nothing; best attack 7 sends 2.
    // Aeff regret 4 = supply regret 2 + cancel-absorbed 2.
    const row = supplyRegretRow(
      synthetic({ attack: 3, linesCleared: 1, spin: "none" }, [
        { attack: 3, linesCleared: 1, spin: "none" },
        { attack: 7, linesCleared: 1, spin: "full" },
        { attack: 4, linesCleared: 2, spin: "none" },
      ]),
      22,
      5,
      3,
    );
    expect(row).not.toBeNull();
    if (!row) return;
    expect(row.chosenOutgoing).toBe(0);
    expect(row.maxCandidateOutgoing).toBe(2);
    expect(row.supplyRegret).toBe(2);
    expect(row.aeffRegret).toBe(4);
    expect(row.cancelAbsorbedRegret).toBe(2);
    expect(row.missedSend).toBe(true);
    expect(row.maxOutgoingSpin).toBe("normal"); // trace vocabulary for "full"
    expect(row.missedSpinPremium).toBe(true);
    expect(row.opponentPendingBefore).toBe(3);
    expect(row.sendingCandidateCount).toBe(1);
  });

  test("gap fully inside the cancel region is not supply regret", () => {
    // pending 9: attacks 2 vs 5 both send nothing -> supply regret 0,
    // the whole Aeff gap is cancel-absorbed (processing side).
    const row = supplyRegretRow(
      synthetic({ attack: 2, linesCleared: 1, spin: "none" }, [
        { attack: 2, linesCleared: 1, spin: "none" },
        { attack: 5, linesCleared: 2, spin: "mini" },
      ]),
      15,
      9,
    );
    expect(row?.supplyRegret).toBe(0);
    expect(row?.aeffRegret).toBe(3);
    expect(row?.cancelAbsorbedRegret).toBe(3);
    expect(row?.missedSend).toBe(false);
    expect(row?.missedSpinPremium).toBe(false);
  });

  test("summary splits by sub-band, lines, spin and opponent pending", () => {
    const mk = (lock: number, pending: number, opp: number | null, bestAtk: number, maxAtk: number) =>
      supplyRegretRow(
        synthetic({ attack: bestAtk, linesCleared: 1, spin: "none" }, [
          { attack: bestAtk, linesCleared: 1, spin: "none" },
          { attack: maxAtk, linesCleared: 2, spin: "full" },
        ]),
        lock,
        pending,
        opp,
      );
    const rows = [mk(12, 0, 2, 0, 3), mk(25, 0, 0, 1, 1), mk(35, 4, null, 0, 6)].filter(
      (r) => r !== null,
    );
    const s = summariseSupplyRegret(rows);
    expect(s.turns).toBe(3);
    expect(s.totalSupplyRegret).toBe(3 + 0 + 2);
    expect(s.bySubBand["10-19"]?.totalSupplyRegret).toBe(3);
    expect(s.bySubBand["30-39"]?.totalSupplyRegret).toBe(2);
    expect(s.byChosenLines["1"]?.turns).toBe(3);
    expect(s.byMaxOutgoingSpin["normal"]?.turns).toBe(2);
    expect(s.opponentPending.knownTurns).toBe(2);
    expect(s.opponentPending.withPending.totalSupplyRegret).toBe(3);
    expect(s.missedSendTurns).toBe(2);
  });
});

describe("supply instrument on a real search", () => {
  function decision(pending: number): PublicDecision {
    return {
      board: { width: 10, height: 40, cells: "_".repeat(400) },
      pieces: { current: "I", known: ["O", "T"], hold: "S", holdAvailable: false },
      chain: { b2b: 0, combo: 0 },
      incoming: { pendingRows: pending, dueThisLockRows: 0 },
    };
  }

  test("candidates carry spin and the row is internally consistent", () => {
    const input = projectAttax(decision(0));
    const result = search(input, { width: 48, weights: DEFAULT_WEIGHTS });
    expect(result).not.toBeNull();
    if (!result) return;
    for (const c of result.candidates) {
      expect(["none", "mini", "full"]).toContain(c.spin);
    }
    const row = supplyRegretRow(result, 20, 0);
    expect(row).not.toBeNull();
    if (!row) return;
    expect(row.chosenAeff).toBe(result.best.attack);
    expect(row.maxCandidateAeff).toBe(Math.max(...result.candidates.map((c) => c.attack)));
    expect(row.supplyRegret).toBe(row.maxCandidateOutgoing - row.chosenOutgoing);
    expect(row.supplyRegret).toBeGreaterThanOrEqual(0);
    expect(row.aeffRegret).toBeGreaterThanOrEqual(row.supplyRegret);
    expect(row.opponentPendingBefore).toBeNull(); // search cannot know it
  });
});
