/**
 * Real core engine: 7-bag + SRS-lite + hold + guideline scoring.
 * Implements the ui CorePort view-model so the existing Canvas UI works unchanged.
 * Board model: grid[y][x], y=0 is TOP row (view order). Internally uses bit ops for clears.
 */

import {
  cancelPending,
  genGarbageHoles,
  isDifficultClear,
  type PendingChunk,
  pendingTotal,
  pushIncoming,
  tickPending,
} from "./garbage.js";
import { bottomCellsOf, cellsFor, type PieceKind, pieceCellValue } from "./pieces.js";
import { awardLock, RULES_PROFILES, type RulesProfile } from "./rules.js";
import { classifyS2Spin } from "./s2-spin.js";
import { asRotation, kickTable, type Rotation } from "./srs.js";
import { classifyTspin, type TspinKind } from "./tspin.js";
import type {
  ActivePieceView,
  BoardView,
  CellValue,
  CorePort,
  GameSnapshot,
  LockAction,
  LockTransition,
} from "./types.js";
import { COLS } from "./types.js";

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

function actionForClear(cleared: number, tspin: TspinKind, perfectClear: boolean): LockAction {
  if (cleared === 0) return "None";
  if (perfectClear) return "Pc";
  if (cleared === 4) return "Quad";
  if (tspin === "mini") return "Tsm";
  if (tspin === "full") {
    if (cleared === 1) return "Tss";
    if (cleared === 2) return "Tsd";
    return "Tst";
  }
  if (cleared === 1) return "Single";
  if (cleared === 2) return "Double";
  return "Triple";
}

interface SpawnState {
  readonly kind: PieceKind;
  readonly rotation: number;
  readonly x: number;
  readonly y: number;
  readonly lastSrs: number;
}

export interface EngineOptions {
  /** S2 stage 1: lock awards/board only; input, spawn and delivery gates remain provisional. */
  readonly rulesProfile?: RulesProfile;
  readonly random?: () => number;
  /** Locks a pending garbage chunk waits before spawning (default GARBAGE_DELAY). */
  readonly garbageDelay?: number | undefined;
  /** Share one hole column across all rows of a garbage chunk (strict; see versus/config.ts). */
  readonly garbageAligned?: boolean | undefined;
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
  const profile = options.rulesProfile ?? "guideline";
  const { rows: ROWS } = RULES_PROFILES[profile];
  const rand = options.random ?? Math.random;
  let grid: Grid = emptyGrid(ROWS);
  let queue: PieceKind[] = [
    ...shuffledBag(rand),
    ...shuffledBag(rand),
    ...shuffledBag(rand),
    ...shuffledBag(rand),
  ];
  let active: SpawnState | null = null;
  let hold: PieceKind | null = null;
  let canHold = true;
  let score = 0;
  let lines = 0;
  let level = 1;
  let combo = -1;
  let b2b = false;
  let nativeCombo = 0;
  let nativeBtb = 0;
  let lockId = 0;
  let lastAction: LockAction = "None";
  let lastRawAttack = 0;
  let lastSurgeReleased = 0;
  let lastSentAttack = 0;
  let gameOver = false;
  let pending: PendingChunk[] = [];
  let outbox = 0;
  let lastAttack = 0;
  let lastBlocked = 0;
  let prevGarbageHole = 4;
  let lastLockTransition: LockTransition | null = null;
  let waitGarbage = false;

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
    if (queue.length < 21) queue.push(...shuffledBag(rand));
    const s: SpawnState = { kind, rotation: 0, x: 3, y: spawnY(kind), lastSrs: 0 };
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
    // TODO S2-SPEC Unpinned #6: pin S2 hidden spawn coordinates; retain legacy spawn for now.
    return -minY;
  }

  function applyClear(cleared: number, tspin: TspinKind, perfectClear: boolean): void {
    lastSurgeReleased = 0;
    lastAction = actionForClear(cleared, tspin, perfectClear);
    if (cleared === 0) {
      // Binary `Others.CalcAtk` (Tetriz_Common.cpp 530): `if (combo > 0) combo *= -1;
      // else combo = 0` — the exe's `postCombo` is negative on a broken combo
      // (evidence/hoiko-fullgame/*.jsonl: -1/-2/-3).
      nativeCombo = profile === "tetrio-s2" ? 0 : nativeCombo > 0 ? -nativeCombo : 0;
      combo = -1;
      lastAttack = 0;
      lastBlocked = 0;
      lastRawAttack = 0;
      lastSentAttack = 0;
      return;
    }
    if (nativeCombo < 0) nativeCombo = 0;
    nativeCombo += 1;
    lines += cleared;
    const base = LINE_SCORES[cleared] ?? cleared * 200;
    const tspinLines = tspin === "full" ? cleared : 0;
    const difficult = isDifficultClear(cleared, tspin);
    const b2bBefore = b2b;
    let gained = base * level;
    if (difficult && b2bBefore) gained = Math.floor(gained * 1.5);
    combo += 1;
    if (combo > 0) gained += 50 * combo * level;
    score += gained;
    const clearInfo = {
      lines: cleared,
      tspinLines,
      combo,
      b2bActive: b2bBefore,
      perfectClear,
      tspinKind: tspin,
    };
    const award = awardLock(profile, clearInfo, nativeBtb);
    lastSurgeReleased = award.surgeReleased;
    const attack = award.attack;
    const blocked = cancelPending(pending, attack);
    lastRawAttack = attack;
    lastBlocked = blocked;
    lastAttack = attack - blocked;
    lastSentAttack = attack - blocked;
    outbox += attack - blocked;
    if (profile === "tetrio-s2") {
      nativeBtb = award.difficultChain;
    } else if (perfectClear) {
      nativeBtb = cleared >= 4 ? nativeBtb + 1 : 0;
    } else if (difficult) {
      nativeBtb += 1;
    } else {
      nativeBtb = 0;
    }
    b2b = nativeBtb > 0;
    level = Math.floor(lines / 10) + 1;
  }

  function lockAndSpawn(): void {
    const a = active;
    if (a === null) return;
    const cells = cellsFor(a.kind, a.rotation);
    if (cells.every((c) => a.y + c.y < 0)) {
      gameOver = true;
      return;
    }
    const s2Spin =
      profile === "tetrio-s2"
        ? classifyS2Spin(
            a,
            (x, y) => x < 0 || x >= COLS || y < 0 || y >= ROWS || (grid[y]?.[x] ?? 0) !== 0,
            (dx, dy) => !collides(a.kind, a.rotation, a.x + dx, a.y + dy),
          )
        : "none";
    const value = pieceCellValue(a.kind);
    for (const c of cells) {
      const x = a.x + c.x;
      const y = a.y + c.y;
      if (y >= 0 && y < ROWS && x >= 0 && x < COLS) {
        const row = grid[y];
        if (row !== undefined) row[x] = value;
      }
    }
    const tspin = profile === "tetrio-s2" ? s2Spin : detectTspin(a);
    const kept: Grid = [];
    let cleared = 0;
    for (const row of grid) {
      if (row.every((v) => v !== 0)) cleared += 1;
      else kept.push(row);
    }
    while (kept.length < ROWS) kept.unshift(Array.from({ length: COLS }, () => 0 as CellValue));
    grid = kept;
    const perfectClear = cleared > 0 && grid.every((row) => row.every((v) => v === 0));
    applyClear(cleared, tspin, perfectClear);
    canHold = true;
    const due = waitGarbage ? 0 : tickPending(pending);
    waitGarbage = false;
    lockId += 1;
    lastLockTransition = {
      boardAfterLockClear: gridToBottomUpRows(grid),
      linesCleared: cleared,
      garbageRowsApplied: due,
      action: lastAction,
      nativeCombo,
      nativeBtb,
      rawAttack: lastRawAttack,
      ...(profile === "tetrio-s2" ? { surgeReleased: lastSurgeReleased } : {}),
      sentAttack: lastSentAttack,
      lockId,
    };
    if (!gameOver) {
      if (due > 0) spawnGarbageRows(due);
      spawn();
    }
  }

  function detectTspin(a: SpawnState): TspinKind {
    if (a.kind !== "T" || a.lastSrs === 0) return "none";
    const board = new Uint16Array(ROWS);
    for (let y = 0; y < ROWS; y += 1) {
      const row = grid[ROWS - 1 - y];
      if (row === undefined) continue;
      for (let x = 0; x < COLS; x += 1) {
        if ((row[x] ?? 0) !== 0) board[y] = (board[y] ?? 0) | (1 << x);
      }
    }
    const cells = bottomCellsOf(a.kind, a.rotation);
    const py = ROWS - 1 - a.y - Math.max(...cells.map((cell) => cell.y));
    return classifyTspin(board, cells, a.x, py, a.rotation, a.lastSrs);
  }

  function spawnGarbageRows(count: number): void {
    const gen = options.garbageAligned
      ? genGarbageHoles(1, rand, prevGarbageHole)
      : genGarbageHoles(count, rand, prevGarbageHole);
    const holes = gen.holes;
    prevGarbageHole = gen.prevHole;
    for (let i = 0; i < count; i += 1) {
      const removed = grid[0];
      if (removed?.some((v) => v !== 0)) {
        gameOver = true;
        return;
      }
      const hole = holes[options.garbageAligned ? 0 : i] ?? 0;
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

  function lockAt(rotation: number, x: number, topRow: number, lastSrs: number): boolean {
    if (active === null || gameOver) return false;
    const rot = ((rotation % 4) + 4) % 4;
    const cells = cellsFor(active.kind, rot);
    for (const c of cells) {
      const cx = x + c.x;
      const cy = topRow + c.y;
      if (cx < 0 || cx >= COLS || cy >= ROWS) return false;
      if (cy >= 0) {
        const row = grid[cy];
        if (row !== undefined && (row[cx] ?? 0) !== 0) return false;
      }
    }
    active = { ...active, rotation: rot, x, y: topRow, lastSrs };
    lockAndSpawn();
    return true;
  }

  function hardDropAt(rotation: number, x: number): boolean {
    if (active === null || gameOver) return false;
    const rot = ((rotation % 4) + 4) % 4;
    const cells = cellsFor(active.kind, rot);
    if (cells.some((c) => x + c.x < 0 || x + c.x >= COLS)) return false;
    if (!reachable(active.kind, active.rotation, active.x, active.y, rot, x)) return false;
    const y = ghostYFrom(active.kind, rot, x, active.y);
    const fallen = y - active.y;
    active = {
      ...active,
      rotation: rot,
      x,
      y,
      lastSrs: rot === active.rotation ? active.lastSrs : 1,
    };
    if (fallen > 0) score += 2 * fallen;
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
      ];
      for (const dir of [1, -1] as const) {
        const to = dir === 1 ? rotCW : rotCCW;
        const kicks = kickTable(kind, asRotation(cur.rot), asRotation(to));
        for (const [kickIndex, kick] of kicks.entries()) {
          const candidate = {
            rot: to,
            x: cur.x + kick.dx,
            y: cur.y - kick.dy,
          };
          candidates.push(candidate);
          if (kickIndex === kicks.length - 1) break;
        }
      }
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
        active = { ...active, rotation: to, x: nx, y: ny, lastSrs: i === 0 ? 1 : i + 1 };
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
        next: [...queue].slice(0, 20),
        score,
        lines,
        level,
        gameOver,
        combo,
        b2b,
        nativeCombo,
        nativeBtb,
        lockId,
        lastAction,
        lastRawAttack,
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
      if (!collides(active.kind, active.rotation, active.x - 1, active.y)) {
        active = { ...active, x: active.x - 1, lastSrs: 0 };
      }
    },
    moveRight(): void {
      if (active === null || gameOver) return;
      if (!collides(active.kind, active.rotation, active.x + 1, active.y)) {
        active = { ...active, x: active.x + 1, lastSrs: 0 };
      }
    },
    softDrop(): void {
      if (active === null || gameOver) return;
      if (!collides(active.kind, active.rotation, active.x, active.y + 1)) {
        active = { ...active, y: active.y + 1, lastSrs: 0 };
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
      const landingY = ghostYFor(active);
      const fallen = landingY - active.y;
      if (fallen > 0) score += 2 * fallen;
      active = { ...active, y: landingY };
      lockAndSpawn();
    },
    hardDropAt(rotation: number, x: number): boolean {
      return hardDropAt(rotation, x);
    },
    placeMinoAt(rotation: number, x: number, topRow: number, lastSrs: number): boolean {
      return lockAt(rotation, x, topRow, lastSrs);
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
        const s: SpawnState = {
          kind: swapped,
          rotation: 0,
          x: 3,
          y: profile === "guideline" ? 0 : spawnY(swapped),
          lastSrs: 0,
        };
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
      pushIncoming(pending, rows, options.garbageDelay);
    },
    setGarbageWait(wait: boolean): void {
      waitGarbage = wait;
    },
    reset(): void {
      grid = emptyGrid(ROWS);
      queue = [
        ...shuffledBag(rand),
        ...shuffledBag(rand),
        ...shuffledBag(rand),
        ...shuffledBag(rand),
      ];
      hold = null;
      canHold = true;
      score = 0;
      lines = 0;
      level = 1;
      combo = -1;
      b2b = false;
      nativeCombo = 0;
      nativeBtb = 0;
      lockId = 0;
      lastAction = "None";
      lastRawAttack = 0;
      lastSurgeReleased = 0;
      lastSentAttack = 0;
      gameOver = false;
      active = null;
      pending = [];
      waitGarbage = false;
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

function emptyGrid(rows: number): Grid {
  return Array.from({ length: rows }, () => Array.from({ length: COLS }, () => 0 as CellValue));
}
