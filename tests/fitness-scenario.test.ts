import { describe, expect, test } from "bun:test";
import { createFighterA } from "../src/ai/fighterA.js";
import { createFighterB } from "../src/ai/fighterB.js";
import { type FitnessScenarioInput, runFitnessScenario } from "../src/ai/fitness.js";

describe("fitness scenario API", () => {
  test("runs the typed S3 scenario in input seed order", () => {
    let leftFactoryCalls = 0;
    let rightFactoryCalls = 0;
    const input: FitnessScenarioInput = {
      factories: {
        leftFactory: () => {
          leftFactoryCalls += 1;
          return createFighterA();
        },
        rightFactory: () => {
          rightFactoryCalls += 1;
          return createFighterB();
        },
      },
      seeds: [7, 1],
      maxTicks: 1,
    };

    const result = runFitnessScenario(input);

    expect(result.label).toBe("S3");
    expect(result.matches.map((match) => match.seed)).toEqual([7, 1]);
    expect(result.matches.every((match) => match.winner === "cap")).toBe(true);
    expect(leftFactoryCalls).toBe(2);
    expect(rightFactoryCalls).toBe(2);
  });
});
