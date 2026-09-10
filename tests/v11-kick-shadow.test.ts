import { describe, expect, test } from "bun:test";
import { createEngine } from "../src/core/engine.js";
import { createFighterA } from "../src/ai/fighterA.js";
import {
  type FitnessFighterFactory,
  type FitnessInput,
  runFitness,
} from "../src/ai/fitness.js";
import { createVersusController } from "../src/versus/controller.js";
import type { AiExecutionPlan, AiMove, GameSnapshot } from "../src/ui/types.js";

declare const Bun: {
  readonly file: (path: URL) => {
    readonly text: () => Promise<string>;
  };
};

const controllerOptions = {
  stepIntervalMs: 1,
  gravityMs: 500,
  autoRematchMs: 2500,
} as const;

function boardFingerprint(snapshot: GameSnapshot): string {
  const rows: number[] = [];
  for (let y = 0; y < snapshot.board.rows; y += 1) {
    const row = snapshot.board.grid[snapshot.board.rows - 1 - y];
    let bits = 0;
    for (let x = 0; x < 10; x += 1) {
      if ((row?.[x] ?? 0) !== 0) bits |= 1 << x;
    }
    rows.push(bits);
  }
  return rows.join(",");
}

function planFor(
  snapshot: GameSnapshot,
  expectedBoard: readonly number[],
  sourceX: number = snapshot.active?.posX ?? 3,
): AiExecutionPlan & { readonly expectedLinesCleared: number } {
  const active = snapshot.active;
  if (active === null) throw new Error("expected an active piece");
  return {
    targetX: sourceX,
    targetRotation: active.rotation,
    steps: [{ kind: "drop" }],
    expectedBoard,
    expectedLinesCleared: 0,
    sourceActiveKind: active.kind,
    sourceRotation: active.rotation,
    sourceX,
    sourceBoardFingerprint: boardFingerprint(snapshot),
    sourceHold: snapshot.hold,
    sourceCanHold: snapshot.canHold,
  };
}

function moveWithPlan(plan: AiExecutionPlan): AiMove {
  return {
    targetX: plan.targetX,
    targetRotation: plan.targetRotation,
    useHold: false,
    execution: plan,
  };
}

function idleFighter(): {
  readonly name: string;
  readonly color: string;
  readonly findBestMove: () => AiMove;
} {
  return {
    name: "idle",
    color: "idle",
    findBestMove: () => ({ targetX: 3, targetRotation: 0, useHold: false }),
  };
}

function fitnessInput(factory: FitnessFighterFactory, maxTicks: number): FitnessInput {
  return {
    identity: { vectorId: "v11-shadow", configId: "controller-defaults" },
    seeds: [0],
    maxTicks,
    scenarios: {
      S1: { leftFactory: factory, rightFactory: factory },
      S3: { leftFactory: factory, rightFactory: factory },
    },
  };
}

function stackedSnapshot(): GameSnapshot {
  const engine = createEngine({ random: () => 0 });
  for (let index = 0; index < 2; index += 1) {
    engine.receiveGarbage?.(2);
    engine.hardDrop();
  }
  return engine.getSnapshot();
}

describe("v11 kick shadow", () => {
  test("keeps Fighter A kicks opt-in and wires both beam paths to the flag", async () => {
    const source = await Bun.file(new URL("../src/ai/fighterA.ts", import.meta.url)).text();

    expect(source).toContain("export function createFighterA(options: FighterAOptions = {})");
    expect(source).toContain("const useKick = options.useKick ?? false");
    expect(source.match(/useKick:\s*useKick/g) ?? []).toHaveLength(2);
    expect(createFighterA({ useKick: true }).name).toBe("BLUE");
    expect(createFighterA().name).toBe("BLUE");
  });

  test("keeps the production default hard-drop-only and enables executable kicks when opted in", () => {
    const snapshot = stackedSnapshot();
    const defaultMove = createFighterA().findBestMove(snapshot);
    const kickMove = createFighterA({ useKick: true }).findBestMove(snapshot);

    expect(defaultMove?.execution).toBeUndefined();
    expect(kickMove?.execution).toBeDefined();
  });

  test("counts an execution source mismatch on the controller side", () => {
    const engine = createEngine({ random: () => 0 });
    const snapshot = engine.getSnapshot();
    const active = snapshot.active;
    if (active === null) throw new Error("expected an active piece");
    const plan = planFor(snapshot, [], active.posX + 1);
    const fighter = {
      name: "source-mismatch",
      color: "source-mismatch",
      findBestMove: (): AiMove => moveWithPlan(plan),
    };
    const controller = createVersusController(fighter, idleFighter(), 0);
    controller.left.core = engine;

    controller.tick(0, controllerOptions);

    expect(controller.left.executionSourceMismatches).toBe(1);
    expect(controller.left.executionExpectedBoardFailures).toBe(0);
  });

  test("counts an expected-board failure after executing a plan", () => {
    const engine = createEngine({ random: () => 0 });
    const snapshot = engine.getSnapshot();
    const plan = planFor(snapshot, []);
    const fighter = {
      name: "board-mismatch",
      color: "board-mismatch",
      findBestMove: (): AiMove => moveWithPlan(plan),
    };
    const controller = createVersusController(fighter, idleFighter(), 0);
    controller.left.core = engine;

    controller.tick(1, controllerOptions);

    expect(controller.left.executionSourceMismatches).toBe(0);
    expect(controller.left.executionExpectedBoardFailures).toBe(1);
  });

  test("propagates execution failures as fitness side metrics", () => {
    const sourceMismatchFactory: FitnessFighterFactory = () => ({
      name: "fitness-source-mismatch",
      findBestMove: (snapshot) => {
        const active = snapshot.active;
        if (active === null) return null;
        return moveWithPlan(planFor(snapshot, [], active.posX + 1));
      },
    });
    const sourceResult = runFitness(fitnessInput(sourceMismatchFactory, 1));
    const sourceMatch = sourceResult.scenarios[0]?.matches[0];
    if (sourceMatch === undefined) throw new Error("expected source mismatch match");
    expect(sourceMatch.left.executionSourceMismatches).toBe(1);

    const boardMismatchFactory: FitnessFighterFactory = () => ({
      name: "fitness-board-mismatch",
      findBestMove: (snapshot) => {
        if (snapshot.active === null) return null;
        return moveWithPlan(planFor(snapshot, []));
      },
    });
    const boardResult = runFitness(fitnessInput(boardMismatchFactory, 8));
    const boardMatch = boardResult.scenarios[0]?.matches[0];
    if (boardMatch === undefined) throw new Error("expected board mismatch match");
    expect(boardMatch.left.executionExpectedBoardFailures).toBe(1);
  });
});
