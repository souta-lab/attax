// Generates the DeepSeek parity fixture consumed by
// rust/deepseek-rust/tests/parity.rs.
//
// Usage: bun tools/deepseek-fixture.ts
//
// Each case primes a fresh `createDeepSeekTetris()` fighter with `pieces - 1`
// throwaway calls so the recorded move reflects that piece index, then stores
// the TS best move for the Rust port to reproduce.
import { mkdirSync, writeFileSync } from "node:fs";
import { createDeepSeekTetris } from "../src/ai/deepseek.js";
import type { CellValue, GameSnapshot, PieceKind } from "../src/ui/types.js";

const ROWS = 20;
const COLS = 10;
const OUT = new URL("../rust/deepseek-rust/tests/fixtures/deepseek_parity.json", import.meta.url);

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
      if (rand() < 0.9) rows[y] = (rows[y] ?? 0) | (1 << x);
    }
  }
  for (let y = 0; y < ROWS; y += 1) {
    if (rows[y] === 0x3ff) rows[y] = 0x3ff & ~(1 << Math.floor(rand() * COLS));
  }
  return rows;
}

const PIECE_INDICES = [1, 2, 7, 15, 29, 30, 31, 44, 59, 60, 61, 90, 120, 149, 150, 151, 220];

const HAND_BOARDS: readonly (readonly number[])[] = [
  [0b1111111110, 0b1111111110, 0b1011111110, 0b1100111110, 0b1111000000],
  [0b0111111111, 0b1111111110, 0b1111011111, 0b1111111101, 0b0111111111, 0b1111101111],
  [0b1111111110, 0b1111111110, 0b1111111110, 0b1111111110],
  [0b1111111110, 0b0111111111, 0b1111111110, 0b1110111111, 0b1111111011, 0b1011111111],
  [0b1000000001, 0b1000000001, 0b1111111111, 0b1111111111, 0b1111111111, 0b1111111111],
  [0b0000000000, 0b0000000000, 0b0000010000, 0b0000111000, 0b0001111100, 0b0011111110],
];

const EMPTY_BOARD = new Array<number>(ROWS).fill(0);

function buildCases(): CaseSpec[] {
  const specs: CaseSpec[] = [];
  const add = (spec: CaseSpec): void => {
    specs.push(spec);
  };

  for (let i = 0; i < 34; i += 1) {
    const rand = lcg(0x9e3779b9 ^ ((i + 1) * 2654435761));
    const kinds = shuffledKinds(rand);
    const board = i % 7 === 0 ? EMPTY_BOARD : randomBoard(rand);
    add({
      name: `rand-${i.toString().padStart(2, "0")}`,
      bottomUp: board,
      active: kinds[0] as PieceKind,
      next: kinds.slice(1),
      hold: rand() < 0.35 ? (kinds[Math.floor(rand() * 7)] as PieceKind) : null,
      canHold: rand() < 0.8,
      b2b: rand() < 0.4,
      combo: Math.floor(rand() * 8) - 1,
      pendingGarbage: Math.floor(rand() * 11),
      pieces: PIECE_INDICES[i % PIECE_INDICES.length] as number,
    });
  }

  for (let i = 0; i < HAND_BOARDS.length; i += 1) {
    const board = HAND_BOARDS[i] as readonly number[];
    for (const active of ["I", "T", "L"] as const) {
      add({
        name: `hand-${i}-${active}`,
        bottomUp: board,
        active,
        next: ["I", "O", "T", "S", "Z", "J", "L"],
        hold: i % 2 === 0 ? null : "I",
        canHold: true,
        b2b: i % 3 === 0,
        combo: i % 5,
        pendingGarbage: (i * 3) % 11,
        pieces: PIECE_INDICES[(i * 3) % PIECE_INDICES.length] as number,
      });
    }
  }
  return specs;
}

function padBottomUp(bottomUp: readonly number[]): number[] {
  const out = new Array<number>(ROWS).fill(0);
  for (let y = 0; y < bottomUp.length && y < ROWS; y += 1) out[y] = bottomUp[y] ?? 0;
  return out;
}

function main(): void {
  const cases = buildCases().map((spec) => {
    const snapshot = toSnapshot(spec);
    const fighter = createDeepSeekTetris();
    for (let i = 0; i < spec.pieces - 1; i += 1) fighter.findBestMove(snapshot);
    const move = fighter.findBestMove(snapshot);
    if (move === null) throw new Error(`no move for ${spec.name}`);
    const debug = fighter.getDebug();
    if (debug !== null && debug.pieceIndex !== spec.pieces) {
      throw new Error(`piece index mismatch for ${spec.name}`);
    }
    return {
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
      expected: {
        targetX: move.targetX,
        targetRotation: move.targetRotation,
        useHold: move.useHold,
      },
    };
  });
  const payload = {
    generatedBy: "tools/deepseek-fixture.ts",
    depth: 6,
    cases,
  };
  mkdirSync(new URL(".", OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`wrote ${cases.length} cases to ${OUT.pathname}\n`);
}

main();
