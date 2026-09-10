import { describe, expect, test } from "bun:test";
import { beamBestMove } from "../src/ai/beam.js";
import { createFighterA } from "../src/ai/fighterA.js";
import { createEngine } from "../src/core/engine.js";
import type { AiMove, CorePort, GameSnapshot } from "../src/ui/types.js";
import { createVersusController } from "../src/versus/controller.js";

const controllerOptions = {
  stepIntervalMs: 1,
  gravityMs: 500,
  autoRematchMs: 2500,
} as const;

function toBoard(snapshot: GameSnapshot): Uint16Array {
  const board = new Uint16Array(20);
  for (let y = 0; y < snapshot.board.rows && y < board.length; y += 1) {
    const row = snapshot.board.grid[snapshot.board.rows - 1 - y];
    if (row === undefined) continue;
    let bits = 0;
    for (let x = 0; x < 10; x += 1) {
      if ((row[x] ?? 0) !== 0) bits |= 1 << x;
    }
    board[y] = bits;
  }
  return board;
}

function stackedEngine(): CorePort {
  const engine = createEngine({ random: () => 0 });
  for (let index = 0; index < 2; index += 1) {
    engine.receiveGarbage?.(2);
    engine.hardDrop();
  }
  return engine;
}

function executableMove(snapshot: GameSnapshot): AiMove {
  const active = snapshot.active;
  expect(active).not.toBeNull();
  if (active === null) throw new Error("expected active piece");

  const move = beamBestMove(
    toBoard(snapshot),
    active.kind,
    snapshot.next.slice(0, 2),
    snapshot.hold,
    snapshot.canHold,
    snapshot.b2b,
    snapshot.combo,
    {
      depth: 1,
      pending: snapshot.pendingGarbage,
      topK: 100,
      useHold: false,
      useKick: true,
      width: 10,
    },
  );
  expect(move).not.toBeNull();
  if (move === null) throw new Error("expected executable move");
  expect(move.execution).toBeDefined();
  if (move.execution === undefined) throw new Error("expected executable plan");
  return {
    targetX: move.x,
    targetRotation: move.rotation,
    useHold: false,
    execution: move.execution,
  };
}

describe("v12 executable-plan parity", () => {
  test("does not count pending garbage against a pre-garbage executable afterstate", () => {
    const engine = stackedEngine();
    engine.receiveGarbage?.(1);
    const sourceSnapshot = engine.getSnapshot();
    expect(sourceSnapshot.pendingGarbage).toBe(1);
    const move = executableMove(sourceSnapshot);

    const fixtureFighter = {
      name: "pre-garbage-plan",
      color: "fixture",
      findBestMove: (): AiMove => move,
    };
    const rightFighter = { ...createFighterA(), color: "blue" };
    const controller = createVersusController(fixtureFighter, rightFighter, 0);
    controller.left.core = engine;

    controller.tick(0, controllerOptions);
    expect(controller.left.executionSourceMismatches).toBe(0);
    const steps = move.execution?.steps;
    expect(steps).toBeDefined();
    if (steps === undefined) throw new Error("expected executable steps");
    for (let index = 0; index < steps.length; index += 1) {
      controller.tick(1, controllerOptions);
    }

    expect(controller.left.executionExpectedBoardFailures).toBe(0);
  });
});
