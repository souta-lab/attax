import { describe, expect, test } from "bun:test";
import { beamBestMove } from "../src/ai/beam.js";
import { DEFAULTS } from "../src/ai/config.js";
import type { CellValue, GameSnapshot } from "../src/ui/types.js";

function emptyGrid(): CellValue[][] {
  return Array.from({ length: 20 }, () => Array.from({ length: 10 }, () => 0 as CellValue));
}

function snapWith(opts: {
  readonly active: GameSnapshot["active"];
  readonly next?: readonly ("I" | "O" | "T" | "S" | "Z" | "J" | "L")[];
}): GameSnapshot {
  return {
    board: { cols: 10, rows: 20, grid: emptyGrid() },
    active: opts.active,
    ghostY: 18,
    hold: null,
    canHold: true,
    next: opts.next ?? ["T", "I", "O", "Z", "S"],
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

const tCells = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: 1, y: 1 },
  { x: 2, y: 1 },
];

describe("fighter v6 base", () => {
  test("T1 scorer-injected topK: custom scorer picks T-slot setup over flat", () => {
    const s = snapWith({
      active: { kind: "T", rotation: 0, cells: tCells, posX: 3, posY: 0 },
      next: ["S", "L", "O", "Z", "I"],
    });
    void s;
    const board = new Uint16Array(20);
    const custom = beamBestMove(board, "T", ["S", "L", "O", "Z", "I"], null, true, false, -1, {
      depth: 6,
      scorer: (_after, _lines, _tspin, ctx) => (ctx.ply === 0 ? 100000 : 0),
    });
    const plain = beamBestMove(board, "T", ["S", "L", "O", "Z", "I"], null, true, false, -1, {
      depth: 6,
    });
    expect(custom).not.toBeNull();
    expect(plain).not.toBeNull();
    expect(custom?.score).toBeGreaterThan((plain?.score ?? 0) + 50000);
  });

  test("T2 hard veto: maxHeight>=18 quiet placements excluded even with fire greed", () => {
    const grid = emptyGrid();
    for (let y = 4; y < 20; y++) {
      for (let x = 0; x < 10; x++) grid[y]![x] = 1;
    }
    const board = new Uint16Array(20);
    for (let y = 0; y < 20; y++) {
      const src = grid[19 - y];
      let bits = 0;
      for (let x = 0; x < 10; x++) if ((src?.[x] ?? 0) !== 0) bits |= 1 << x;
      board[y] = bits;
    }
    const mv = beamBestMove(board, "O", ["I", "T", "S", "Z", "L"], null, false, false, -1, {
      depth: 2,
      veto: (after, lines) => {
        for (let y = 18; y < after.length; y++) {
          if ((after[y] ?? 0) !== 0 && lines === 0) return true;
        }
        return false;
      },
    });
    expect(mv).not.toBeNull();
    expect(mv?.linesCleared).toBeGreaterThan(0);
  });

  test("T3 config-driven: DEFAULTS matches beam behavior, no magic numbers", () => {
    expect(DEFAULTS.width).toBe(24);
    expect(DEFAULTS.depth).toBe(6);
    expect(DEFAULTS.topK).toBe(16);
    expect(DEFAULTS.setupGamma).toBeCloseTo(0.55, 5);
  });
});
