import { describe, expect, test } from "bun:test";
import { beamBestMove } from "../src/ai/beam.js";
import { createFighterA } from "../src/ai/fighterA.js";
import { createFighterB } from "../src/ai/fighterB.js";
import type { CellValue, GameSnapshot } from "../src/ui/types.js";

function emptyGrid(): CellValue[][] {
  return Array.from({ length: 20 }, () => Array.from({ length: 10 }, () => 0 as CellValue));
}

function snapWith(opts: {
  readonly active: GameSnapshot["active"];
  readonly hold?: GameSnapshot["hold"];
  readonly canHold?: boolean;
  readonly next?: readonly ("I" | "O" | "T" | "S" | "Z" | "J" | "L")[];
  readonly grid?: CellValue[][];
}): GameSnapshot {
  return {
    board: { cols: 10, rows: 20, grid: opts.grid ?? emptyGrid() },
    active: opts.active,
    ghostY: 18,
    hold: opts.hold ?? null,
    canHold: opts.canHold ?? true,
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

describe("fighter v4 contract", () => {
  test("T1 beam-equality: fighter move equals beam depth6 move on mined position", () => {
    const s = snapWith({
      active: { kind: "T", rotation: 0, cells: tCells, posX: 3, posY: 0 },
      next: ["S", "L", "O", "Z", "I"],
    });
    const board = new Uint16Array(20);
    const ref = beamBestMove(board, "T", ["S", "L", "O", "Z", "I"], null, true, false, -1, {
      depth: 6,
    });
    const a = createFighterA();
    const mv = a.findBestMove(s);
    expect(ref).not.toBeNull();
    expect(mv).not.toBeNull();
    expect(`${mv?.targetRotation},${mv?.targetX},${mv?.useHold}`).toBe(
      `${ref?.rotation},${ref?.x},${ref?.useHold}`,
    );
  });

  test("T2 empty-hold: nuisance S stashed when hold empty", () => {
    const s = snapWith({
      active: {
        kind: "S",
        rotation: 0,
        cells: [
          { x: 1, y: 0 },
          { x: 2, y: 0 },
          { x: 0, y: 1 },
          { x: 1, y: 1 },
        ],
        posX: 3,
        posY: 0,
      },
      hold: null,
      canHold: true,
      next: ["T", "I", "O", "Z", "L"],
    });
    const b = createFighterB();
    const mv = b.findBestMove(s);
    expect(mv).not.toBeNull();
    expect(mv?.useHold).toBe(true);
  });

  test("T3 well-triple: 3-deep well cleared for 3 lines not flat single", () => {
    const grid = emptyGrid();
    for (let y = 17; y < 20; y++) {
      for (let x = 0; x < 10; x++) {
        if (x !== 9) grid[y]![x] = 1;
      }
    }
    const s = snapWith({
      active: {
        kind: "I",
        rotation: 0,
        cells: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 2, y: 0 },
          { x: 3, y: 0 },
        ],
        posX: 3,
        posY: 0,
      },
      grid,
      next: ["O", "T", "S", "Z", "L"],
    });
    const a = createFighterA();
    const mv = a.findBestMove(s);
    const debug = a.getDebug();
    expect(mv).not.toBeNull();
    expect(debug?.linesCleared).toBe(3);
  });
});
