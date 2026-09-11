// Measures TypeScript DeepSeek v2 ms/move over the same fixture the Rust
// benchmark uses, so the two implementations can be compared directly.
//
// Usage: bun tools/bench-deepseek-v2.ts
import { readFileSync } from "node:fs";
import { createDeepSeekV2, type DeepSeekV2Options } from "../src/ai/deepseek-v2.js";
import type { CellValue, GameSnapshot, PieceKind } from "../src/ui/types.js";

const ROWS = 20;
const COLS = 10;
const FIXTURE = new URL(
  "../rust/hoiko-deepseek/tests/fixtures/deepseek_v2_parity.json",
  import.meta.url,
);

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
  readonly opponent?: {
    readonly lockId: number;
    readonly lastClearLines?: number | undefined;
    readonly lastNativeCombo?: number | undefined;
    readonly lastNativeBtb?: number | undefined;
    readonly lastRawAttack?: number | undefined;
    readonly combo?: number | undefined;
    readonly btb?: number | undefined;
  };
  readonly options?: DeepSeekV2Options;
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
  opponent: FixtureCase["opponent"],
): GameSnapshot {
  return {
    board: { cols: COLS, rows: ROWS, grid: gridFromBottomUp(bottomUp) },
    active: { kind: c.active, rotation: 0, cells: [], posX: 3, posY: 0 },
    ghostY: null,
    hold,
    canHold: true,
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

function timedMove(c: FixtureCase): number {
  const fighter = createDeepSeekV2(c.options ?? {});
  const prime = snapshot(c, EMPTY, [c.active], null, undefined);
  for (let i = 0; i < c.pieces - 1; i += 1) fighter.findBestMove(prime);
  const real = snapshot(c, c.board, c.next, c.hold, c.opponent);
  const start = performance.now();
  fighter.findBestMove(real);
  return performance.now() - start;
}

function main(): void {
  const payload = JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: FixtureCase[] };
  const cases = payload.cases;

  for (let i = 0; i < Math.min(5, cases.length); i += 1) {
    const c = cases[i];
    if (c !== undefined) timedMove(c);
  }

  let total = 0;
  for (const c of cases) total += timedMove(c);
  process.stdout.write(
    `deepseek v2 TS bench: ${cases.length} positions, total ${total.toFixed(2)} ms, ms/move ${(total / cases.length).toFixed(4)}\n`,
  );
}

main();
