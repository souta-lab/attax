import { describe, expect, test } from "bun:test";
import { beamBestMove } from "../src/ai/beam.js";
import { createEngine } from "../src/core/engine.js";
import { createVersusController } from "../src/versus/controller.js";
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

function executableTuckMove(snapshot: GameSnapshot): AiMove & { readonly linesCleared: number } {
  const move = beamBestMove(
    toBoard(snapshot),
    snapshot.active?.kind ?? "T",
    snapshot.next.slice(0, 2),
    snapshot.hold,
    snapshot.canHold,
    snapshot.b2b,
    snapshot.combo,
    {
      depth: 1,
      topK: 100,
      useHold: false,
      useKick: true,
      width: 10,
    },
  );
  expect(move).not.toBeNull();
  if (move === null) throw new Error("expected executable tuck move");
  expect(move.execution).toBeDefined();
  if (move.execution === undefined) throw new Error("expected executable tuck plan");
  return {
    targetX: move.x,
    targetRotation: move.rotation,
    useHold: false,
    execution: move.execution,
    linesCleared: move.linesCleared,
  };
}

function idleFighter(): { readonly name: string; readonly color: string; findBestMove: () => AiMove } {
  return {
    name: "idle",
    color: "idle",
    findBestMove: () => ({ targetX: 3, targetRotation: 0, useHold: false }),
  };
}

const controllerOptions = { stepIntervalMs: 1, gravityMs: 500, autoRematchMs: 2500 };

describe("arch-kick-hardening", () => {
  test("rejects a stale executable source plan before applying its steps", () => {
    const { engine, snapshot } = tuckFixture();
    const move = executableTuckMove(snapshot);
    engine.moveLeft();
    const stalePosition = engine.getSnapshot().active?.posX;
    const fighter = {
      name: "stale-plan",
      color: "stale-plan",
      findBestMove: (): AiMove => move,
    };
    const controller = createVersusController(fighter, idleFighter(), 0);
    controller.left.core = engine;

    controller.tick(0, controllerOptions);

    expect(controller.left.execution).toBeNull();
    expect(controller.left.queue).toEqual([{ kind: "drop" }]);
    expect(engine.getSnapshot().active?.posX).toBe(stalePosition);
  });

  test("invalidates an executable plan when board parity fails without throwing", () => {
    const { engine, snapshot } = tuckFixture();
    const move = executableTuckMove(snapshot);
    if (move.execution === undefined) throw new Error("expected executable tuck plan");
    const mismatch: AiMove = {
      ...move,
      execution: {
        ...move.execution,
        steps: [{ kind: "drop" }],
        expectedBoard: move.execution.expectedBoard.slice(1),
      },
    };
    let calls = 0;
    const fighter = {
      name: "mismatch",
      color: "mismatch",
      findBestMove: (): AiMove | null => {
        calls += 1;
        return calls === 1 ? mismatch : null;
      },
    };
    const controller = createVersusController(fighter, idleFighter(), 0);
    controller.left.core = engine;

    expect(() => {
      controller.tick(1, controllerOptions);
    }).not.toThrow();
    expect(controller.left.queue).toEqual([]);
    expect(controller.left.execution).toBeNull();
    expect(controller.left.pendingThink).toBe(true);
  });

  test("rejects a board-valid executable plan with a mismatched line-count witness", () => {
    const { engine, snapshot } = tuckFixture();
    const move = executableTuckMove(snapshot);
    if (move.execution === undefined) throw new Error("expected executable tuck plan");
    const execution = {
      ...move.execution,
      expectedLinesCleared: move.linesCleared + 1,
    } satisfies NonNullable<AiMove["execution"]> & { readonly expectedLinesCleared: number };
    const mismatch: AiMove = {
      ...move,
      execution,
    };
    const fighter = {
      name: "line-count-mismatch",
      color: "line-count-mismatch",
      findBestMove: (): AiMove => mismatch,
    };
    const controller = createVersusController(fighter, idleFighter(), 0);
    controller.left.core = engine;

    controller.tick(0, controllerOptions);
    for (let index = 0; index < move.execution.steps.length; index += 1) {
      controller.tick(1, controllerOptions);
    }

    expect(controller.left.executionSourceMismatches).toBe(0);
    expect(controller.left.executionExpectedBoardFailures).toBe(1);
    expect(controller.left.execution).toBeNull();
    expect(controller.left.queue).toEqual([]);
    expect(controller.left.pendingThink).toBe(true);
  });

  test("passes false tspin to veto and scorer for an ordinary T placement", () => {
    const board = new Uint16Array(20);
    const vetoSeen: boolean[] = [];
    const scorerSeen: boolean[] = [];

    const move = beamBestMove(board, "T", ["I"], null, false, false, -1, {
      depth: 1,
      topK: 4,
      useHold: false,
      useKick: false,
      width: 4,
      veto: (_after, _lines, tspin) => {
        vetoSeen.push(tspin);
        return false;
      },
      scorer: (_after, _lines, tspin) => {
        scorerSeen.push(tspin);
        return 0;
      },
    });

    expect(move).not.toBeNull();
    expect(vetoSeen.length).toBeGreaterThan(0);
    expect(scorerSeen.length).toBeGreaterThan(0);
    expect(vetoSeen.every((tspin) => !tspin)).toBe(true);
    expect(scorerSeen.every((tspin) => !tspin)).toBe(true);
  });

  test("passes true tspin to veto and scorer for the deterministic T-spin slot", () => {
    const board = new Uint16Array(20);
    board[3] = 0x7f;
    board[0] = 0x3ff;
    const vetoSeen: Array<{ readonly lines: number; readonly tspin: boolean }> = [];
    const scorerSeen: Array<{ readonly lines: number; readonly tspin: boolean }> = [];

    const move = beamBestMove(board, "T", ["I", "O"], null, false, false, -1, {
      depth: 1,
      useKick: true,
      veto: (_after, lines, tspin) => {
        vetoSeen.push({ lines, tspin });
        return false;
      },
      scorer: (_after, lines, tspin) => {
        scorerSeen.push({ lines, tspin });
        return 0;
      },
    });

    expect(move).not.toBeNull();
    expect(vetoSeen.some((entry) => entry.tspin && entry.lines > 0)).toBe(true);
    expect(scorerSeen.some((entry) => entry.tspin && entry.lines > 0)).toBe(true);
  });
});
