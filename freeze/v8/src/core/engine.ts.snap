/**
 * Real core engine: 7-bag + SRS-lite + hold + guideline scoring.
 * Implements the ui CorePort view-model so the existing Canvas UI works unchanged.
 * Board model: grid[y][x], y=0 is TOP row (view order). Internally uses bit ops for clears.
 */

import type {
  ActivePieceView,
  BoardView,
  CellValue,
  CorePort,
  GameSnapshot,
  LockTransition,
} from "../ui/types.js";
import { COLS, ROWS } from "../ui/types.js";
import {
  attackForClear,
  cancelPending,
  genGarbageHoles,
  type PendingChunk,
  pendingTotal,
  pushIncoming,
  tickPending,
} from "./garbage.js";
import { cellsFor, type PieceKind, pieceCellValue } from "./pieces.js";
import { asRotation, kickTable, type Rotation } from "./srs.js";

type Grid = CellValue[][];

function gridToBottomUpRows(grid: readonly (readonly CellValue[])[]): readonly number[] {
  const rows: number[] = [];
  for (let y = grid.length - 1; y >= 0; y -= 1) {
    const row = grid[y];
    let bits = 0;
    if (row !== undefined) {
      for (let x = 0; x < COLS; x += 1) {
        if ((row[x] ?? 0) !== 0) bits |= 1 << x;
      }
    }
    rows.push(bits);
  }
  return rows;
}

const BAG: readonly PieceKind[] = ["I", "O", "T", "S", "Z", "J", "L"] as const;

const LINE_SCORES: readonly number[] = [0, 100, 300, 500, 800] as const;

interface SpawnState {
  readonly kind: PieceKind;
  readonly rotation: number;
  readonly x: number;
  readonly y: number;
}

export interface EngineOptions {
  readonly random?: () => number;
}

function shuffledBag(rand: () => number): PieceKind[] {
  const bag: PieceKind[] = [...BAG];
  for (let i = bag.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const a = bag[i];
    const b = bag[j];
    if (a === undefined || b === undefined) continue;
    bag[i] = b;
    bag[j] = a;
  }
  return bag;
}

export function createEngine(options: EngineOptions = {}): CorePort {
  const rand = options.random ?? Math.random;
  let grid: Grid = emptyGrid();
  let queue: PieceKind[] = [...shuffledBag(rand), ...shuffledBag(rand)];
  let active: SpawnState | null = null;
  let hold: PieceKind | null = null;
  let canHold = true;
  let score = 0;
  let lines = 0;
  let level = 1;
  let combo = -1;
  let b2b = false;
  let gameOver = false;
  let pending: PendingChunk[] = [];
  let outbox = 0;
  let lastAttack = 0;
  let lastBlocked = 0;
  let prevGarbageHole = 4;
  let lastRotated = false;
  let lastLockTransition: LockTransition | null = null;

  function collides(kind: PieceKind, rotation: number, px: number, py: number): boolean {
    for (const c of cellsFor(kind, rotation)) {
      const x = px + c.x;
      const y = py + c.y;
      if (x < 0 || x >= COLS) return true;
      if (y >= ROWS) return true;
      if (y >= 0) {
        const row = grid[y];
        if (row !== undefined && (row[x] ?? 0) !== 0) return true;
      }
    }
    return false;
  }

  function spawn(): void {
    const kind = queue.shift();
    if (kind === undefined) return;
    if (queue.length < 7) queue.push(...shuffledBag(rand));
    const s: SpawnState = { kind, rotation: 0, x: 3, y: spawnY(kind) };
    if (collides(s.kind, s.rotation, s.x, s.y)) {
      gameOver = true;
      active = s;
      return;
    }
    active = s;
  }

  function spawnY(kind: PieceKind): number {
    const cells = cellsFor(kind, 0);
    let minY = 0;
    for (const c of cells) if (c.y < minY) minY = c.y;
    return -minY;
  }

  function applyClear(cleared: number, tspinLines: number, perfectClear: boolean): void {
    if (cleared === 0) {
      combo = -1;
      lastAttack = 0;
      lastBlocked = 0;
      return;
    }
    lines += cleared;
    const base = LINE_SCORES[cleared] ?? cleared * 200;
    const difficult = cleared === 4 || tspinLines > 0;
    const b2bBefore = b2b;
    let gained = base * level;
    if (difficult && b2bBefore) gained = Math.floor(gained * 1.5);
    combo += 1;
    if (combo > 0) gained += 50 * combo * level;
    score += gained;
    const attack = attackForClear({
      lines: cleared,
      tspinLines,
      combo,
      b2bActive: b2bBefore,
      perfectClear,
    });
    const blocked = cancelPending(pending, attack);
    lastBlocked = blocked;
    lastAttack = attack - blocked;
    outbox += attack - blocked;
    if (difficult) b2b = true;
    else b2b = false;
    level = Math.floor(lines / 10) + 1;
  }

  function lockAndSpawn(): void {
    const a = active;
    if (a === null) return;
    const value = pieceCellValue(a.kind);
    for (const c of cellsFor(a.kind, a.rotation)) {
      const x = a.x + c.x;
      const y = a.y + c.y;
      if (y >= 0 && y < ROWS && x >= 0 && x < COLS) {
        const row = grid[y];
        if (row !== undefined) row[x] = value;
      }
    }
    const tspinLines = detectTspin(a) ? countFullRows() : 0;
    const kept: Grid = [];
    let cleared = 0;
    for (const row of grid) {
      if (row.every((v) => v !== 0)) cleared += 1;
      else kept.push(row);
    }
    while (kept.length < ROWS) kept.unshift(Array.from({ length: COLS }, () => 0 as CellValue));
    grid = kept;
    const perfectClear = cleared > 0 && grid.every((row) => row.every((v) => v === 0));
    applyClear(cleared, tspinLines > 0 ? cleared : 0, perfectClear);
    canHold = true;
    if (!gameOver) {
      const due = tickPending(pending);
      lastLockTransition = {
        boardAfterLockClear: gridToBottomUpRows(grid),
        linesCleared: cleared,
        garbageRowsApplied: due,
      };
      if (due > 0) spawnGarbageRows(due);
      spawn();
    }
  }

  function countFullRows(): number {
    let n = 0;
    for (const row of grid) {
      if (row.every((v) => v !== 0)) n += 1;
    }
    return n;
  }

  function detectTspin(a: SpawnState): boolean {
    if (a.kind !== "T") return false;
    if (!lastRotated) return false;
    let cx = 0;
    let cy = 0;
    const cells = cellsFor(a.kind, a.rotation);
    for (const c of cells) {
      cx += a.x + c.x;
      cy += a.y + c.y;
    }
    cx /= cells.length;
    cy /= cells.length;
    const corners: ReadonlyArray<readonly [number, number]> = [
      [Math.floor(cx - 0.6), Math.floor(cy - 0.6)],
      [Math.ceil(cx + 0.6), Math.floor(cy - 0.6)],
      [Math.floor(cx - 0.6), Math.ceil(cy + 0.6)],
      [Math.ceil(cx + 0.6), Math.ceil(cy + 0.6)],
    ];
    let filled = 0;
    for (const [x, y] of corners) {
      if (x < 0 || x >= COLS || y < 0) {
        filled += 1;
        continue;
      }
      if (y >= ROWS) continue;
      const row = grid[y];
      if (row !== undefined && (row[x] ?? 0) !== 0) filled += 1;
    }
    return filled >= 3;
  }

  function spawnGarbageRows(count: number): void {
    const { holes, prevHole } = genGarbageHoles(count, rand, prevGarbageHole);
    prevGarbageHole = prevHole;
    for (const hole of holes) {
      const row: CellValue[] = Array.from({ length: COLS }, (_, x) =>
        x === hole ? (0 as CellValue) : (8 as CellValue),
      );
      grid.shift();
      grid.push(row);
    }
    if (active !== null) {
      active = { ...active, y: active.y - count };
    }
    const top = grid[0];
    if (top?.some((v) => v !== 0)) {
      gameOver = true;
    }
  }

  function hardDropAt(rotation: number, x: number): boolean {
    if (active === null || gameOver) return false;
    const rot = ((rotation % 4) + 4) % 4;
    const cells = cellsFor(active.kind, rot);
    if (cells.some((c) => x + c.x < 0 || x + c.x >= COLS)) return false;
    if (!reachable(active.kind, active.rotation, active.x, active.y, rot, x)) return false;
    const y = ghostYFrom(active.kind, rot, x, active.y);
    active = { ...active, rotation: rot, x, y };
    score += 2;
    lockAndSpawn();
    return true;
  }

  function reachable(
    kind: PieceKind,
    fromRot: number,
    fromX: number,
    fromY: number,
    toRot: number,
    toX: number,
  ): boolean {
    const startRot = ((fromRot % 4) + 4) % 4;
    const endRot = ((toRot % 4) + 4) % 4;
    const seen = new Set<string>();
    const queue: { readonly rot: number; readonly x: number; readonly y: number }[] = [
      { rot: startRot, x: fromX, y: fromY },
    ];
    seen.add(`${startRot},${fromX},${fromY}`);
    let head = 0;
    let guard = 4000;
    while (head < queue.length) {
      const cur = queue[head];
      head += 1;
      guard -= 1;
      if (guard <= 0) break;
      if (cur === undefined) continue;
      if (cur.rot === endRot && cur.x === toX) return true;
      const rotCW = (cur.rot + 1) % 4;
      const rotCCW = (cur.rot + 3) % 4;
      const candidates: { readonly rot: number; readonly x: number; readonly y: number }[] = [
        { rot: cur.rot, x: cur.x - 1, y: cur.y },
        { rot: cur.rot, x: cur.x + 1, y: cur.y },
        { rot: cur.rot, x: cur.x, y: cur.y + 1 },
        { rot: rotCW, x: cur.x, y: cur.y },
        { rot: rotCCW, x: cur.x, y: cur.y },
        { rot: rotCW, x: cur.x - 1, y: cur.y },
        { rot: rotCW, x: cur.x + 1, y: cur.y },
        { rot: rotCCW, x: cur.x - 1, y: cur.y },
        { rot: rotCCW, x: cur.x + 1, y: cur.y },
        { rot: rotCW, x: cur.x, y: cur.y - 1 },
        { rot: rotCCW, x: cur.x, y: cur.y - 1 },
      ];
      for (const n of candidates) {
        const key = `${n.rot},${n.x},${n.y}`;
        if (seen.has(key)) continue;
        if (n.y > ROWS + 4) continue;
        if (collides(kind, n.rot, n.x, n.y)) continue;
        seen.add(key);
        queue.push(n);
      }
    }
    return false;
  }

  function ghostYFrom(kind: PieceKind, rotation: number, x: number, startY: number): number {
    let y = startY;
    let guard = ROWS + 8;
    while (!collides(kind, rotation, x, y + 1)) {
      y += 1;
      guard -= 1;
      if (guard <= 0) break;
    }
    return y;
  }

  function ghostYFor(a: SpawnState): number {
    return ghostYFrom(a.kind, a.rotation, a.x, a.y);
  }

  function tryRotate(dir: 1 | -1): void {
    if (active === null || gameOver) return;
    const from = asRotation(active.rotation);
    const to = asRotation(active.rotation + (dir === 1 ? 1 : 3));
    const kicks = kickTable(active.kind, from as Rotation, to as Rotation);
    for (let i = 0; i < kicks.length; i += 1) {
      const k = kicks[i];
      if (k === undefined) continue;
      const nx = active.x + k.dx;
      const ny = active.y - k.dy;
      if (!collides(active.kind, to, nx, ny)) {
        active = { ...active, rotation: to, x: nx, y: ny };
        lastRotated = true;
        return;
      }
    }
  }

  spawn();

  return {
    getSnapshot(): GameSnapshot {
      const board: BoardView = { cols: COLS, rows: ROWS, grid: grid.map((r) => [...r]) };
      let view: ActivePieceView | null = null;
      let ghostY: number | null = null;
      if (active !== null) {
        const cells = cellsFor(active.kind, active.rotation).map((c) => ({ x: c.x, y: c.y }));
        view = {
          kind: active.kind,
          rotation: active.rotation,
          cells,
          posX: active.x,
          posY: active.y,
        };
        ghostY = ghostYFor(active);
      }
      return {
        board,
        active: view,
        ghostY,
        hold,
        canHold,
        next: [...queue].slice(0, 5),
        score,
        lines,
        level,
        gameOver,
        combo,
        b2b,
        pendingGarbage: pendingTotal(pending),
        lastAttack,
        lastBlocked,
      };
    },
    getLastLockTransition(): LockTransition | null {
      return lastLockTransition;
    },
    moveLeft(): void {
      if (active === null || gameOver) return;
      lastRotated = false;
      if (!collides(active.kind, active.rotation, active.x - 1, active.y)) {
        active = { ...active, x: active.x - 1 };
      }
    },
    moveRight(): void {
      if (active === null || gameOver) return;
      lastRotated = false;
      if (!collides(active.kind, active.rotation, active.x + 1, active.y)) {
        active = { ...active, x: active.x + 1 };
      }
    },
    softDrop(): void {
      if (active === null || gameOver) return;
      lastRotated = false;
      if (!collides(active.kind, active.rotation, active.x, active.y + 1)) {
        active = { ...active, y: active.y + 1 };
        score += 1;
      } else {
        lockAndSpawn();
      }
    },
    rotateCW(): void {
      tryRotate(1);
    },
    rotateCCW(): void {
      tryRotate(-1);
    },
    hardDrop(): void {
      if (active === null || gameOver) return;
      active = { ...active, y: ghostYFor(active) };
      score += 2;
      lockAndSpawn();
    },
    hardDropAt(rotation: number, x: number): boolean {
      return hardDropAt(rotation, x);
    },
    hold(): void {
      if (active === null || gameOver || !canHold) return;
      const cur = active.kind;
      if (hold === null) {
        hold = cur;
        canHold = false;
        spawn();
        canHold = false;
      } else {
        const swapped = hold;
        hold = cur;
        canHold = false;
        const s: SpawnState = { kind: swapped, rotation: 0, x: 3, y: 0 };
        if (collides(s.kind, s.rotation, s.x, s.y)) {
          gameOver = true;
          active = s;
          return;
        }
        active = s;
      }
    },
    gravityTick(): boolean {
      if (active === null || gameOver) return false;
      if (!collides(active.kind, active.rotation, active.x, active.y + 1)) {
        active = { ...active, y: active.y + 1 };
        return false;
      }
      lockAndSpawn();
      return true;
    },
    drainOutbox(): number {
      const n = outbox;
      outbox = 0;
      return n;
    },
    receiveGarbage(rows: number): void {
      if (gameOver || rows <= 0) return;
      pushIncoming(pending, rows);
    },
    reset(): void {
      grid = emptyGrid();
      queue = [...shuffledBag(rand), ...shuffledBag(rand)];
      hold = null;
      canHold = true;
      score = 0;
      lines = 0;
      level = 1;
      combo = -1;
      b2b = false;
      gameOver = false;
      active = null;
      pending = [];
      lastLockTransition = null;
      outbox = 0;
      lastAttack = 0;
      lastBlocked = 0;
      prevGarbageHole = 4;
      spawn();
      canHold = true;
    },
  };
}

function emptyGrid(): Grid {
  return Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => 0 as CellValue));
}

export function createCore(options: EngineOptions = {}): CorePort {
  return createEngine(options);
}
