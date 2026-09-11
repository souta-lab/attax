import { describe, expect, test } from "bun:test";
import { beamBestMove } from "../src/ai/beam.js";
import { createDeepSeekTetris } from "../src/ai/deepseek.js";
import type { AiDebug, AiMove, CellValue, GameSnapshot, PieceKind } from "../src/ui/types.js";
import { createVersusController } from "../src/versus/controller.js";

const ROWS = 20;

function boardGrid(bottomUpRows: readonly number[]): CellValue[][] {
  const grid: CellValue[][] = Array.from({ length: ROWS }, () => new Array<CellValue>(10).fill(0));
  for (let y = 0; y < bottomUpRows.length && y < ROWS; y += 1) {
    const bits = bottomUpRows[y] ?? 0;
    const gridY = ROWS - 1 - y;
    const row = grid[gridY];
    if (row === undefined) continue;
    for (let x = 0; x < 10; x += 1) if ((bits & (1 << x)) !== 0) row[x] = 1;
  }
  return grid;
}

function snapshot(bottomUpRows: readonly number[], next: readonly PieceKind[]): GameSnapshot {
  return {
    board: { cols: 10, rows: ROWS, grid: boardGrid(bottomUpRows) },
    active: { kind: "I", rotation: 0, cells: [], posX: 3, posY: 0 },
    ghostY: null,
    hold: null,
    canHold: true,
    next,
    score: 0,
    lines: 0,
    level: 1,
    gameOver: false,
    combo: 0,
    b2b: false,
    nativeCombo: 0,
    nativeBtb: 0,
    lockId: 0,
    lastAction: "None",
    lastRawAttack: 0,
    pendingGarbage: 5,
    lastAttack: 0,
    lastBlocked: 0,
  };
}

const HOLEY_OPENING_BOARD: readonly number[] = [
  0b1111111110, 0b1111111110, 0b1011111110, 0b1100111110, 0b1111000000,
];

const NEXT: readonly PieceKind[] = ["T", "S", "Z", "J", "L", "O", "I"];

describe("deepseek state leak across matches", () => {
  test("reset() restores opening behaviour for the next match", () => {
    const fighter = createDeepSeekTetris();
    const snap = snapshot(HOLEY_OPENING_BOARD, NEXT);

    const firstMove = fighter.findBestMove(snap);
    const firstDebug = fighter.getDebug();
    expect(firstMove).not.toBeNull();
    expect(firstDebug).not.toBeNull();
    if (firstDebug === null) throw new Error("unreachable");
    expect(firstDebug.pieceIndex).toBe(1);

    let lateMove: AiMove | null = firstMove;
    let lateDebug: AiDebug | null = firstDebug;
    for (let i = 0; i < 70; i += 1) {
      lateMove = fighter.findBestMove(snap);
      lateDebug = fighter.getDebug();
    }
    if (lateDebug === null) throw new Error("unreachable");
    expect(lateDebug.pieceIndex).toBe(71);
    expect(lateMove).not.toEqual(firstMove);

    fighter.reset();
    expect(fighter.getDebug()).toBeNull();

    const second = fighter.findBestMove(snap);
    const secondDebug = fighter.getDebug();
    if (secondDebug === null) throw new Error("unreachable");
    expect(secondDebug.pieceIndex).toBe(1);
    expect(second).toEqual(firstMove);
    expect(secondDebug.score).toBe(firstDebug.score);
  });

  test("controller reset invokes fighter.reset()", () => {
    let resets = 0;
    const fighter = {
      name: "spy",
      color: "#000",
      findBestMove: (): AiMove | null => null,
      reset: (): void => {
        resets += 1;
      },
    };
    const opponent = { name: "opp", color: "#fff", findBestMove: (): AiMove | null => null };
    const controller = createVersusController(opponent, fighter, 1);
    controller.resetMatch(2);
    controller.resetMatch(3);
    expect(resets).toBe(2);
  });
});

describe("deepseek beam depth clamp", () => {
  test("requested depth 6 is actually searched with five lookahead pieces", () => {
    const board = Uint16Array.from(HOLEY_OPENING_BOARD);
    const move = beamBestMove(board, "I", ["T", "S", "Z", "J", "L"], null, true, false, 0, {
      depth: 6,
    });
    expect(move).not.toBeNull();
    expect(move?.searchDepth).toBe(6);
  });

  test("depth is clamped only by available lookahead", () => {
    const board = Uint16Array.from(HOLEY_OPENING_BOARD);
    const five = beamBestMove(board, "I", ["T", "S", "Z", "J", "L"], null, true, false, 0, {
      depth: 5,
    });
    expect(five?.searchDepth).toBe(5);
    const short = beamBestMove(board, "I", ["T", "S"], null, true, false, 0, { depth: 6 });
    expect(short?.searchDepth).toBe(3);
  });

  test("createDeepSeekTetris reports depth 6 through debug telemetry", () => {
    const fighter = createDeepSeekTetris();
    fighter.findBestMove(snapshot(HOLEY_OPENING_BOARD, NEXT));
    expect(fighter.getDebug()?.searchDepth).toBe(6);
  });
});
