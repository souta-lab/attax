import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WEIGHTS } from "../../src/ai/bot/weights.js";
import { createAttaxDecider, type PublicDecision, projectAttax } from "./attax-player.js";
import { search } from "./search.js";
import { DEFAULT_STOCK_PARAMS, type StockState, stockPotential } from "./stock.js";

const ATTACK = DEFAULT_WEIGHTS.attack;
const GAMMA = DEFAULT_WEIGHTS.discount;

function stockState(patch: Partial<StockState> = {}): StockState {
  return {
    chain: 0,
    combo: -1,
    pending: 0,
    maxHeight: 4,
    tSlot: 0,
    wellDepth: 0,
    multiplier: 1,
    ...patch,
  };
}

describe("C1 stock potential", () => {
  test("no cashable surge at chain <= 4", () => {
    const params = { scale: 1, betaB: 0, betaR: 0 };
    expect(stockPotential(stockState({ chain: 4 }), params, ATTACK, GAMMA)).toBe(0);
    expect(stockPotential(stockState({ chain: 0 }), params, ATTACK, GAMMA)).toBe(0);
  });

  test("cashable surge pays q_B * S(d, m) * w_A on a safe board", () => {
    const params = { scale: 1, betaB: 0, betaR: 0 };
    // d = 6 -> S = 5 rows; height 4, no pending -> q_B = 1.
    expect(stockPotential(stockState({ chain: 6 }), params, ATTACK, GAMMA)).toBeCloseTo(
      5 * ATTACK,
      10,
    );
    // The margin multiplier scales the cashable rows like the award does.
    expect(
      stockPotential(stockState({ chain: 6, multiplier: 2 }), params, ATTACK, GAMMA),
    ).toBeCloseTo(10 * ATTACK, 10);
  });

  test("height does not erase cashable surge; it discounts it via q_B", () => {
    const params = { scale: 1, betaB: 0, betaR: 0 };
    // Height 13: q_B = (18 - 13) / 8 = 0.625, still positive above height 8.
    const phi = stockPotential(stockState({ chain: 6, maxHeight: 13 }), params, ATTACK, GAMMA);
    expect(phi).toBeCloseTo(0.625 * 5 * ATTACK, 10);
    expect(phi).toBeGreaterThan(0);
  });

  test("speculative growth is gated to zero under heavy pressure", () => {
    const params = { scale: 1, betaB: 1, betaR: 1 };
    // Chain 3 has no cashable surge; growth terms die when the worst margin
    // (20 - 10 - 12) is negative, whatever the REN chain is doing.
    const phi = stockPotential(
      stockState({ chain: 3, combo: 5, maxHeight: 10, pending: 12 }),
      params,
      ATTACK,
      GAMMA,
    );
    expect(phi).toBe(0);
  });

  test("REN continuation value matches the K=3 counterfactual on the combo rule", () => {
    const params = { scale: 1, betaB: 0, betaR: 1 };
    // combo 3, safe board (g = 1): increments are 1 row at each of 3 steps.
    const phi = stockPotential(stockState({ combo: 3 }), params, ATTACK, GAMMA);
    expect(phi).toBeCloseTo(ATTACK * (1 + GAMMA + GAMMA ** 2), 10);
    // No active chain -> no REN value.
    expect(stockPotential(stockState({ combo: -1 }), params, ATTACK, GAMMA)).toBe(0);
  });

  test("chain growth option pays the surge increment at the threshold", () => {
    const params = { scale: 1, betaB: 1, betaR: 0 };
    // d = 4 -> S jumps 0 -> 4 at d = 5; T-slot ready (opportunity 1), g = 1.
    const phi = stockPotential(stockState({ chain: 4, tSlot: 2 }), params, ATTACK, GAMMA);
    expect(phi).toBeCloseTo(4 * ATTACK, 10);
  });
});

function decision(patch: Partial<PublicDecision> = {}): PublicDecision {
  return {
    board: { width: 10, height: 40, cells: "_".repeat(400) },
    pieces: { current: "I", known: [], hold: null, holdAvailable: false },
    chain: { b2b: 6, combo: 0 },
    incoming: { pendingRows: 0, dueThisLockRows: 0 },
    ...patch,
  };
}

function fingerprint(result: ReturnType<typeof search>) {
  return JSON.stringify({
    best: result?.best.placement,
    usedHold: result?.best.usedHold,
    value: result?.value,
    candidates: result?.candidates,
  });
}

describe("C1 search integration", () => {
  const inputs = [
    projectAttax(decision()), // charged chain on an empty board
    projectAttax(
      decision({
        chain: { b2b: 2, combo: 7 },
        incoming: { pendingRows: 9, dueThisLockRows: 3 },
        pieces: { current: "T", known: ["S", "Z", "L"], hold: "J", holdAvailable: true },
      }),
    ),
    projectAttax(
      decision({
        chain: { b2b: 0, combo: 0 },
        pieces: { current: "O", known: ["I", "T"], hold: null, holdAvailable: false },
      }),
    ),
  ];

  test("absent and zero-scaled stock are bit-identical", () => {
    for (const input of inputs) {
      const base = search(input, { width: 48, weights: DEFAULT_WEIGHTS });
      const zeroed = search(input, {
        width: 48,
        weights: DEFAULT_WEIGHTS,
        stock: { ...DEFAULT_STOCK_PARAMS, scale: 0 },
      });
      expect(fingerprint(zeroed)).toBe(fingerprint(base));
    }
  });

  test("stock raises the value of a charged one-piece line by gamma * Phi", () => {
    const input = projectAttax(decision());
    const off = search(input, { width: 48, weights: DEFAULT_WEIGHTS });
    const on = search(input, { width: 48, weights: DEFAULT_WEIGHTS, stock: DEFAULT_STOCK_PARAMS });
    expect(on?.best.placement).toEqual(off?.best.placement);
    // Every child keeps chain 6 on an empty board: Phi = w_A * (5 + 0.5 * 0.35).
    const expected = GAMMA * ATTACK * (5 + 0.5 * 0.35);
    expect((on?.value ?? 0) - (off?.value ?? 0)).toBeCloseTo(expected, 6);
  });
});

describe("C1 profile and env wiring", () => {
  test("profile mechanisms section fills defaults and stays out of the weights", () => {
    const dir = mkdtempSync(join(tmpdir(), "s2-ports-test-"));
    const path = join(dir, "profile.json");
    writeFileSync(path, JSON.stringify({ attack: 99, mechanisms: { stock: { betaB: 0.25 } } }));
    const decider = createAttaxDecider(path);
    expect(decider.weights.attack).toBe(99);
    expect(decider.mechanisms.stock).toEqual({ scale: 1, betaB: 0.25, betaR: 0.5 });
    expect(decider.profileId).toMatch(/^[0-9a-f]{16}$/);
  });

  test("unknown mechanism keys and parameters fail loudly", () => {
    const dir = mkdtempSync(join(tmpdir(), "s2-ports-test-"));
    const bad1 = join(dir, "bad1.json");
    writeFileSync(bad1, JSON.stringify({ mechanisms: { solvency: {} } }));
    expect(() => createAttaxDecider(bad1)).toThrow("unknown mechanism");
    const bad2 = join(dir, "bad2.json");
    writeFileSync(bad2, JSON.stringify({ mechanisms: { stock: { nope: 1 } } }));
    expect(() => createAttaxDecider(bad2)).toThrow("unknown mechanism parameter");
  });

  test("env switch forces stock off and on around the profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "s2-ports-test-"));
    const withStock = join(dir, "stock.json");
    writeFileSync(withStock, JSON.stringify({ mechanisms: { stock: {} } }));
    const plain = join(dir, "plain.json");
    writeFileSync(plain, JSON.stringify({}));
    const d = decision();
    try {
      process.env.ATTAX_S2_STOCK_POTENTIAL = "0";
      const forcedOff = createAttaxDecider(withStock).decide(d);
      const baseline = createAttaxDecider(plain).decide(d);
      expect(forcedOff?.value).toBe(baseline?.value);
      process.env.ATTAX_S2_STOCK_POTENTIAL = "1";
      const forcedOn = createAttaxDecider(plain).decide(d);
      expect(forcedOn?.value).toBeGreaterThan(baseline?.value ?? 0);
    } finally {
      delete process.env.ATTAX_S2_STOCK_POTENTIAL;
    }
  });
});
