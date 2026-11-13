import { describe, expect, test } from "bun:test";
import { beamBestMove } from "../src/ai/beam.js";
import {
  enumerateKickPlacements,
  enumerateScored,
  type PlacementGenerator,
  type ScoredPlacement,
} from "../src/ai/search.js";
import { DU_WEIGHTS } from "../src/ai/weights.js";
import type { Board } from "../src/core/board.js";
import * as boardExports from "../src/core/board.js";
import { createEngine } from "../src/core/engine.js";
import type { AiExecutionPlan } from "../src/core/types.js";

type LockCell = { readonly x: number; readonly y: number };

type LockAfterstate = {
  readonly after: Board;
  readonly y: number;
  readonly linesCleared: number;
  readonly pieceCellsInClearedRows: number;
  readonly topOut: boolean;
};

type LockAfterstateCalculator = (
  board: Board,
  cells: readonly LockCell[],
  px: number,
  py: number,
) => LockAfterstate;

function emptyBoard(): Board {
  return new Uint16Array(20);
}

function isLockAfterstateCalculator(value: unknown): value is LockAfterstateCalculator {
  return typeof value === "function";
}

function executionPlan(
  board: Board,
  placement: ScoredPlacement,
): AiExecutionPlan & { readonly expectedLinesCleared: number } {
  return {
    targetX: placement.x,
    targetRotation: placement.rotation,
    steps: [{ kind: "drop" }],
    expectedBoard: Array.from(placement.after),
    expectedLinesCleared: placement.linesCleared,
    sourceActiveKind: "T",
    sourceRotation: 0,
    sourceX: 3,
    sourceBoardFingerprint: Array.from(board, (row) => row & 0x3ff).join(","),
    sourceHold: null,
    sourceCanHold: true,
  };
}

describe("v13 shared lock transition", () => {
  test("exposes an immutable lock-afterstate matching lockAndClear", () => {
    const candidate = Reflect.get(boardExports, "computeLockAfterstate");
    expect(typeof candidate).toBe("function");
    if (!isLockAfterstateCalculator(candidate)) return;

    const cells: readonly LockCell[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ];
    const board = new Uint16Array([0x03f, 0, 0, 0]);
    const before = Array.from(board);
    const expectedAfter = board.slice();
    const expectedInfo = boardExports.lockAndClear(expectedAfter, cells, 6, 0);
    const actual = candidate(board, cells, 6, 0);

    expect(Array.from(board)).toEqual(before);
    expect({
      after: Array.from(actual.after),
      y: actual.y,
      linesCleared: actual.linesCleared,
      pieceCellsInClearedRows: actual.pieceCellsInClearedRows,
      topOut: actual.topOut,
    }).toEqual({
      after: Array.from(expectedAfter),
      y: 0,
      ...expectedInfo,
    });
  });

  test("exposes cleared-line count on the engine lock transition", () => {
    const engine = createEngine({ random: () => 0 });
    engine.hardDrop();
    const transition = engine.getLastLockTransition();

    expect(transition).not.toBeNull();
    if (transition === null) return;
    expect(Reflect.get(transition, "linesCleared")).toBe(0);
  });

  test("generated executable plans carry their cleared-line witness", () => {
    const board = emptyBoard();
    board[3] = 0x7f;
    board[0] = 0x3ff;
    const placement = enumerateKickPlacements(board, "T").find(
      (candidate) => candidate.execution !== undefined,
    );
    expect(placement).toBeDefined();
    if (placement === undefined) return;

    const move = beamBestMove(board, "T", ["I"], null, false, false, -1, {
      depth: 1,
      width: 1,
      topK: 1,
      useHold: false,
      useKick: true,
      placementGenerator: () => [placement],
    });

    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.execution).toBeDefined();
    if (move.execution === undefined) return;
    expect(Reflect.get(move.execution, "expectedLinesCleared")).toBe(placement.linesCleared);
  });

  test("fails closed for a malformed executable placement witness", () => {
    const board = emptyBoard();
    const base = enumerateScored(board, "T", DU_WEIGHTS)[0];
    expect(base).toBeDefined();
    if (base === undefined) throw new Error("expected an empty-board placement");

    const malformedAfter = base.after.slice();
    const firstRow = malformedAfter[0];
    if (firstRow === undefined) throw new Error("expected a board row");
    malformedAfter[0] = firstRow ^ 1;
    const malformed: ScoredPlacement = {
      ...base,
      after: malformedAfter,
      y: base.y + 1,
      linesCleared: base.linesCleared + 1,
      execution: executionPlan(board, { ...base, after: malformedAfter }),
    };
    const generator: PlacementGenerator = () => [malformed];

    const move = beamBestMove(board, "T", ["I"], null, false, false, -1, {
      depth: 1,
      width: 1,
      topK: 1,
      useHold: false,
      useKick: false,
      placementGenerator: generator,
    });

    expect(move).toBeNull();
  });
});
