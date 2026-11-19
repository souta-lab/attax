import type { PieceKind } from "../../../src/core/pieces.js";
import { lab } from "../lab.mjs";

const { createGame, extendSeededQueue, toS2GuiState } = await lab("cc2-gui/game.mjs");
const { guiStateToCanonical } = await lab("src-js/gui-state.mjs");

export const TACTICAL_ARCHETYPES = [
  "high_board_14_plus",
  "heavy_pressure_avoidable_death",
  "surge_release_vs_charge",
  "active_ren_combo",
  "non_t_spin_setup",
  "b2b_mid_charge_1_4",
] as const;

export type TacticalArchetype = (typeof TACTICAL_ARCHETYPES)[number];

export interface TacticalScenario {
  readonly archetype: TacticalArchetype;
  readonly seed: number;
  readonly state: Record<string, unknown>;
  readonly bagSeed: number;
  readonly rolloutPlies: number;
}

function seededPrng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function makeEmptyGrid(): string[][] {
  return Array.from({ length: 40 }, () => Array<string>(10).fill("_"));
}

function gridToCells(grid: readonly (readonly string[])[]): string {
  return grid.flat().join("");
}

function fillRowWithHole(grid: string[][], y: number, holeCols: readonly number[], ch = "G"): void {
  const holeSet = new Set(holeCols);
  const row = grid[y];
  if (!row) return;
  for (let x = 0; x < 10; x += 1) {
    if (!holeSet.has(x)) row[x] = ch;
  }
}

function buildHighBoardGrid(rand: () => number, baseHeight: number): string[][] {
  const grid = makeEmptyGrid();
  const wellCol = Math.floor(rand() * 10);
  for (let y = 0; y < baseHeight; y += 1) {
    const isGarbage = y < Math.floor(baseHeight * 0.65);
    const hole = isGarbage ? Math.floor(rand() * 10) : wellCol;
    fillRowWithHole(grid, y, [hole], isGarbage ? "G" : "J");
  }
  // Jagged uneven top contour
  for (let x = 0; x < 10; x += 1) {
    if (x === wellCol) continue;
    const extra = Math.floor(rand() * 3);
    for (let dy = 0; dy < extra; dy += 1) {
      const yy = baseHeight + dy;
      if (yy < 19) {
        const row = grid[yy];
        if (row) row[x] = "Z";
      }
    }
  }
  return grid;
}

function buildAvoidableDeathGrid(rand: () => number): {
  readonly grid: string[][];
  readonly current: PieceKind;
  readonly hold: PieceKind;
  readonly dueRows: number;
  readonly pendingRows: number;
} {
  const grid = makeEmptyGrid();
  const height = 14 + Math.floor(rand() * 3); // 14..16
  const clearCol = rand() < 0.5 ? 9 : 0;
  // Top 3-4 rows are 9-wide (clearable by I or vertical piece), so clearing cancels/delays while dumping tanks into >20.
  for (let y = 0; y < height - 4; y += 1) {
    fillRowWithHole(grid, y, [Math.floor(rand() * 10)], "G");
  }
  for (let y = height - 4; y < height; y += 1) {
    fillRowWithHole(grid, y, [clearCol], "S");
  }
  const dueRows = 5 + Math.floor(rand() * 3); // 5..7 (total height + due = 19..23, clear rescues!)
  const pendingRows = dueRows + Math.floor(rand() * 4);
  return { grid, current: "O", hold: "I", dueRows, pendingRows };
}

function buildSurgeGrid(rand: () => number): {
  readonly grid: string[][];
  readonly current: PieceKind;
  readonly hold: PieceKind;
  readonly b2b: number;
  readonly pendingRows: number;
  readonly dueRows: number;
} {
  const grid = makeEmptyGrid();
  const wellCol = rand() < 0.5 ? 9 : 0;
  // Build clean 4-row quad well + 2 surface rows that also invite single/double release
  for (let y = 0; y < 5; y += 1) {
    fillRowWithHole(grid, y, [wellCol], y < 2 ? "G" : "L");
  }
  // Surface irregularity at height 5..7 creating quick skim vs charge decision
  const row5 = grid[5];
  const row6 = grid[6];
  if (row5 && row6) {
    for (let x = 2; x < 9; x += 1) row5[x] = "T";
    for (let x = 3; x < 7; x += 1) row6[x] = "L";
  }
  const b2b = 5 + Math.floor(rand() * 6); // 5..10 -> surge 4..9 ready
  const hasIncoming = rand() < 0.65;
  const dueRows = hasIncoming ? 1 + Math.floor(rand() * 4) : 0;
  const pendingRows = hasIncoming ? dueRows + Math.floor(rand() * 4) : 0;
  return {
    grid,
    current: rand() < 0.5 ? "I" : "T",
    hold: rand() < 0.5 ? "S" : "I",
    b2b,
    pendingRows,
    dueRows,
  };
}

function buildActiveRenGrid(rand: () => number): {
  readonly grid: string[][];
  readonly combo: number;
  readonly pendingRows: number;
  readonly dueRows: number;
} {
  const grid = makeEmptyGrid();
  const holes = [3, 4, 5, 6];
  const rows = 7 + Math.floor(rand() * 4);
  for (let y = 0; y < rows; y += 1) {
    const h1 = holes[Math.floor(rand() * holes.length)] as number;
    const h2 = rand() < 0.5 ? holes[Math.floor(rand() * holes.length)] : -1;
    fillRowWithHole(grid, y, h2 >= 0 ? [h1, h2] : [h1], y < 5 ? "G" : "J");
  }
  return {
    grid,
    combo: 2 + Math.floor(rand() * 5),
    pendingRows: Math.floor(rand() * 4),
    dueRows: Math.floor(rand() * 2),
  };
}

function buildNonTSpinGrid(rand: () => number): {
  readonly grid: string[][];
  readonly current: PieceKind;
  readonly hold: PieceKind;
} {
  const grid = makeEmptyGrid();
  const variant = Math.floor(rand() * 3);
  if (variant === 0) {
    // Classic S-spin overhang at left wall (x=0..2)
    fillRowWithHole(grid, 0, [0, 1], "G");
    fillRowWithHole(grid, 1, [1, 2], "L");
    const row2 = grid[2];
    if (row2) row2[1] = "J";
    return { grid, current: "S", hold: "T" };
  }
  if (variant === 1) {
    // Classic Z-spin overhang at right wall (x=7..9)
    fillRowWithHole(grid, 0, [8, 9], "G");
    fillRowWithHole(grid, 1, [7, 8], "J");
    const row2 = grid[2];
    if (row2) row2[8] = "L";
    return { grid, current: "Z", hold: "I" };
  }
  // L-spin immobile pocket on left side (x=0..2)
  fillRowWithHole(grid, 0, [0], "G");
  fillRowWithHole(grid, 1, [0, 1, 2], "I");
  const row2 = grid[2];
  if (row2) {
    row2[0] = "O";
    row2[1] = "O";
  }
  return { grid, current: "L", hold: "J" };
}

/** Deterministically creates a realistic tactical S2 position + rollout seed. */
export function createTacticalScenario(
  tacticalSeed: number,
  archetypeIndex?: number,
): TacticalScenario {
  const rand = seededPrng(tacticalSeed);
  const idx =
    archetypeIndex ?? Math.abs(Math.imul(tacticalSeed, 2654435761)) % TACTICAL_ARCHETYPES.length;
  const archetype = TACTICAL_ARCHETYPES[idx] as TacticalArchetype;

  const game = createGame(tacticalSeed);
  const state = guiStateToCanonical(toS2GuiState(game));
  const logicalFrame = 600 + Math.floor(rand() * 12) * 180;

  let grid = makeEmptyGrid();
  let current: PieceKind = state.pieces.current;
  let hold: PieceKind | null = state.pieces.hold;
  let b2b = 0;
  let combo = 0;
  let dueRows = 0;
  let pendingRows = 0;
  let rolloutPlies = 3;

  switch (archetype) {
    case "high_board_14_plus": {
      const h = 13 + Math.floor(rand() * 4);
      grid = buildHighBoardGrid(rand, h);
      dueRows = Math.floor(rand() * 3);
      pendingRows = dueRows + Math.floor(rand() * 4);
      b2b = Math.floor(rand() * 4);
      hold = (["T", "I", "L", "S"] as PieceKind[])[Math.floor(rand() * 4)] as PieceKind;
      rolloutPlies = 4;
      break;
    }
    case "heavy_pressure_avoidable_death": {
      const spec = buildAvoidableDeathGrid(rand);
      grid = spec.grid;
      current = spec.current;
      hold = spec.hold;
      dueRows = spec.dueRows;
      pendingRows = spec.pendingRows;
      rolloutPlies = 2;
      break;
    }
    case "surge_release_vs_charge": {
      const spec = buildSurgeGrid(rand);
      grid = spec.grid;
      current = spec.current;
      hold = spec.hold;
      b2b = spec.b2b;
      dueRows = spec.dueRows;
      pendingRows = spec.pendingRows;
      rolloutPlies = 3;
      break;
    }
    case "active_ren_combo": {
      const spec = buildActiveRenGrid(rand);
      grid = spec.grid;
      combo = spec.combo;
      dueRows = spec.dueRows;
      pendingRows = spec.pendingRows;
      hold = "I";
      rolloutPlies = 4;
      break;
    }
    case "non_t_spin_setup": {
      const spec = buildNonTSpinGrid(rand);
      grid = spec.grid;
      current = spec.current;
      hold = spec.hold;
      b2b = 1 + Math.floor(rand() * 4);
      rolloutPlies = 2;
      break;
    }
    case "b2b_mid_charge_1_4": {
      const h = 5 + Math.floor(rand() * 4);
      grid = buildHighBoardGrid(rand, h);
      b2b = 1 + Math.floor(rand() * 4);
      hold = "T";
      dueRows = rand() < 0.4 ? 1 + Math.floor(rand() * 3) : 0;
      pendingRows = dueRows;
      rolloutPlies = 3;
      break;
    }
  }

  const extended = extendSeededQueue([current, ...state.pieces.known], game.bagSeed, 40);
  const packets: Array<Record<string, unknown>> = [];
  if (dueRows > 0) {
    packets.push({
      packetId: 1,
      sourceGameId: 2,
      amount: dueRows,
      holeSize: 1,
      arrivalFrame: Math.max(0, logicalFrame - 600),
      confirmed: true,
      order: 0,
    });
  }
  if (pendingRows > dueRows) {
    packets.push({
      packetId: 2,
      sourceGameId: 2,
      amount: pendingRows - dueRows,
      holeSize: 1,
      arrivalFrame: logicalFrame + 40,
      confirmed: true,
      order: packets.length,
    });
  }

  state.board = { ...state.board, cells: gridToCells(grid) };
  state.pieces = {
    ...state.pieces,
    current,
    hold,
    known: extended.queue.slice(1),
    holdAvailable: true,
  };
  state.chain = { ...state.chain, combo, b2b };
  state.garbage = { ...state.garbage, packets };
  state.time = { ...state.time, logicalFrame, piecesPlaced: 12 };

  return {
    archetype,
    seed: tacticalSeed,
    state,
    bagSeed: extended.bagSeed,
    rolloutPlies,
  };
}
