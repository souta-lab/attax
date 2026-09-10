import { describe, expect, test } from "bun:test";
import { beamBestMove, createBeamEvaluation } from "../src/ai/beam.js";
import { createFighterA } from "../src/ai/fighterA.js";
import { createFighterB } from "../src/ai/fighterB.js";
import type { Board } from "../src/core/board.js";
import { cellsFor, type PieceKind } from "../src/core/pieces.js";
import {
  enumerateKickPlacements,
  enumerateScored,
  type PlacementGenerator,
  type ScoredPlacement,
} from "../src/ai/search.js";
import { DU_WEIGHTS } from "../src/ai/weights.js";
import type { AiExecutionPlan, AiMove, CellValue, GameSnapshot } from "../src/ui/types.js";

function emptyBoard(): Uint16Array {
  return new Uint16Array(20);
}

function fixedKickBoard(): Uint16Array {
  const board = emptyBoard();
  board[3] = 0x7f;
  board[0] = 0x3ff;
  return board;
}

function placementAt(board: Uint16Array, kind: PieceKind, rotation: number, x: number): ScoredPlacement {
  const placement = enumerateScored(board, kind, DU_WEIGHTS).find(
    (candidate) => candidate.rotation === rotation && candidate.x === x,
  );
  if (placement === undefined) throw new Error(`missing placement ${kind} r${rotation} x${x}`);
  return placement;
}

function emptySnapshot(kind: PieceKind): GameSnapshot {
  const grid: CellValue[][] = Array.from({ length: 20 }, () =>
    Array.from({ length: 10 }, () => 0 as CellValue),
  );
  return {
    board: { cols: 10, rows: 20, grid },
    active: { kind, rotation: 0, cells: cellsFor(kind, 0), posX: 3, posY: 0 },
    ghostY: 18,
    hold: null,
    canHold: false,
    next: ["I"],
    score: 0,
    lines: 0,
    level: 1,
    gameOver: false,
    combo: -1,
    b2b: false,
    pendingGarbage: 0,
    lastAttack: 0,
    lastBlocked: 0,
  };
}

function moveShape(
  move: AiMove | ReturnType<typeof beamBestMove>,
): { readonly rotation: number; readonly x: number; readonly useHold: boolean } | null {
  if (move === null) return null;
  if ("targetX" in move) {
    return { rotation: move.targetRotation, x: move.targetX, useHold: move.useHold };
  }
  return { rotation: move.rotation, x: move.x, useHold: move.useHold };
}

function directDefaultMove(board: Uint16Array): ReturnType<typeof beamBestMove> {
  return beamBestMove(board, "T", ["I"], null, false, false, -1, {
    depth: 1,
    width: 1,
    topK: 1,
    useHold: false,
    useKick: false,
  });
}

describe("v12 placement-generator architecture", () => {
  test("beam calls the injected generator and returns its sentinel placement", () => {
    const board = emptyBoard();
    const sentinel = placementAt(board, "T", 0, 7);
    let callCount = 0;
    const generator: PlacementGenerator = (receivedBoard: Board, receivedKind: PieceKind) => {
      callCount += 1;
      expect(Array.from(receivedBoard)).toEqual(Array.from(board));
      expect(receivedKind).toBe("T");
      return [{ ...sentinel, score: 987654 }];
    };

    const move = beamBestMove(board, "T", ["I"], null, false, false, -1, {
      depth: 1,
      width: 1,
      topK: 1,
      useHold: false,
      placementGenerator: generator,
    });

    expect(callCount).toBe(1);
    expect(move).not.toBeNull();
    if (move === null) return;
    expect({ rotation: move.rotation, x: move.x }).toEqual({ rotation: sentinel.rotation, x: sentinel.x });
    expect(Array.from(move.after)).toEqual(Array.from(sentinel.after));
  });

  test("beam preserves every AiExecutionPlan field on an injected executable placement", () => {
    const board = emptyBoard();
    const base = placementAt(board, "T", 0, 2);
    const sourceBoardFingerprint = Array.from(board).join(",");
    const executionPlan = {
      targetX: base.x,
      targetRotation: base.rotation,
      steps: [{ kind: "rotateCW" }, { kind: "right" }, { kind: "softDrop" }, { kind: "drop" }],
      expectedBoard: Array.from(base.after),
      expectedLinesCleared: base.linesCleared,
      sourceActiveKind: "T",
      sourceRotation: 2,
      sourceX: 7,
      sourceBoardFingerprint,
      sourceHold: "I",
      sourceCanHold: false,
    } satisfies AiExecutionPlan & { readonly expectedLinesCleared: number };
    const executable = { ...base, score: -200, execution: executionPlan };
    const ordinary = { ...base, x: 0, score: -100 };
    const generator: PlacementGenerator = () => [ordinary, executable];

    const move = beamBestMove(board, "T", ["I"], "I", false, false, -1, {
      depth: 1,
      width: 1,
      topK: 1,
      useHold: false,
      sourceRotation: executionPlan.sourceRotation,
      sourceX: executionPlan.sourceX,
      placementGenerator: generator,
      evaluation: createBeamEvaluation({
        rank: ({ placement }) => (placement.execution === undefined ? -1 : 1),
      }),
    });

    expect(move).not.toBeNull();
    if (move === null) return;
    const execution = move.execution;
    expect(execution).toBeDefined();
    if (execution === undefined) return;
    expect(execution.steps).toEqual(executionPlan.steps);
    expect(execution.expectedBoard).toEqual(executionPlan.expectedBoard);
    expect(execution.sourceActiveKind).toBe(executionPlan.sourceActiveKind);
    expect(execution.sourceRotation).toBe(executionPlan.sourceRotation);
    expect(execution.sourceX).toBe(executionPlan.sourceX);
    expect(execution.sourceBoardFingerprint).toBe(executionPlan.sourceBoardFingerprint);
    expect(execution.sourceHold).toBe(executionPlan.sourceHold);
    expect(execution.sourceCanHold).toBe(executionPlan.sourceCanHold);
    expect(Reflect.get(execution, "expectedLinesCleared")).toBe(executionPlan.expectedLinesCleared);
  });

  test("default beam with kicks disabled ranks only ordinary placements", () => {
    const board = fixedKickBoard();
    const kickPlacements = enumerateKickPlacements(board, "T");
    expect(kickPlacements.some((placement) => placement.viaKick)).toBe(true);

    const move = beamBestMove(board, "T", ["I"], null, false, false, -1, {
      depth: 1,
      width: 1,
      topK: 1,
      useHold: false,
      useKick: false,
      evaluation: createBeamEvaluation({
        rank: ({ placement }) => (placement.viaKick ? 1_000_000 : 0),
      }),
    });

    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.execution).toBeUndefined();
  });

  test("Fighter A keeps injected generators local while Fighter B and direct beam stay default", () => {
    const board = emptyBoard();
    const snapshot = emptySnapshot("T");
    const firstPlacement = placementAt(board, "T", 0, 0);
    const secondPlacement = placementAt(board, "T", 0, 7);
    let firstCalls = 0;
    let secondCalls = 0;
    const firstGenerator: PlacementGenerator = () => {
      firstCalls += 1;
      return [firstPlacement];
    };
    const secondGenerator: PlacementGenerator = () => {
      secondCalls += 1;
      return [secondPlacement];
    };
    const directBefore = directDefaultMove(board);
    const fighterBBefore = createFighterB().findBestMove(snapshot);

    const firstMove = createFighterA({ placementGenerator: firstGenerator }).findBestMove(snapshot);
    const secondMove = createFighterA({ placementGenerator: secondGenerator }).findBestMove(snapshot);

    const directAfter = directDefaultMove(board);
    const fighterBAfter = createFighterB().findBestMove(snapshot);
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
    expect(firstMove?.targetX).toBe(firstPlacement.x);
    expect(secondMove?.targetX).toBe(secondPlacement.x);
    expect(firstMove?.targetX).not.toBe(secondMove?.targetX);
    expect(moveShape(directAfter)).toEqual(moveShape(directBefore));
    expect(moveShape(fighterBAfter)).toEqual(moveShape(fighterBBefore));
  });

  test("injected generator is owned by the root beam expansion", () => {
    const board = emptyBoard();
    const rootPlacement = placementAt(board, "T", 0, 3);
    const calls: Array<{ readonly kind: PieceKind; readonly rows: number }> = [];
    const generator: PlacementGenerator = (receivedBoard: Board, receivedKind: PieceKind) => {
      calls.push({ kind: receivedKind, rows: receivedBoard.length });
      return [rootPlacement];
    };

    const move = beamBestMove(board, "T", ["I", "O", "S"], null, false, false, -1, {
      depth: 3,
      width: 1,
      topK: 1,
      useHold: false,
      placementGenerator: generator,
    });

    expect(move).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ kind: "T", rows: 20 });
    expect(move?.x).toBe(rootPlacement.x);
  });
});
