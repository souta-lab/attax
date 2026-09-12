import { describe, expect, test } from "bun:test";
import { createDeepSeekTetris } from "../src/ai/deepseek.js";
import { createEngine } from "../src/core/engine.js";
import { mutate } from "../src/tuner/evolution.js";
import {
  BASELINE_GENOME,
  decodeGenome,
  GENE_SPECS,
  geneSpec,
  sanitizeGenome,
} from "../src/tuner/genome.js";
import {
  fitnessOf,
  type MatchOutcome,
  runTunerMatch,
  type SideMetrics,
  summarize,
  winLossCap,
} from "../src/tuner/match.js";
import { createRng } from "../src/tuner/rng.js";
import { seedGenomes } from "../src/tuner/seeds.js";
import { createTunedDeepSeek } from "../src/tuner/tuned-deepseek.js";
import { seededRandom, type VersusFighter } from "../src/versus/controller.js";

const COLOR = "#fff";

describe("genome", () => {
  test("baseline decodes to the deepseek.ts constants", () => {
    const params = decodeGenome(BASELINE_GENOME);
    expect(params.weights).toEqual({
      landingHeight: -4.5,
      erodedCells: 3.4,
      rowTransitions: -3.2,
      colTransitions: -9.35,
      holes: -14.5,
      wells: -11,
      holeDepth: -2,
      rowsWithHoles: -26,
      bumpiness: -1.5,
      maxHeight: -3.6,
      linesCleared: 200,
    });
    expect(params.fire).toEqual({
      tetris: 390,
      tspin: 121,
      tspinSingle: 0,
      tspinDouble: 289,
      tspinTriple: 481,
      b2bBonus: 104,
      comboStep: 150,
      perfectClear: 999,
      wellStep: 7,
      tslotStep: 42,
    });
    expect(params.personality.ATK_W).toBe(142);
    expect(params.search).toEqual({ depth: 6, width: 24, topK: 16 });
  });

  test("sanitize clamps out-of-range and fills missing genes", () => {
    const sanitized = sanitizeGenome({ "w.holes": 999, "w.wells": -1000 });
    expect(sanitized["w.holes"]).toBe(geneSpec("w.holes").max);
    expect(sanitized["w.wells"]).toBe(geneSpec("w.wells").min);
    // Missing key falls back to baseline.
    expect(sanitized["p.ATK_W"]).toBe(BASELINE_GENOME["p.ATK_W"]);
    // JSON round-trips deterministically.
    expect(JSON.parse(JSON.stringify(sanitized))).toEqual(sanitized);
  });
});

describe("baseline genome fighter", () => {
  test("decides identically to createDeepSeekTetris across evolving boards", () => {
    const reference = createDeepSeekTetris();
    const tuned = createTunedDeepSeek(BASELINE_GENOME);
    const engine = createEngine({ random: seededRandom(424242) });
    let compared = 0;
    for (let step = 0; step < 24; step += 1) {
      const snapshot = engine.getSnapshot();
      if (snapshot.active === null || snapshot.gameOver) break;
      const expected = reference.findBestMove(snapshot);
      const actual = tuned.findBestMove(snapshot);
      expect(actual).toEqual(expected);
      if (actual !== null) compared += 1;
      engine.hardDrop();
    }
    expect(compared).toBeGreaterThanOrEqual(8);
  });
});

describe("match runner", () => {
  test("is deterministic for a fixed seed", { timeout: 120000 }, () => {
    const make = (): VersusFighter => ({ ...createTunedDeepSeek(BASELINE_GENOME), color: COLOR });
    const a = runTunerMatch(7, make(), make(), 240);
    const b = runTunerMatch(7, make(), make(), 240);
    expect(a).toEqual(b);
  });

  test("summary counts winners and fitness prefers more wins", () => {
    const rows = [
      outcome(1, "left"),
      outcome(2, "left"),
      outcome(3, "right"),
      outcome(4, "draw"),
      outcome(5, "cap"),
    ];
    const summary = summarize(rows);
    expect(summary.leftWins).toBe(2);
    expect(summary.rightWins).toBe(1);
    expect(summary.draws).toBe(1);
    expect(summary.caps).toBe(1);
    expect(summary.winRate).toBeCloseTo((2 + 0.5 * 2) / 5, 10);
    expect(winLossCap(summary)).toBe("2-1-1/1");
    const better = summarize([
      outcome(1, "left"),
      outcome(2, "left"),
      outcome(3, "left"),
      outcome(4, "left"),
    ]);
    expect(fitnessOf(better)).toBeGreaterThan(fitnessOf(summary));
  });
});

describe("seed population", () => {
  test("curated screening seeds stay within gene bounds", () => {
    const seeds = seedGenomes();
    expect(seeds.length).toBeGreaterThanOrEqual(6);
    for (const genome of seeds) {
      for (const spec of GENE_SPECS) {
        const value = genome[spec.key];
        expect(value).toBeGreaterThanOrEqual(spec.min);
        expect(value).toBeLessThanOrEqual(spec.max);
      }
      expect(genome).not.toEqual(BASELINE_GENOME);
    }
  });
});

describe("evolution operators", () => {
  test("mutate is deterministic and stays within gene bounds", () => {
    const a = mutate(BASELINE_GENOME, createRng(1234), 1);
    const b = mutate(BASELINE_GENOME, createRng(1234), 1);
    expect(a).toEqual(b);
    expect(a).not.toEqual(BASELINE_GENOME);
    for (const [key, value] of Object.entries(a)) {
      const spec = geneSpec(key);
      expect(value).toBeGreaterThanOrEqual(spec.min);
      expect(value).toBeLessThanOrEqual(spec.max);
    }
    const scaled = mutate(BASELINE_GENOME, createRng(1234), 0.5);
    expect(scaled).not.toEqual(a);
  });
});

function outcome(seed: number, winner: MatchOutcome["winner"]): MatchOutcome {
  const side: SideMetrics = {
    lines: 0,
    sent: 0,
    tsd: 0,
    tetris: 0,
    maxPending: 0,
    maxHeight: 0,
    holes: 0,
    executionSourceMismatches: 0,
    executionExpectedBoardFailures: 0,
  };
  return {
    seed,
    winner,
    reason: "test",
    ticks: 10,
    pieces: 5,
    left: side,
    right: side,
  };
}
