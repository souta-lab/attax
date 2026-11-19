import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnPosition } from "../../src/ai/bot/movegen.js";
import { search as sharedSearch } from "../../src/ai/bot/search.js";
import { DEFAULT_WEIGHTS } from "../../src/ai/bot/weights.js";
import { createAttaxDecider, type PublicDecision, projectAttax } from "./attax-player.js";
import { type SearchOptions as S2LabOptions, type SearchInput, toSharedInput } from "./s2-input.js";
import { assessSolvency, DEFAULT_SOLVENCY_PARAMS, solvencyMargin } from "./solvency.js";
import { DEFAULT_STOCK_PARAMS, type StockState, stockPotential } from "./stock.js";

/**
 * The former lab search is the shared core under rules profile "s2": map the
 * lab-shaped input (numeric exact chain in `b2b`) onto the shared input
 * exactly as the player does, then search with profile "s2".
 */
function search(input: SearchInput, options: S2LabOptions) {
  return sharedSearch(toSharedInput(input), { ...options, profile: "s2" });
}

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
      const base = search(input, { width: 96, weights: DEFAULT_WEIGHTS });
      const zeroed = search(input, {
        width: 96,
        weights: DEFAULT_WEIGHTS,
        stock: { ...DEFAULT_STOCK_PARAMS, scale: 0 },
      });
      expect(fingerprint(zeroed)).toBe(fingerprint(base));
    }
  });

  test("stock raises the value of a charged one-piece line by gamma * Phi", () => {
    const input = projectAttax(decision());
    const off = search(input, { width: 96, weights: DEFAULT_WEIGHTS });
    const on = search(input, { width: 96, weights: DEFAULT_WEIGHTS, stock: DEFAULT_STOCK_PARAMS });
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
    writeFileSync(bad1, JSON.stringify({ mechanisms: { warp: {} } }));
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

describe("C2 solvency assessment", () => {
  const params = DEFAULT_SOLVENCY_PARAMS;

  test("no penalty at or above the margin band", () => {
    expect(assessSolvency({ maxHeight: 10, pending: 0 }, params)).toEqual({
      penalty: 0,
      margin: 10,
      doomed: false,
    });
    expect(assessSolvency({ maxHeight: 14, pending: 0 }, params).penalty).toBe(0);
  });

  test("smooth quadratic penalty below the band, before any doom", () => {
    // Margin 4 -> shortfall 2 -> 40 * 4.
    expect(assessSolvency({ maxHeight: 16, pending: 0 }, params).penalty).toBe(160);
    // Pending counts against the margin exactly like height.
    const a = assessSolvency({ maxHeight: 15, pending: 4 }, params);
    expect(a).toEqual({ penalty: 1000, margin: 1, doomed: false });
  });

  test("tank-doomed states are demoted, not removed", () => {
    const a = assessSolvency({ maxHeight: 17, pending: 4 }, params);
    expect(a.doomed).toBe(true);
    expect(a.margin).toBe(-1);
    expect(a.penalty).toBe(40 * 49 + 1_000_000);
    // A worse doom is still worse: the least-bad doomed line ranks first.
    const b = assessSolvency({ maxHeight: 19, pending: 4 }, params);
    expect(b.penalty).toBeGreaterThan(a.penalty);
  });
});

/**
 * Height-16 stack, 4 pending due next lock. Rows 24-25 (from the top) miss
 * exactly columns 8-9, so one O placement completes a double there; every
 * other O placement stacks on top and is tank-doomed (height 18 + 4 > 20).
 */
function cliffInput(): SearchInput {
  const board = new Uint16Array(40);
  for (let r = 26; r < 40; r += 1) board[r] = 0x3ff ^ (1 << 2) ^ (1 << 6);
  board[24] = 0x3ff ^ (1 << 8) ^ (1 << 9);
  board[25] = 0x3ff ^ (1 << 8) ^ (1 << 9);
  const garbageRows = Array.from({ length: 40 }, (_, r) => (r >= 26 ? 1 : 0));
  return {
    board,
    garbageRows,
    active: { kind: "O", ...spawnPosition("O", 40) },
    hold: null,
    canHold: false,
    preview: [],
    b2b: 0,
    combo: -1,
    pending: 4,
    dueThisLock: 0,
    speculativePieces: [],
  };
}

describe("C2 search integration", () => {
  test("absent and zero-coefficient solvency are bit-identical", () => {
    const input = cliffInput();
    const base = search(input, { width: 96, weights: DEFAULT_WEIGHTS });
    const zeroed = search(input, {
      width: 96,
      weights: DEFAULT_WEIGHTS,
      solvency: { ...DEFAULT_SOLVENCY_PARAMS, coefficient: 0 },
    });
    expect(fingerprint(zeroed)).toBe(fingerprint(base));
    const both = search(input, {
      width: 96,
      weights: DEFAULT_WEIGHTS,
      stock: { ...DEFAULT_STOCK_PARAMS, scale: 0 },
      solvency: { ...DEFAULT_SOLVENCY_PARAMS, coefficient: 0 },
    });
    expect(fingerprint(both)).toBe(fingerprint(base));
  });

  test("the solvency layer demotes doomed roots and crowns the surviving clear", () => {
    const input = cliffInput();
    const off = search(input, { width: 96, weights: DEFAULT_WEIGHTS });
    const on = search(input, {
      width: 96,
      weights: DEFAULT_WEIGHTS,
      solvency: DEFAULT_SOLVENCY_PARAMS,
    });
    // Placement x is the piece-box origin: O cells sit at +1/+2, so the
    // notch clear (cells at columns 8-9) is x = 7 and the leftmost
    // stack-top placement (cells at columns 0-1) is x = -1.
    const byX = (r: ReturnType<typeof search>, x: number) =>
      r?.candidates.find((c) => c.placement.x === x)?.value;
    const doomedOff = byX(off, -1);
    const doomedOn = byX(on, -1);
    const survivorOff = byX(off, 7);
    const survivorOn = byX(on, 7);
    expect(doomedOff).toBeDefined();
    expect(survivorOff).toBeDefined();
    // The stack-top root is tank-doomed: its value collapses by the demotion.
    expect((doomedOn ?? 0) - (doomedOff ?? 0)).toBeLessThan(-500_000);
    // The double-clear root only pays its small smooth penalty.
    expect((survivorOn ?? 0) - (survivorOff ?? 0)).toBeGreaterThan(-20_000);
    expect((survivorOn ?? 0) - (survivorOff ?? 0)).toBeLessThan(0);
    // And it becomes the chosen root.
    expect(on?.candidates[0]?.placement.x).toBe(7);
    expect(on?.best.linesCleared).toBe(2);
  });

  test("env switch forces solvency on around a plain profile", () => {
    // The cliff stack as a public decision (rows are top-first cells).
    const cells = Array<string>(400).fill("_");
    for (let y = 0; y < 40; y += 1) {
      const r = 39 - y;
      if (r >= 26) {
        for (let x = 0; x < 10; x += 1) if (x !== 2 && x !== 6) cells[y * 10 + x] = "G";
      } else if (r === 24 || r === 25) {
        for (let x = 0; x < 8; x += 1) cells[y * 10 + x] = "X";
      }
    }
    const d: PublicDecision = {
      board: { width: 10, height: 40, cells: cells.join("") },
      pieces: { current: "O", known: [], hold: null, holdAvailable: false },
      chain: { b2b: 0, combo: 0 },
      incoming: { pendingRows: 4, dueThisLockRows: 0 },
    };
    const dir = mkdtempSync(join(tmpdir(), "s2-ports-test-"));
    const plain = join(dir, "plain.json");
    writeFileSync(plain, JSON.stringify({}));
    try {
      const baseline = createAttaxDecider(plain).decide(d);
      process.env.ATTAX_S2_SOLVENCY = "1";
      const forcedOn = createAttaxDecider(plain).decide(d);
      // The chosen root becomes the surviving double clear; penalties only
      // subtract, so the value never exceeds the unpenalized baseline.
      expect(forcedOn?.best.linesCleared).toBe(2);
      expect(forcedOn?.value).toBeLessThanOrEqual(baseline?.value ?? 0);
    } finally {
      delete process.env.ATTAX_S2_SOLVENCY;
    }
  });
});

/**
 * Height-15 stack (well at column 0, notch at columns 3-4 on the top two
 * rows), 5 pending all due this lock. The value-best root (a hold-J line)
 * is insolvent by the quantity-only margin (20 - height - pending = -1);
 * the first solvent root in rank order is the plain O placement at x = 2
 * (margin 0). Verified against a manual root-lock simulation of expand().
 */
function vetoInput(patch: Partial<SearchInput> = {}): SearchInput {
  const board = new Uint16Array(40);
  for (let r = 25; r < 40; r += 1) board[r] = 0x3ff ^ (1 << 0);
  for (const r of [25, 26]) {
    let row = board[r] as number;
    row &= ~(1 << 3);
    row &= ~(1 << 4);
    board[r] = row;
  }
  return {
    board,
    garbageRows: Array.from({ length: 40 }, (_, r) => (r >= 25 ? 1 : 0)),
    active: { kind: "O", ...spawnPosition("O", 40) },
    hold: "J",
    canHold: true,
    preview: ["T", "I", "O"],
    b2b: 0,
    combo: -1,
    pending: 5,
    dueThisLock: 5,
    speculativePieces: [],
    ...patch,
  };
}

describe("C2 hard root veto (choose_rescue)", () => {
  test("solvencyMargin is the champion's quantity-only arithmetic", () => {
    expect(solvencyMargin({ maxHeight: 17, pending: 4 })).toBe(-1);
    expect(solvencyMargin({ maxHeight: 12, pending: 8 })).toBe(0);
    expect(solvencyMargin({ maxHeight: 4, pending: 0 })).toBe(16);
  });

  test("veto-off is bit-identical (absent vs explicit false)", () => {
    const input = vetoInput();
    const absent = search(input, { width: 96, weights: DEFAULT_WEIGHTS });
    const explicit = search(input, { width: 96, weights: DEFAULT_WEIGHTS, rootVeto: false });
    expect(fingerprint(explicit)).toBe(fingerprint(absent));
  });

  test("insolvent rank 0 is replaced by the first solvent rank, values untouched", () => {
    const input = vetoInput();
    const off = search(input, { width: 96, weights: DEFAULT_WEIGHTS });
    const hard = search(input, { width: 96, weights: DEFAULT_WEIGHTS, rootVeto: true });
    // Rank 0 without the veto: the hold-J line (root margin -1, insolvent).
    expect(off?.best.placement.kind).toBe("J");
    expect(off?.best.placement.rotation).toBe(3);
    expect(off?.best.placement.x).toBe(3);
    expect(off?.best.usedHold).toBe(true);
    // With the veto: the first solvent root in rank order (root margin 0).
    expect(hard?.best.placement.kind).toBe("O");
    expect(hard?.best.placement.rotation).toBe(0);
    expect(hard?.best.placement.x).toBe(2);
    expect(hard?.best.usedHold).toBe(false);
    // The veto is a pure selector: the ranked candidate list is unchanged
    // and the played line keeps its unmodified search value.
    expect(JSON.stringify(hard?.candidates)).toBe(JSON.stringify(off?.candidates));
    const picked = off?.candidates.find(
      (c) =>
        c.placement.kind === hard?.best.placement.kind &&
        c.placement.rotation === hard?.best.placement.rotation &&
        c.placement.x === hard?.best.placement.x &&
        c.usedHold === hard?.best.usedHold,
    );
    expect(picked).toBeDefined();
    expect(off?.candidates.indexOf(picked as never)).toBeGreaterThan(0);
    expect(hard?.value).toBe(picked?.value);
  });

  test("when every root is insolvent, the least-bad line still stands", () => {
    // 30 pending, all due: clearing roots cancel at most a few rows and
    // non-clearing roots tank the full 30 — no root can pay the margin.
    const input = vetoInput({ pending: 30, dueThisLock: 30 });
    const off = search(input, { width: 96, weights: DEFAULT_WEIGHTS });
    const hard = search(input, { width: 96, weights: DEFAULT_WEIGHTS, rootVeto: true });
    expect(off).not.toBeNull();
    expect(fingerprint(hard)).toBe(fingerprint(off));
  });

  test("when rank 0 is solvent, the veto changes nothing", () => {
    const input = projectAttax(decision()); // empty board, no pending
    const off = search(input, { width: 96, weights: DEFAULT_WEIGHTS });
    const hard = search(input, { width: 96, weights: DEFAULT_WEIGHTS, rootVeto: true });
    expect(fingerprint(hard)).toBe(fingerprint(off));
  });

  test("profile solvencyMode parses, validates, and separates identities", () => {
    const dir = mkdtempSync(join(tmpdir(), "s2-veto-test-"));
    const softPath = join(dir, "soft.json");
    writeFileSync(
      softPath,
      JSON.stringify({ mechanisms: { stock: {}, solvency: { ...DEFAULT_SOLVENCY_PARAMS } } }),
    );
    const hardPath = join(dir, "hard.json");
    writeFileSync(
      hardPath,
      JSON.stringify({
        mechanisms: {
          stock: {},
          solvency: { ...DEFAULT_SOLVENCY_PARAMS },
          solvencyMode: "hard",
        },
      }),
    );
    const soft = createAttaxDecider(softPath);
    const hard = createAttaxDecider(hardPath);
    expect(hard.mechanisms.solvencyMode).toBe("hard");
    expect(soft.mechanisms.solvencyMode).toBeUndefined();
    expect(hard.profileId).not.toBe(soft.profileId);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ mechanisms: { solvencyMode: "banana" } }));
    expect(() => createAttaxDecider(bad)).toThrow("solvencyMode");
  });

  test("hard profile and env mode reproduce the search-level veto exactly", () => {
    // The vetoInput stack as a public decision (filled cells are garbage).
    const input = vetoInput();
    const cells = Array<string>(400).fill("_");
    for (let y = 0; y < 40; y += 1) {
      const row = input.board[39 - y] as number;
      for (let x = 0; x < 10; x += 1) if ((row & (1 << x)) !== 0) cells[y * 10 + x] = "G";
    }
    const d: PublicDecision = {
      board: { width: 10, height: 40, cells: cells.join("") },
      pieces: { current: "O", known: ["T", "I", "O"], hold: "J", holdAvailable: true },
      chain: { b2b: 0, combo: 0 },
      incoming: { pendingRows: 5, dueThisLockRows: 5 },
    };
    const expected = search(input, { width: 96, weights: DEFAULT_WEIGHTS, rootVeto: true });
    const dir = mkdtempSync(join(tmpdir(), "s2-veto-test-"));
    const hardPath = join(dir, "hard.json");
    writeFileSync(hardPath, JSON.stringify({ mechanisms: { solvencyMode: "hard" } }));
    const viaProfile = createAttaxDecider(hardPath).decide(d);
    expect(viaProfile?.best.placement).toEqual(expected?.best.placement);
    expect(viaProfile?.value).toBe(expected?.value);
    // Env force: hard around a plain profile; SOLVENCY=0 overrides the mode.
    const plain = join(dir, "plain.json");
    writeFileSync(plain, JSON.stringify({}));
    try {
      process.env.ATTAX_S2_SOLVENCY_MODE = "hard";
      const viaEnv = createAttaxDecider(plain).decide(d);
      expect(viaEnv?.best.placement).toEqual(expected?.best.placement);
      process.env.ATTAX_S2_SOLVENCY = "0";
      const forcedOff = createAttaxDecider(plain).decide(d);
      const off = search(input, { width: 96, weights: DEFAULT_WEIGHTS });
      expect(forcedOff?.best.placement).toEqual(off?.best.placement);
    } finally {
      delete process.env.ATTAX_S2_SOLVENCY_MODE;
      delete process.env.ATTAX_S2_SOLVENCY;
    }
  });
});
