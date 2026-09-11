// Generates the DeepSeek v2 parity fixture consumed by
// rust/hoiko-deepseek/tests/v2_parity.rs.
//
// Usage: bun tools/deepseek-v2-fixture.ts
//
// Each case primes a fresh `createDeepSeekV2()` fighter with `pieces - 1`
// throwaway calls so the recorded move reflects that piece index, then stores
// the TS v2 best move for the Rust port to reproduce. Priming uses a trivial
// one-ply snapshot: the fighter's only cross-call state is its piece counter,
// so this reproduces the exact same `pieces` value without paying for a deep
// search on every discarded call.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createDeepSeekV2, type DeepSeekV2Options } from "../src/ai/deepseek-v2.js";
import type { CellValue, GameSnapshot, PieceKind } from "../src/ui/types.js";

const ROWS = 20;
const COLS = 10;
const OUT = new URL(
  "../rust/hoiko-deepseek/tests/fixtures/deepseek_v2_parity.json",
  import.meta.url,
);

interface OpponentSpec {
  readonly lockId: number;
  readonly lastClearLines?: number | undefined;
  readonly lastNativeCombo?: number | undefined;
  readonly lastNativeBtb?: number | undefined;
  readonly lastRawAttack?: number | undefined;
  readonly combo?: number | undefined;
  readonly btb?: number | undefined;
}

interface CaseSpec {
  readonly name: string;
  readonly bottomUp: readonly number[];
  readonly active: PieceKind;
  readonly next: readonly PieceKind[];
  readonly hold: PieceKind | null;
  readonly canHold: boolean;
  readonly b2b: boolean;
  readonly combo: number;
  readonly pendingGarbage: number;
  readonly pieces: number;
  readonly opponent?: OpponentSpec | undefined;
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

function toSnapshot(spec: CaseSpec): GameSnapshot {
  const opponent = spec.opponent;
  return {
    board: { cols: COLS, rows: ROWS, grid: gridFromBottomUp(spec.bottomUp) },
    active: { kind: spec.active, rotation: 0, cells: [], posX: 3, posY: 0 },
    ghostY: null,
    hold: spec.hold,
    canHold: spec.canHold,
    next: spec.next,
    score: 0,
    lines: 0,
    level: 1,
    gameOver: false,
    combo: spec.combo,
    b2b: spec.b2b,
    nativeCombo: spec.combo,
    nativeBtb: spec.b2b ? 1 : 0,
    lockId: 0,
    lastAction: "None",
    lastRawAttack: 0,
    pendingGarbage: spec.pendingGarbage,
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

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function shuffledKinds(rand: () => number): PieceKind[] {
  const kinds: PieceKind[] = ["I", "O", "T", "S", "Z", "J", "L"];
  for (let i = kinds.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const a = kinds[i];
    const b = kinds[j];
    if (a !== undefined && b !== undefined) {
      kinds[i] = b;
      kinds[j] = a;
    }
  }
  return kinds;
}

function randomBoard(rand: () => number): number[] {
  const maxHeight = 1 + Math.floor(rand() * 15);
  const rows = new Array<number>(ROWS).fill(0);
  for (let x = 0; x < COLS; x += 1) {
    const h = Math.floor(rand() * (maxHeight + 1));
    for (let y = 0; y < h; y += 1) {
      if (rand() < 0.88) rows[y] = (rows[y] ?? 0) | (1 << x);
    }
  }
  for (let y = 0; y < ROWS; y += 1) {
    if (rows[y] === 0x3ff) rows[y] = 0x3ff & ~(1 << Math.floor(rand() * COLS));
  }
  return rows;
}

function randomOpponent(rand: () => number): OpponentSpec | undefined {
  const roll = rand();
  if (roll < 0.3) return undefined;
  const lockId = 1 + Math.floor(rand() * 8);
  if (roll < 0.6) {
    // Whiff window: no clear / combo / b2b -> vuln = 1.
    return { lockId, lastClearLines: 0, lastNativeCombo: 0, lastNativeBtb: 0, lastRawAttack: 0 };
  }
  const combo = Math.floor(rand() * 6);
  const btb = rand() < 0.5 ? 1 : 0;
  const lastRawAttack = Math.floor(rand() * 6);
  return {
    lockId,
    lastClearLines: 1 + Math.floor(rand() * 4),
    lastNativeCombo: combo,
    lastNativeBtb: btb,
    lastRawAttack,
  };
}

const PIECE_INDICES = [1, 2, 7, 15, 29, 30, 31, 44, 59, 60, 61, 90, 120, 149, 150, 151, 220];

// A standard TSD notch: row0 missing col4, row1 missing cols 3/4/5.
const TSD_ROWS: readonly number[] = [0x3ff ^ (1 << 4), 0x3ff ^ (1 << 3) ^ (1 << 4) ^ (1 << 5)];

const HAND_BOARDS: readonly (readonly number[])[] = [
  [0b1111111110, 0b1111111110, 0b1011111110, 0b1100111110, 0b1111000000],
  [0b0111111111, 0b1111111110, 0b1111011111, 0b1111111101, 0b0111111111, 0b1111101111],
  [0b1111111110, 0b1111111110, 0b1111111110, 0b1111111110],
  [0b1111111110, 0b0111111111, 0b1111111110, 0b1110111111, 0b1111111011, 0b1011111111],
  [0b1000000001, 0b1000000001, 0b1111111111, 0b1111111111, 0b1111111111, 0b1111111111],
  [0b0000000000, 0b0000000000, 0b0000010000, 0b0000111000, 0b0001111100, 0b0011111110],
  // Overhang / cavity stacks that force SRS kicks and tucks.
  [0b1111111100, 0b1111111100, 0b0011111111, 0b0011111111, 0b1111111111],
  [0b1111011111, 0b1111011111, 0b1111111111, 0b1111111111, 0b1111101111, 0b1111111111],
  [0b1111111111, 0b1111111111, 0b0111111111, 0b1111111111, 0b1111111111],
  [...TSD_ROWS, 0b1111111111],
  [...TSD_ROWS, 0],
  [...TSD_ROWS, 0b1000000001],
];

const EMPTY_BOARD = new Array<number>(ROWS).fill(0);

const OPTION_VARIANTS: readonly DeepSeekV2Options[] = [
  { useKicks: false },
  { useKicks: false, depth: 4 },
  { depth: 5, width: 12, topK: 8 },
  { useOpponent: false },
  { useGarbageDefense: false, useDownstack: false },
  { useKicks: false, useOpponent: false, useGarbageDefense: false, useDownstack: false },
  { depth: 3, width: 8, topK: 4, useKicks: false },
  { width: 40, topK: 24 },
];

function buildCases(): CaseSpec[] {
  const specs: CaseSpec[] = [];
  const add = (spec: CaseSpec): void => {
    specs.push(spec);
  };

  for (let i = 0; i < 60; i += 1) {
    const rand = lcg(0x9e3779b9 ^ ((i + 1) * 2654435761));
    const kinds = shuffledKinds(rand);
    const board = i % 9 === 0 ? EMPTY_BOARD : randomBoard(rand);
    add({
      name: `rand-${i.toString().padStart(2, "0")}`,
      bottomUp: board,
      active: kinds[0] as PieceKind,
      next: kinds.slice(1),
      hold: rand() < 0.4 ? (kinds[Math.floor(rand() * 7)] as PieceKind) : null,
      canHold: rand() < 0.85,
      b2b: rand() < 0.45,
      combo: Math.floor(rand() * 9) - 1,
      pendingGarbage: Math.floor(rand() * 13),
      pieces: PIECE_INDICES[i % PIECE_INDICES.length] as number,
      opponent: randomOpponent(rand),
    });
  }

  for (let i = 0; i < HAND_BOARDS.length; i += 1) {
    const board = HAND_BOARDS[i] as readonly number[];
    const actives: readonly PieceKind[] = i % 3 === 0 ? ["T", "I", "L"] : ["I", "T", "S"];
    for (const active of actives) {
      add({
        name: `hand-${i}-${active}`,
        bottomUp: board,
        active,
        next: ["I", "O", "T", "S", "Z", "J", "L"],
        hold: i % 2 === 0 ? null : "I",
        canHold: true,
        b2b: i % 3 === 0,
        combo: i % 5,
        pendingGarbage: (i * 3) % 13,
        pieces: PIECE_INDICES[(i * 3) % PIECE_INDICES.length] as number,
        opponent: randomOpponent(lcg(0x1234 ^ (i * 7919))),
      });
    }
  }

  // Non-default option coverage: same positional shapes, varied search config.
  for (let i = 0; i < OPTION_VARIANTS.length; i += 1) {
    const board = HAND_BOARDS[i % HAND_BOARDS.length] as readonly number[];
    add({
      name: `opt-${i}`,
      bottomUp: board,
      active: (i % 2 === 0 ? "T" : "I") as PieceKind,
      next: ["I", "O", "T", "S", "Z", "J", "L"],
      hold: i % 3 === 0 ? "L" : null,
      canHold: true,
      b2b: i % 2 === 0,
      combo: i % 4,
      pendingGarbage: (i * 5) % 13,
      pieces: (PIECE_INDICES[(i * 2) % PIECE_INDICES.length] ?? 1) as number,
      opponent: randomOpponent(lcg(0xabcd ^ (i * 2654435761))),
      options: OPTION_VARIANTS[i] as DeepSeekV2Options,
    });
  }

  // Explicit opponent-state coverage on the same stack.
  const oppStack = HAND_BOARDS[4] as readonly number[];
  const oppVariants: readonly (OpponentSpec | undefined)[] = [
    undefined,
    { lockId: 9, lastClearLines: 0, lastNativeCombo: 0, lastNativeBtb: 0, lastRawAttack: 0 },
    { lockId: 9, lastClearLines: 4, lastNativeCombo: 3, lastNativeBtb: 1, lastRawAttack: 5 },
    { lockId: 9, lastNativeCombo: 2, lastNativeBtb: 1, lastRawAttack: 3 },
  ];
  for (let i = 0; i < oppVariants.length; i += 1) {
    add({
      name: `opp-${i}`,
      bottomUp: oppStack,
      active: "T",
      next: ["I", "O", "S", "Z", "J", "L", "T"],
      hold: null,
      canHold: true,
      b2b: false,
      combo: 3,
      pendingGarbage: 6,
      pieces: [1, 61, 150, 31][i] as number,
      opponent: oppVariants[i],
    });
  }

  return specs;
}

function padBottomUp(bottomUp: readonly number[]): number[] {
  const out = new Array<number>(ROWS).fill(0);
  for (let y = 0; y < bottomUp.length && y < ROWS; y += 1) out[y] = bottomUp[y] ?? 0;
  return out;
}

function primeSnapshot(spec: CaseSpec): GameSnapshot {
  return toSnapshot({
    ...spec,
    bottomUp: EMPTY_BOARD,
    next: [spec.active],
    hold: null,
    canHold: true,
    opponent: undefined,
  });
}

interface FixtureCase {
  readonly name: string;
  readonly board: number[];
  readonly active: PieceKind;
  readonly next: readonly PieceKind[];
  readonly hold: PieceKind | null;
  readonly canHold: boolean;
  readonly b2b: boolean;
  readonly combo: number;
  readonly pendingGarbage: number;
  readonly pieces: number;
  readonly opponent?: OpponentSpec;
  readonly options?: DeepSeekV2Options;
  readonly expected: {
    readonly targetX: number;
    readonly targetRotation: number;
    readonly useHold: boolean;
  };
}

function main(): void {
  const skipped: string[] = [];
  const cases: FixtureCase[] = [];
  for (const spec of buildCases()) {
    const snapshot = toSnapshot(spec);
    const fighter = createDeepSeekV2(spec.options ?? {});
    const prime = primeSnapshot(spec);
    for (let i = 0; i < spec.pieces - 1; i += 1) fighter.findBestMove(prime);
    const move = fighter.findBestMove(snapshot);
    if (move === null) {
      skipped.push(spec.name);
      continue;
    }
    const debug = fighter.getDebug();
    if (debug !== null && debug.pieceIndex !== spec.pieces) {
      throw new Error(`piece index mismatch for ${spec.name}`);
    }
    cases.push({
      name: spec.name,
      board: padBottomUp(spec.bottomUp),
      active: spec.active,
      next: spec.next,
      hold: spec.hold,
      canHold: spec.canHold,
      b2b: spec.b2b,
      combo: spec.combo,
      pendingGarbage: spec.pendingGarbage,
      pieces: spec.pieces,
      ...(spec.opponent === undefined ? {} : { opponent: spec.opponent }),
      ...(spec.options === undefined ? {} : { options: spec.options }),
      expected: {
        targetX: move.targetX,
        targetRotation: move.targetRotation,
        useHold: move.useHold,
      },
    });
  }
  const payload = {
    generatedBy: "tools/deepseek-v2-fixture.ts",
    depth: 7,
    cases,
  };
  mkdirSync(new URL(".", OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  execFileSync("bunx", ["biome", "format", "--write", OUT.pathname], { stdio: "ignore" });
  process.stdout.write(
    `wrote ${cases.length} cases to ${OUT.pathname} (skipped ${skipped.length}: ${skipped.join(", ")})\n`,
  );
}

main();
