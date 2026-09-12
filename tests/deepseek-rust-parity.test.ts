import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createDeepSeekV2, type DeepSeekV2Options } from "../src/ai/deepseek-v2.js";
import type { AiExecutionStep, CellValue, GameSnapshot, PieceKind } from "../src/ui/types.js";
import { createRustDeepSeekV2 } from "../tools/deepseek-rust/loader.js";

const ROWS = 20;
const COLS = 10;
const FIXTURE = new URL(
  "../rust/deepseek-rust/tests/fixtures/deepseek_v2_parity.json",
  import.meta.url,
);

interface FixtureOpponent {
  readonly lockId: number;
  readonly lastClearLines?: number | undefined;
  readonly lastNativeCombo?: number | undefined;
  readonly lastNativeBtb?: number | undefined;
  readonly lastRawAttack?: number | undefined;
  readonly combo?: number | undefined;
  readonly btb?: number | undefined;
}

interface FixtureCase {
  readonly name: string;
  readonly board: readonly number[];
  readonly active: PieceKind;
  readonly next: readonly PieceKind[];
  readonly hold: PieceKind | null;
  readonly canHold: boolean;
  readonly b2b: boolean;
  readonly combo: number;
  readonly pendingGarbage: number;
  readonly pieces: number;
  readonly opponent?: FixtureOpponent | undefined;
  readonly options?: DeepSeekV2Options | undefined;
  readonly expected: {
    readonly targetX: number;
    readonly targetRotation: number;
    readonly useHold: boolean;
  };
}

function gridFromBottomUp(bottomUp: readonly number[]): CellValue[][] {
  const grid: CellValue[][] = Array.from({ length: ROWS }, () =>
    new Array<CellValue>(COLS).fill(0),
  );
  for (let y = 0; y < bottomUp.length && y < ROWS; y += 1) {
    const bits = bottomUp[y] ?? 0;
    const row = grid[ROWS - 1 - y];
    if (row === undefined) continue;
    for (let x = 0; x < COLS; x += 1) if ((bits & (1 << x)) !== 0) row[x] = 1;
  }
  return grid;
}

function snapshot(c: FixtureCase): GameSnapshot {
  const opponent = c.opponent;
  return {
    board: { cols: COLS, rows: ROWS, grid: gridFromBottomUp(c.board) },
    active: { kind: c.active, rotation: 0, cells: [], posX: 3, posY: 0 },
    ghostY: null,
    hold: c.hold,
    canHold: c.canHold,
    next: c.next,
    score: 0,
    lines: 0,
    level: 1,
    gameOver: false,
    combo: c.combo,
    b2b: c.b2b,
    nativeCombo: c.combo,
    nativeBtb: c.b2b ? 1 : 0,
    lockId: 0,
    lastAction: "None",
    lastRawAttack: 0,
    pendingGarbage: c.pendingGarbage,
    lastAttack: 0,
    lastBlocked: 0,
    ...(opponent === undefined
      ? {}
      : {
          opponentLockId: opponent.lockId,
          ...(opponent.lastClearLines === undefined
            ? {}
            : { opponentLastClearLines: opponent.lastClearLines }),
          ...(opponent.lastNativeCombo === undefined
            ? {}
            : { opponentLastNativeCombo: opponent.lastNativeCombo }),
          ...(opponent.lastNativeBtb === undefined
            ? {}
            : { opponentLastNativeBtb: opponent.lastNativeBtb }),
          ...(opponent.lastRawAttack === undefined
            ? {}
            : { opponentLastRawAttack: opponent.lastRawAttack }),
          ...(opponent.combo === undefined ? {} : { opponentCombo: opponent.combo }),
          ...(opponent.btb === undefined ? {} : { opponentBtb: opponent.btb }),
        }),
  };
}

function placementStep(steps: readonly AiExecutionStep[] | undefined): AiExecutionStep | undefined {
  return steps?.find((step) => step.kind === "placeAt");
}

const payload = JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: FixtureCase[] };
const CASES = payload.cases;

describe("deepseek v2 wasm parity", () => {
  test(
    "wasm fighter returns the same live move as the TS fighter",
    { timeout: 120000 },
    () => {
      const mismatches: string[] = [];
      for (const c of CASES) {
        const ts = createDeepSeekV2(c.options ?? {});
        const rust = createRustDeepSeekV2(c.options ?? {});
        const snap = snapshot(c);
        const tsMove = ts.findBestMove(snap);
        const rustMove = rust.findBestMove(snap);
        if (tsMove === null || rustMove === null) {
          mismatches.push(
            `${c.name}: null move (ts=${tsMove === null}, rust=${rustMove === null})`,
          );
          continue;
        }
        if (
          rustMove.targetX !== tsMove.targetX ||
          rustMove.targetRotation !== tsMove.targetRotation ||
          rustMove.useHold !== tsMove.useHold
        ) {
          mismatches.push(
            `${c.name}: ts=(${tsMove.targetX},${tsMove.targetRotation},${tsMove.useHold}) rust=(${rustMove.targetX},${rustMove.targetRotation},${rustMove.useHold})`,
          );
          continue;
        }
        if (!tsMove.useHold) {
          const tsStep = JSON.stringify(placementStep(tsMove.execution?.steps));
          const rustStep = JSON.stringify(placementStep(rustMove.execution?.steps));
          if (tsStep !== rustStep) {
            mismatches.push(`${c.name}: placeAt ts=${tsStep} rust=${rustStep}`);
          }
        }
      }
      expect(mismatches).toEqual([]);
    },
    120000,
  );

  test(
    "wasm fighter reproduces the recorded TS fixture at the recorded piece index",
    { timeout: 120000 },
    () => {
      const mismatches: string[] = [];
      for (const c of CASES) {
        const rust = createRustDeepSeekV2(c.options ?? {});
        rust.engine.pieceIndex = c.pieces - 1;
        const move = rust.findBestMove(snapshot(c));
        if (move === null) {
          mismatches.push(`${c.name}: null move`);
          continue;
        }
        if (
          move.targetX !== c.expected.targetX ||
          move.targetRotation !== c.expected.targetRotation ||
          move.useHold !== c.expected.useHold
        ) {
          mismatches.push(
            `${c.name}: expected (${c.expected.targetX},${c.expected.targetRotation},${c.expected.useHold}) got (${move.targetX},${move.targetRotation},${move.useHold})`,
          );
          continue;
        }
        if (rust.getDebug()?.pieceIndex !== c.pieces) {
          mismatches.push(`${c.name}: piece index ${rust.getDebug()?.pieceIndex} != ${c.pieces}`);
        }
      }
      expect(mismatches).toEqual([]);
    },
  );
});
