/**
 * Exact placement generator for the bot.
 *
 * Board model: `Uint16Array(ROWS)` in ENGINE row order (index 0 = top row), low 10 bits per
 * row, bit x = column x. A piece at (rotation, x, y) occupies `cellsFor(kind, rotation)`
 * offset by (x, y) — the same coordinates the engine uses for `active` and `placeMinoAt`.
 *
 * The generator runs a breadth-first search from the spawn (or current) position over the
 * engine's own input set — shift left/right, soft drop, rotate CW/CCW with the engine's
 * first-fit SRS kick rule — and returns every distinct resting placement. A placement is
 * flagged as a spin when it can be entered by a rotation as the final input, and T-spins
 * are classified with the engine's own `classifyTspin`, so the bot never values a spin the
 * engine would not award.
 */
import { cellsFor, type PieceKind } from "../../core/pieces.js";
import { asRotation, type Kick, kickTable } from "../../core/srs.js";
import { classifyTspin, type TspinKind } from "../../core/tspin.js";
import { bottomCellsOf } from "../../core/pieces.js";

export const COLS = 10;
export const ROWS = 20;
export const FULL_ROW = 0x3ff;

export type BitBoard = Uint16Array;

/** One rotation of one piece as row masks relative to the piece origin. */
interface Shape {
  readonly cells: readonly { readonly x: number; readonly y: number }[];
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  /** `rows[i]` is the mask of row `minY + i`, relative to `minX` (shift by `x + minX`). */
  readonly rows: readonly number[];
}

const KINDS: readonly PieceKind[] = ["I", "O", "T", "S", "Z", "J", "L"];

/** `KICKS[kind][from][0]` = CW kick list, `[1]` = CCW kick list (engine order). */
const KICKS: Readonly<Record<PieceKind, readonly (readonly (readonly Kick[])[])[]>> =
  Object.fromEntries(
    KINDS.map((kind) => [
      kind,
      [0, 1, 2, 3].map((from) =>
        [1, 3].map((dir) => kickTable(kind, asRotation(from), asRotation(from + dir))),
      ),
    ]),
  ) as unknown as Record<PieceKind, readonly (readonly (readonly Kick[])[])[]>;

const SHAPES: Readonly<Record<PieceKind, readonly Shape[]>> = Object.fromEntries(
  KINDS.map((kind) => [kind, [0, 1, 2, 3].map((rotation) => buildShape(kind, rotation))]),
) as unknown as Record<PieceKind, readonly Shape[]>;

function buildShape(kind: PieceKind, rotation: number): Shape {
  const cells = cellsFor(kind, rotation);
  let minX = 9;
  let maxX = 0;
  let minY = 9;
  let maxY = 0;
  for (const c of cells) {
    minX = Math.min(minX, c.x);
    maxX = Math.max(maxX, c.x);
    minY = Math.min(minY, c.y);
    maxY = Math.max(maxY, c.y);
  }
  const rows: number[] = [];
  for (let y = minY; y <= maxY; y += 1) {
    let mask = 0;
    for (const c of cells) if (c.y === y) mask |= 1 << (c.x - minX);
    rows.push(mask);
  }
  return { cells, minX, maxX, minY, rows };
}

/** Engine collision rule: outside the side walls or floor collides; above the top is free. */
export function collides(
  board: BitBoard,
  kind: PieceKind,
  rotation: number,
  x: number,
  y: number,
): boolean {
  const shape = SHAPES[kind][rotation & 3] as Shape;
  if (x + shape.minX < 0 || x + shape.maxX >= COLS) return true;
  const rows = shape.rows;
  for (let i = 0; i < rows.length; i += 1) {
    const row = y + shape.minY + i;
    if (row >= ROWS) return true;
    if (row >= 0 && ((board[row] as number) & ((rows[i] as number) << (x + shape.minX))) !== 0) {
      return true;
    }
  }
  return false;
}

/** Engine spawn position for a freshly drawn piece. */
export function spawnPosition(kind: PieceKind): { rotation: number; x: number; y: number } {
  return { rotation: 0, x: 3, y: -(SHAPES[kind][0] as Shape).minY };
}

export interface Placement {
  readonly kind: PieceKind;
  readonly rotation: number;
  readonly x: number;
  /** Engine `topRow` for `placeMinoAt`. */
  readonly y: number;
  /** `lastSrs` to report to the engine: 0 = arrived by shift/drop, >0 = by rotation. */
  readonly lastSrs: number;
  readonly tspin: TspinKind;
}

// BFS state id: rotation (4) x row (-4..27 -> 32) x column (-3..12 -> 16).
const X_OFF = 3;
const Y_OFF = 4;
const X_SPAN = 16;
const Y_SPAN = 32;
const STATE_COUNT = 4 * Y_SPAN * X_SPAN;

const visited = new Uint32Array(STATE_COUNT);
/** Best rotation arrival into a resting state: 0 none, else engine lastSrs (1..5). */
const spinArrival = new Uint8Array(STATE_COUNT);
const spinStamp = new Uint32Array(STATE_COUNT);
const queue = new Int32Array(STATE_COUNT);
let stamp = 0;

function encode(rotation: number, x: number, y: number): number {
  return (rotation * Y_SPAN + (y + Y_OFF)) * X_SPAN + (x + X_OFF);
}

/**
 * All distinct resting placements reachable from (rotation, x, y) by engine inputs.
 * Placements that would lock entirely above the visible field are dropped (engine top-out).
 */
export function generatePlacements(
  board: BitBoard,
  kind: PieceKind,
  start: { readonly rotation: number; readonly x: number; readonly y: number } = spawnPosition(
    kind,
  ),
): Placement[] {
  const out: Placement[] = [];
  if (collides(board, kind, start.rotation, start.x, start.y)) return out;
  stamp += 1;
  if (stamp === 0xffffffff) {
    visited.fill(0);
    spinStamp.fill(0);
    stamp = 1;
  }
  const rotations = kind === "O" ? 1 : 4;
  let head = 0;
  let tail = 0;
  const resting: number[] = [];

  const visit = (rotation: number, x: number, y: number): void => {
    if (y + Y_OFF < 0 || y + Y_OFF >= Y_SPAN || x + X_OFF < 0 || x + X_OFF >= X_SPAN) return;
    const id = encode(rotation, x, y);
    if (visited[id] === stamp) return;
    if (collides(board, kind, rotation, x, y)) return;
    visited[id] = stamp;
    queue[tail++] = id;
  };

  // Open-air shortcut: while the piece is entirely above the highest block, only the walls
  // constrain it, so every wall-legal (rotation, x) is reachable by rotating then shifting.
  // Seed the search with those positions just above the stack (three rows deep, enough for
  // any SRS kick to reach down) instead of walking every open-air state from the spawn.
  let top = 0;
  while (top < ROWS && board[top] === 0) top += 1;
  const startShape = SHAPES[kind][start.rotation & 3] as Shape;
  const startBottom = start.y + startShape.minY + startShape.rows.length - 1;
  if (startBottom < top - 1) {
    for (let rotation = 0; rotation < rotations; rotation += 1) {
      const shape = SHAPES[kind][rotation] as Shape;
      const lowest = top - shape.minY - shape.rows.length;
      // A falling piece cannot move up, so never seed above its current row.
      const highest = Math.max(lowest - 2, start.y);
      for (let x = -shape.minX; x + shape.maxX < COLS; x += 1) {
        for (let y = lowest; y >= highest; y -= 1) visit(rotation, x, y);
      }
    }
  } else {
    visit(start.rotation, start.x, start.y);
  }

  while (head < tail) {
    const id = queue[head++] as number;
    const x = (id % X_SPAN) - X_OFF;
    const y = (Math.floor(id / X_SPAN) % Y_SPAN) - Y_OFF;
    const rotation = Math.floor(id / (X_SPAN * Y_SPAN));
    const grounded = collides(board, kind, rotation, x, y + 1);
    if (grounded) resting.push(id);
    visit(rotation, x - 1, y);
    visit(rotation, x + 1, y);
    if (!grounded) visit(rotation, x, y + 1);
    if (rotations === 1) continue;
    const kickSets = KICKS[kind][rotation] as readonly (readonly Kick[])[];
    for (let dir = 0; dir < 2; dir += 1) {
      const to = (rotation + (dir === 0 ? 1 : 3)) & 3;
      const kicks = kickSets[dir] as readonly Kick[];
      for (let i = 0; i < kicks.length; i += 1) {
        const kick = kicks[i] as Kick;
        const nx = x + kick.dx;
        const ny = y - kick.dy;
        if (collides(board, kind, to, nx, ny)) continue;
        // Engine `tryRotate`: first fitting kick wins; lastSrs = 1 for kick 0, else i + 1.
        const lastSrs = i === 0 ? 1 : i + 1;
        if (collides(board, kind, to, nx, ny + 1)) {
          const target = encode(to, nx, ny);
          if (spinStamp[target] !== stamp || lastSrs > (spinArrival[target] as number)) {
            spinStamp[target] = stamp;
            spinArrival[target] = lastSrs;
          }
        }
        visit(to, nx, ny);
        break;
      }
    }
  }

  const seen = new Set<number>();
  for (const id of resting) {
    const x = (id % X_SPAN) - X_OFF;
    const y = (Math.floor(id / X_SPAN) % Y_SPAN) - Y_OFF;
    const rotation = Math.floor(id / (X_SPAN * Y_SPAN));
    const shape = SHAPES[kind][rotation] as Shape;
    if (y + shape.minY + shape.rows.length - 1 < 0) continue; // locks fully above the field
    const lastSrs = spinStamp[id] === stamp ? (spinArrival[id] as number) : 0;
    const tspin = kind === "T" && lastSrs > 0 ? tspinKind(board, rotation, x, y, lastSrs) : "none";
    if (kind !== "T") {
      const key = cellKey(shape, x, y);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push({ kind, rotation, x, y, lastSrs: kind === "T" ? lastSrs : 0, tspin });
  }
  return out;
}

function cellKey(shape: Shape, x: number, y: number): number {
  let key = y + shape.minY + Y_OFF;
  for (const row of shape.rows) key = key * 1024 + (row << (x + shape.minX));
  return key;
}

/** Engine T-spin verdict, computed exactly as `engine.detectTspin` does after the lock. */
function tspinKind(
  board: BitBoard,
  rotation: number,
  x: number,
  y: number,
  lastSrs: number,
): TspinKind {
  const locked = board.slice();
  const shape = SHAPES.T[rotation] as Shape;
  for (let i = 0; i < shape.rows.length; i += 1) {
    const row = y + shape.minY + i;
    if (row >= 0) locked[row] = (locked[row] as number) | ((shape.rows[i] as number) << (x + shape.minX));
  }
  const bottomUp = new Uint16Array(ROWS);
  for (let row = 0; row < ROWS; row += 1) bottomUp[ROWS - 1 - row] = locked[row] as number;
  const cells = bottomCellsOf("T", rotation);
  let maxCellY = 0;
  for (const c of cells) maxCellY = Math.max(maxCellY, c.y);
  return classifyTspin(bottomUp, cells, x, ROWS - 1 - y - maxCellY, rotation, lastSrs);
}

export interface LockOutcome {
  readonly board: BitBoard;
  readonly linesCleared: number;
  readonly perfectClear: boolean;
}

/** Lock a placement and clear full rows (engine semantics: survivors fall, empty rows on top). */
export function lockPlacement(board: BitBoard, p: Placement): LockOutcome {
  const next = board.slice();
  const shape = SHAPES[p.kind][p.rotation] as Shape;
  for (let i = 0; i < shape.rows.length; i += 1) {
    const row = p.y + shape.minY + i;
    if (row >= 0 && row < ROWS) {
      next[row] = (next[row] as number) | ((shape.rows[i] as number) << (p.x + shape.minX));
    }
  }
  let write = ROWS - 1;
  let cleared = 0;
  for (let read = ROWS - 1; read >= 0; read -= 1) {
    const row = next[read] as number;
    if (row === FULL_ROW) {
      cleared += 1;
      continue;
    }
    next[write] = row;
    write -= 1;
  }
  for (; write >= 0; write -= 1) next[write] = 0;
  let empty = true;
  for (let row = 0; row < ROWS; row += 1) if (next[row] !== 0) empty = false;
  return { board: next, linesCleared: cleared, perfectClear: cleared > 0 && empty };
}
