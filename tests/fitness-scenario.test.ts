import { describe, expect, test } from "bun:test";
import { createDeepSeekTetris } from "../src/ai/deepseek.js";
import { type FitnessScenarioInput, runFitnessScenario } from "../src/ai/fitness.js";
import { createHoiko } from "../src/ai/hoiko.js";

describe("fitness scenario API", () => {
  test("runs the typed S3 scenario in input seed order", () => {
    let leftFactoryCalls = 0;
    let rightFactoryCalls = 0;
    const input: FitnessScenarioInput = {
      factories: {
        leftFactory: () => {
          leftFactoryCalls += 1;
          return createDeepSeekTetris();
        },
        rightFactory: () => {
          rightFactoryCalls += 1;
          return createHoiko();
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
