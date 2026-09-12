// Generates the PCO opening book data consumed by `src/ai/opening-book.ts`.
//
// The book is the standard Perfect Clear Opener (PCO) first-bag shape: a 4x4
// square (I/J/L/O) on one side plus a T/S/Z stack on the other, leaving a
// 3-piece perfect-clear cavity.  For every one of the 7! = 5040 possible first
// bags we search for a legal assembly (hard drops + SRS kicks, optionally one
// hold) that produces the exact target board without clearing a line.  Bags
// that admit a line become book entries; the rest are left to the search.
//
// Run: `bun scripts/gen-opening-book.ts`
// Output: `src/ai/opening-book-data.ts` (deterministic).

import { enumerateKickPlacements } from "../src/ai/search.js";
import { createBoard } from "../src/core/board.js";
import { bottomCellsOf, type PieceKind } from "../src/core/pieces.js";

const ROWS = 20;

// PCO first-bag shape, bottom-up (bit x = column x).
const PCO_ROWS: readonly number[] = [0x38f, 0x3cf, 0x38f, 0x30f];

interface TilingPiece {
  readonly kind: PieceKind;
  readonly rotation: number;
  readonly x: number;
  readonly y: number;
  readonly mask: readonly number[];
}
type Tiling = readonly TilingPiece[];

interface Action {
  readonly kind: "place" | "hold";
  readonly placement?: TilingPiece;
}
type Line = readonly Action[];

const KINDS: readonly PieceKind[] = ["I", "O", "T", "S", "Z", "J", "L"];

function mirrorRows(rows: readonly number[]): number[] {
  return rows.map((value) => {
    let out = 0;
    for (let x = 0; x < 10; x += 1) if ((value & (1 << x)) !== 0) out |= 1 << (9 - x);
    return out;
  });
}

function rotationCount(kind: PieceKind): number {
  return kind === "O" ? 1 : 4;
}

/** Cells this piece would occupy at (rotation, x, y), or null if it leaves the target. */
function targetCells(
  rows: readonly number[],
  kind: PieceKind,
  rotation: number,
  x: number,
  y: number,
): number[] | null {
  const out = [0, 0, 0, 0];
  for (const cell of bottomCellsOf(kind, rotation)) {
    const cx = x + cell.x;
    const cy = y + cell.y;
    if (cx < 0 || cx >= 10 || cy < 0 || cy >= 4) return null;
    if (((rows[cy] ?? 0) & (1 << cx)) === 0) return null;
    out[cy] = (out[cy] ?? 0) | (1 << cx);
  }
  return out;
}

function enumerateTilings(rows: readonly number[]): Tiling[] {
  const placements = new Map<PieceKind, TilingPiece[]>();
  for (const kind of KINDS) {
    const list: TilingPiece[] = [];
    for (let rotation = 0; rotation < rotationCount(kind); rotation += 1) {
      for (let x = -2; x < 10; x += 1) {
        for (let y = 0; y < 4; y += 1) {
          const mask = targetCells(rows, kind, rotation, x, y);
          if (mask !== null) list.push({ kind, rotation, x, y, mask });
        }
      }
    }
    placements.set(kind, list);
  }
  const tilings: Tiling[] = [];
  const current: TilingPiece[] = [];
  const used = new Set<PieceKind>();
  const recurse = (occupied: readonly number[]): void => {
    let lowest = -1;
    for (let y = 0; y < 4 && lowest < 0; y += 1) {
      for (let x = 0; x < 10; x += 1) {
        if (((rows[y] ?? 0) & (1 << x)) !== 0 && ((occupied[y] ?? 0) & (1 << x)) === 0) {
          lowest = y * 10 + x;
          break;
        }
      }
    }
    if (lowest < 0) {
      tilings.push([...current]);
      return;
    }
    const ly = Math.floor(lowest / 10);
    const lx = lowest % 10;
    for (const kind of KINDS) {
      if (used.has(kind)) continue;
      for (const piece of placements.get(kind) ?? []) {
        if (((piece.mask[ly] ?? 0) & (1 << lx)) === 0) continue;
        let overlap = false;
        for (let y = 0; y < 4; y += 1) {
          if (((piece.mask[y] ?? 0) & (occupied[y] ?? 0)) !== 0) overlap = true;
        }
        if (overlap) continue;
        used.add(kind);
        current.push(piece);
        recurse(occupied.map((value, y) => value | (piece.mask[y] ?? 0)));
        current.pop();
        used.delete(kind);
      }
    }
  };
  recurse([0, 0, 0, 0]);
  return tilings;
}

interface Solver {
  solved: Map<string, Line>;
  total: number;
}

function solveTarget(rows: readonly number[]): Solver {
  const tilings = enumerateTilings(rows);
  const matchCache = new Map<string, boolean>();
  const matches = (board: Uint16Array, piece: TilingPiece): boolean => {
    const key = `${board[0]},${board[1]},${board[2]},${board[3]}|${piece.kind}${piece.rotation},${piece.x},${piece.y}`;
    const cached = matchCache.get(key);
    if (cached !== undefined) return cached;
    const want = [0, 1, 2, 3].map((y) => (board[y] ?? 0) | (piece.mask[y] ?? 0));
    let found = false;
    for (const candidate of enumerateKickPlacements(board, piece.kind)) {
      if (candidate.linesCleared !== 0) continue;
      let same = true;
      for (let y = 0; y < 4; y += 1) {
        if ((candidate.after[y] ?? 0) !== (want[y] ?? 0)) same = false;
      }
      if (same) {
        found = true;
        break;
      }
    }
    matchCache.set(key, found);
    return found;
  };

  const schedule = (order: readonly PieceKind[], tiling: Tiling): Line | null => {
    const byKind = new Map<PieceKind, TilingPiece>();
    for (const piece of tiling) byKind.set(piece.kind, piece);
    const board = createBoard(ROWS);
    const actions: Action[] = [];
    let hold: PieceKind | null = null;
    let canHold = true;
    let index = 0;

    const place = (kind: PieceKind): boolean => {
      const piece = byKind.get(kind);
      if (piece === undefined || !matches(board, piece)) return false;
      for (let y = 0; y < 4; y += 1) board[y] = (board[y] ?? 0) | (piece.mask[y] ?? 0);
      actions.push({ kind: "place", placement: piece });
      canHold = true;
      return true;
    };

    while (index < order.length || hold !== null) {
      if (hold !== null) {
        const piece = byKind.get(hold);
        if (piece !== undefined && matches(board, piece)) {
          place(hold);
          hold = null;
          continue;
        }
      }
      if (index >= order.length) {
        if (hold === null) break;
        if (!canHold) return null;
        const held = hold;
        const piece = byKind.get(held);
        if (piece === undefined || !matches(board, piece)) return null;
        // Swap the held bag piece in against the next bag's first piece, then place it.
        actions.push({ kind: "hold" });
        for (let y = 0; y < 4; y += 1) board[y] = (board[y] ?? 0) | (piece.mask[y] ?? 0);
        actions.push({ kind: "place", placement: piece });
        hold = null;
        continue;
      }
      const incoming = order[index] as PieceKind;
      index += 1;
      const piece = byKind.get(incoming);
      if (piece !== undefined && matches(board, piece)) {
        place(incoming);
        continue;
      }
      if (!canHold) return null;
      if (hold === null) {
        actions.push({ kind: "hold" });
        hold = incoming;
        canHold = false;
      } else {
        const old = hold;
        actions.push({ kind: "hold" });
        hold = incoming;
        canHold = false;
        const oldPiece = byKind.get(old);
        if (oldPiece === undefined || !matches(board, oldPiece)) return null;
        for (let y = 0; y < 4; y += 1) board[y] = (board[y] ?? 0) | (oldPiece.mask[y] ?? 0);
        actions.push({ kind: "place", placement: oldPiece });
        canHold = true;
      }
    }
    for (let y = 0; y < 4; y += 1) {
      if ((board[y] ?? 0) !== (rows[y] ?? 0)) return null;
    }
    return actions;
  };

  const solved = new Map<string, Line>();
  for (const order of permutations(KINDS)) {
    const key = order.join("");
    for (const tiling of tilings) {
      const line = schedule(order, tiling);
      if (line !== null) {
        solved.set(key, line);
        break;
      }
    }
  }
  return { solved, total: 5040 };
}

function* permutations<T>(items: readonly T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const permutation of permutations(rest)) yield [items[i] as T, ...permutation];
  }
}

/** h = hold; otherwise `<kind><rotation><x+2 base36><y>`. */
function encodeActions(line: Line): string {
  let out = "";
  for (const action of line) {
    if (action.kind === "hold") {
      out += "h";
      continue;
    }
    const piece = action.placement;
    if (piece === undefined) throw new Error("place action without placement");
    out += `${piece.kind}${piece.rotation}${(piece.x + 2).toString(36)}${piece.y}`;
  }
  return out;
}

async function main(): Promise<void> {
  const main = solveTarget(PCO_ROWS);
  const mirror = solveTarget(mirrorRows(PCO_ROWS));
  const entries = new Map<string, string>();
  for (const [key, line] of main.solved) entries.set(key, encodeActions(line));
  for (const [key, line] of mirror.solved) {
    if (!entries.has(key)) entries.set(key, encodeActions(line));
  }
  const sorted = [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const lines: string[] = [];
  lines.push("// AUTO-GENERATED by scripts/gen-opening-book.ts — do not edit.");
  lines.push("//");
  lines.push("// PCO first-bag lines: key = the seven first-bag pieces in order, value =");
  lines.push("// encoded actions ('h' = hold, else <kind><rotation><x+2 base36><y>).");
  lines.push("// Only bags whose exact shape is legally assemblable are present.");
  lines.push("");
  lines.push("export const OPENING_BOOK_DATA: Readonly<Record<string, string>> = {");
  for (const [key, value] of sorted) lines.push(`  ${key}: ${JSON.stringify(value)},`);
  lines.push("};");
  lines.push("");
  const out = lines.join("\n");
  const path = new URL("../src/ai/opening-book-data.ts", import.meta.url).pathname;
  await Bun.write(path, out);
  console.log(
    `opening book: ${sorted.length}/5040 bags covered (main ${main.solved.size}, mirror ${mirror.solved.size}); wrote ${out.length} bytes`,
  );
}

await main();
