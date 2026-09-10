import { describe, expect, test } from "bun:test";
import { createFighterA } from "../src/ai/fighterA.js";
import { createFighterB } from "../src/ai/fighterB.js";
import {
  type FitnessFighterFactory,
  type FitnessInput,
  fingerprintFitness,
  runFitness,
  serializeFitness,
} from "../src/ai/fitness.js";

const liveLeftFactory: FitnessFighterFactory = () => createFighterA();
const frozenRightFactory: FitnessFighterFactory = () => createFighterB();
const liveRightFactory: FitnessFighterFactory = () => createFighterB();

const fitnessInput: FitnessInput = {
  identity: {
    vectorId: "production-fighters",
    configId: "controller-defaults-dt16",
  },
  seeds: [1, 7],
  maxTicks: 128,
  scenarios: {
    S1: { leftFactory: liveLeftFactory, rightFactory: frozenRightFactory },
    S3: { leftFactory: liveLeftFactory, rightFactory: liveRightFactory },
  },
};

describe("architecture fitness harness", () => {
  test("same factories and seeds produce byte-identical paired fitness", () => {
    const first = runFitness(fitnessInput);
    const second = runFitness(fitnessInput);

    expect(serializeFitness(first)).toBe(serializeFitness(second));
    expect(fingerprintFitness(first)).toBe(fingerprintFitness(second));
    expect(first.scenarios.map((scenario) => scenario.label)).toEqual(["S1", "S3"]);
    expect(first.scenarios[0]?.matches.map((match) => match.seed)).toEqual([1, 7]);
    expect(first.scenarios[1]?.matches.map((match) => match.seed)).toEqual([1, 7]);
  });

  test("max tick cap is explicit and match records contain only observable metrics", () => {
    const capped = runFitness({ ...fitnessInput, maxTicks: 1 });
    for (const scenario of capped.scenarios) {
      for (const match of scenario.matches) {
        expect(match.ticks).toBe(1);
        expect(match.winner).toBe("cap");
        expect(match.reason).toBe("max-ticks");
        expect(match.pieces).toBe(0);
        expect(Object.keys(match)).toEqual([
          "label",
          "seed",
          "winner",
          "reason",
          "ticks",
          "pieces",
          "left",
          "right",
        ]);
        expect(Object.keys(match.left)).toEqual([
          "lines",
          "sent",
          "tsd",
          "tetris",
          "maxPending",
          "maxHeight",
          "holes",
        ]);
      }
    }
    const serialized = serializeFitness(capped);
    expect(serialized).not.toContain('"score"');
    expect(serialized).not.toContain('"fitness"');
    expect(serialized).not.toContain('"elo"');
  });

  test("vector and config identities propagate without strength claims", () => {
    const baseline = runFitness({ ...fitnessInput, maxTicks: 1 });
    const perturbedIdentity = runFitness({
      ...fitnessInput,
      maxTicks: 1,
      identity: {
        vectorId: "perturbed-vector-marker",
        configId: fitnessInput.identity.configId,
      },
    });

    expect(perturbedIdentity.identity.vectorId).toBe("perturbed-vector-marker");
    expect(perturbedIdentity.identity.configId).toBe(fitnessInput.identity.configId);
    expect(fingerprintFitness(perturbedIdentity)).not.toBe(fingerprintFitness(baseline));
  });
});
