import { describe, expect, test } from "bun:test";
import { createDeepSeekV2, isV2Tspin } from "../src/ai/deepseek-v2.js";
import { v2BoardStats, v2GarbageDefense, v2OpponentModel } from "../src/ai/deepseek-v2-score.js";
import type { CellValue, GameSnapshot, PieceKind } from "../src/ui/types.js";

const ROWS = 20;

function boardGrid(bottomUpRows: readonly number[]): CellValue[][] {
  const grid: CellValue[][] = Array.from({ length: ROWS }, () => new Array<CellValue>(10).fill(0));
  for (let y = 0; y < bottomUpRows.length && y < ROWS; y += 1) {
    const bits = bottomUpRows[y] ?? 0;
    const row = grid[ROWS - 1 - y];
    if (row === undefined) continue;
    for (let x = 0; x < 10; x += 1) if ((bits & (1 << x)) !== 0) row[x] = 1;
  }
  return grid;
}

function snapshot(
  bottomUpRows: readonly number[],
  next: readonly PieceKind[],
  overrides: Partial<GameSnapshot> = {},
): GameSnapshot {
  return {
    board: { cols: 10, rows: ROWS, grid: boardGrid(bottomUpRows) },
    active: { kind: "T", rotation: 0, cells: [], posX: 3, posY: 0 },
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
    pendingGarbage: 0,
    lastAttack: 0,
    lastBlocked: 0,
    ...overrides,
  };
}

// A standard TSD notch: row0 missing col4, row1 missing cols 3/4/5.
const TSD_ROWS: readonly number[] = [0x3ff ^ (1 << 4), 0x3ff ^ (1 << 3) ^ (1 << 4) ^ (1 << 5)];
const QUEUE: readonly PieceKind[] = ["I", "O", "S", "Z", "J", "L", "T"];

describe("deepseek v2 SRS T-spin semantics", () => {
  test("isV2Tspin flags the TSD notch and rejects non-spins", () => {
    const board = Uint16Array.from(TSD_ROWS);
    expect(isV2Tspin(board, "T", 2, 3, 0)).toBe(true);
    expect(isV2Tspin(new Uint16Array(ROWS), "T", 0, 3, 0)).toBe(false);
    expect(isV2Tspin(board, "I", 2, 3, 0)).toBe(false);
  });

  test("findBestMove executes the TSD with a placeAt step carrying lastSrs", () => {
    const fighter = createDeepSeekV2();
    const move = fighter.findBestMove(snapshot(TSD_ROWS, QUEUE));
    expect(move).not.toBeNull();
    if (move === null) return;
    expect(move.targetRotation).toBe(2);
    expect(move.targetX).toBe(3);
    const last = move.execution?.steps.at(-1);
    expect(last?.kind).toBe("placeAt");
    if (last?.kind === "placeAt") expect(last.lastSrs).toBeGreaterThan(0);
    expect(fighter.getDebug()?.linesCleared).toBeGreaterThanOrEqual(2);
  });
});

describe("deepseek v2 fighter contract", () => {
  test("returns a legal move and debug telemetry", () => {
    const fighter = createDeepSeekV2();
    expect(fighter.name).toBe("DEEPSEEK_V2");
    const move = fighter.findBestMove(snapshot([], QUEUE));
    expect(move).not.toBeNull();
    expect(fighter.getDebug()?.searchDepth).toBe(6);
  });

  test("depth option is honoured through debug telemetry", () => {
    const fighter = createDeepSeekV2({ depth: 7 });
    fighter.findBestMove(snapshot([], QUEUE));
    expect(fighter.getDebug()?.searchDepth).toBe(7);
  });

  test("reset() clears per-match state", () => {
    const fighter = createDeepSeekV2();
    fighter.findBestMove(snapshot([], QUEUE));
    expect(fighter.getDebug()?.pieceIndex).toBe(1);
    fighter.reset();
    expect(fighter.getDebug()).toBeNull();
    fighter.findBestMove(snapshot([], QUEUE));
    expect(fighter.getDebug()?.pieceIndex).toBe(1);
  });

  test("returns null when the game is over or has no active piece", () => {
    const fighter = createDeepSeekV2();
    expect(fighter.findBestMove(snapshot([], QUEUE, { gameOver: true }))).toBeNull();
    expect(fighter.findBestMove(snapshot([], QUEUE, { active: null }))).toBeNull();
  });
});

describe("deepseek v2 garbage defense", () => {
  function wallBoard(height: number): Uint16Array {
    const board = new Uint16Array(ROWS);
    for (let y = 0; y < height; y += 1) board[y] = 1;
    return board;
  }

  test("does nothing without incoming garbage", () => {
    expect(v2GarbageDefense(v2BoardStats(wallBoard(15)), 0)).toBe(0);
  });

  test("penalizes near-ceiling stacks more as pending grows", () => {
    const stats = v2BoardStats(wallBoard(15));
    const low = v2GarbageDefense(stats, 2);
    const high = v2GarbageDefense(stats, 5);
    expect(low).toBeLessThan(0);
    expect(high).toBeLessThan(low);
  });

  test("taller stacks are penalized more than shorter ones", () => {
    const short = v2GarbageDefense(v2BoardStats(wallBoard(10)), 6);
    const tall = v2GarbageDefense(v2BoardStats(wallBoard(15)), 6);
    expect(tall).toBeLessThan(short);
  });
});

describe("deepseek v2 opponent model", () => {
  test("detects a whiff window", () => {
    const whiff = snapshot([], QUEUE, {
      opponentLockId: 4,
      opponentLastClearLines: 0,
      opponentLastNativeCombo: 0,
      opponentLastNativeBtb: 0,
      opponentLastRawAttack: 0,
    });
    expect(v2OpponentModel(whiff).vuln).toBe(1);
  });

  test("danger rises with the opponent's last raw attack", () => {
    const quiet = snapshot([], QUEUE, { opponentLockId: 1, opponentLastRawAttack: 0 });
    const fierce = snapshot([], QUEUE, { opponentLockId: 1, opponentLastRawAttack: 4 });
    expect(v2OpponentModel(fierce).danger).toBeGreaterThan(v2OpponentModel(quiet).danger);
  });
});
