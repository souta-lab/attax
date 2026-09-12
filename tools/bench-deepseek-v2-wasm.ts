// Measures TypeScript DeepSeek v2 vs the Rust wasm v2 over the shared parity
// fixture, so the speedup can be reported directly.
//
// Usage: bun tools/bench-deepseek-v2-wasm.ts
import { readFileSync } from "node:fs";
import { createDeepSeekV2, type DeepSeekV2Options } from "../src/ai/deepseek-v2.js";
import type { CellValue, GameSnapshot, PieceKind } from "../src/ui/types.js";
import { createRustDeepSeekV2 } from "./deepseek-rust/loader.js";

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

function snapshot(
  c: FixtureCase,
  bottomUp: readonly number[],
  next: readonly PieceKind[],
  hold: PieceKind | null,
  opponent: FixtureOpponent | undefined,
): GameSnapshot {
  return {
    board: { cols: COLS, rows: ROWS, grid: gridFromBottomUp(bottomUp) },
    active: { kind: c.active, rotation: 0, cells: [], posX: 3, posY: 0 },
    ghostY: null,
    hold,
    canHold: c.canHold,
    next,
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

const EMPTY = new Array<number>(ROWS).fill(0);

function withPieces(c: FixtureCase): GameSnapshot {
  return snapshot(c, c.board, c.next, c.hold, c.opponent);
}

function primeSnapshot(c: FixtureCase): GameSnapshot {
  return snapshot(c, EMPTY, [c.active], null, undefined);
}

function tsTimedMove(c: FixtureCase): number {
  const fighter = createDeepSeekV2(c.options ?? {});
  const prime = primeSnapshot(c);
  for (let i = 0; i < c.pieces - 1; i += 1) fighter.findBestMove(prime);
  const real = withPieces(c);
  const start = performance.now();
  fighter.findBestMove(real);
  return performance.now() - start;
}

function wasmTimedMove(c: FixtureCase): number {
  const fighter = createRustDeepSeekV2(c.options ?? {});
  fighter.engine.pieceIndex = c.pieces - 1;
  const real = withPieces(c);
  const start = performance.now();
  fighter.findBestMove(real);
  return performance.now() - start;
}

function main(): void {
  const payload = JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: FixtureCase[] };
  const cases = payload.cases;

  for (let i = 0; i < Math.min(5, cases.length); i += 1) {
    const c = cases[i];
    if (c === undefined) continue;
    tsTimedMove(c);
    wasmTimedMove(c);
  }

  let tsTotal = 0;
  let wasmTotal = 0;
  for (const c of cases) {
    tsTotal += tsTimedMove(c);
    wasmTotal += wasmTimedMove(c);
  }

  const n = cases.length;
  const tsMs = tsTotal / n;
  const wasmMs = wasmTotal / n;
  process.stdout.write(
    [
      `deepseek v2 bench: ${n} positions`,
      `TS   total ${tsTotal.toFixed(2)} ms, ms/move ${tsMs.toFixed(4)}`,
      `wasm total ${wasmTotal.toFixed(2)} ms, ms/move ${wasmMs.toFixed(4)}`,
      `speedup ${(tsTotal / wasmTotal).toFixed(2)}x`,
      "",
    ].join("\n"),
  );
}

main();
