import { describe, expect, test } from "bun:test";
import { beamBestMove } from "../src/ai/beam.js";
import { createEngine } from "../src/core/engine.js";
import { enumerateKickPlacements } from "../src/ai/search.js";
import { createVersusController, planSteps } from "../src/versus/controller.js";
import type { AiMove, GameSnapshot } from "../src/ui/types.js";

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

function tuckFixture(): { readonly engine: ReturnType<typeof createEngine>; readonly snapshot: GameSnapshot } {
  const engine = createEngine({ random: () => 0 });
  for (let i = 0; i < 2; i += 1) {
    engine.receiveGarbage?.(2);
    engine.hardDrop();
  }
  return { engine, snapshot: engine.getSnapshot() };
}

describe("arch-kick-exec", () => {
  test("search-selected tuck executes through versus with board parity", () => {
    const { engine, snapshot } = tuckFixture();
    const active = snapshot.active;
    expect(active).not.toBeNull();
    if (active === null) return;

    const board = toBoard(snapshot);
    const placement = enumerateKickPlacements(board, active.kind).find((candidate) => candidate.viaKick);
    expect(placement).toBeDefined();
    if (placement === undefined) return;

    const beam = beamBestMove(board, active.kind, snapshot.next.slice(0, 2), snapshot.hold, snapshot.canHold, snapshot.b2b, snapshot.combo, {
      depth: 1,
      topK: 100,
      useHold: false,
      useKick: true,
      width: 10,
    });
    expect(beam).not.toBeNull();
    if (beam === null) return;
    expect({ rotation: beam.rotation, x: beam.x, after: Array.from(beam.after) }).toEqual({
      rotation: placement.rotation,
      x: placement.x,
      after: Array.from(placement.after),
    });
    expect(beam.execution).toBeDefined();
    if (beam.execution === undefined) return;

    const move: AiMove = {
      targetX: beam.x,
      targetRotation: beam.rotation,
      useHold: false,
      execution: beam.execution,
    };
    const fixtureFighter = {
      name: "fixture",
      color: "fixture",
      findBestMove: (): AiMove => move,
    };
    let rightPieces = 0;
    const idleFighter = {
      name: "idle",
      color: "idle",
      findBestMove: (): AiMove => {
        const targetX = [0, 3, 6, 1, 4, 7, 2, 5][rightPieces % 8] ?? 0;
        rightPieces += 1;
        return { targetX, targetRotation: 0, useHold: false };
      },
    };
    const controller = createVersusController(fixtureFighter, idleFighter, 0);
    controller.left.core = engine;
    const options = { stepIntervalMs: 1, gravityMs: 500, autoRematchMs: 2500 };
    for (let i = 0; i < 100 && controller.left.core.getSnapshot().active?.kind === active.kind; i += 1) {
      controller.tick(1, options);
    }
    const after = controller.left.core.getSnapshot();
    expect(after.active?.kind).not.toBe(active.kind);
    expect(Array.from(toBoard(after))).toEqual(Array.from(beam.after));
  });

  test("hard-drop-only controller planning remains unchanged", () => {
    const move: AiMove = { targetX: 5, targetRotation: 1, useHold: false };
    expect(planSteps(0, 3, move)).toEqual([
      { kind: "rotateCW" },
      { kind: "right" },
      { kind: "right" },
      { kind: "drop" },
    ]);
  });

  test("default beam still returns the same empty-board hard-drop move", () => {
    const board = new Uint16Array(20);
    const move = beamBestMove(board, "T", ["I"], null, false, false, -1, {
      depth: 1,
      topK: 4,
      useHold: false,
      useKick: false,
      width: 4,
    });
    expect(move).not.toBeNull();
    expect(move === null ? null : { rotation: move.rotation, x: move.x, after: Array.from(move.after) }).toEqual({
      rotation: 0,
      x: 2,
      after: [28, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    });
  });
});
