/**
 * Native Board (Hoiko `Board`, Tetriz_Common.cpp): int32 `line[32]`,
 * bit `9-col` set for column `col`, bottom-up rows. `stackHeight` = highest
 * non-empty row (-1 when empty), `lockedBottom` = bottom of the last lock.
 *
 * Collision/rotation reproduce the binary's `Board.CollisionBoard`,
 * `CollisionDistance`, `CollisionBottom/Left/Right`, `SrsA`/`SrsB`,
 * `GetSpawnHeight`, `LockMino`, `ClearLine`, `GetColumnHeight`, `PopCount`,
 * `IsEvenPop`, `UpdateMaxHeight`.
 */

import { kickTable, type Rotation } from "../../core/srs.js";
import type { FallMino } from "./mino.js";
import { minoToKind, shapeFor } from "./shapes.js";

export const BOARD_HEIGHT = 32;
export const BOARD_WIDTH = 10;
export const FULL_ROW = 0x3ff;

/** Bit::PopCount — 10-bit popcount (the binary table is the same function). */
export function popCount(v: number): number {
  let n = v & FULL_ROW;
  n -= (n >>> 1) & 0x55555555;
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  n = (n + (n >>> 4)) & 0x0f0f0f0f;
  n += n >>> 8;
  return n & 0xff;
}

/** Bit::Log2 — column index (source orientation) of a single set bit. */
export function log2(bit: number): number {
  return 9 - popCount(bit - 1);
}

export class Board {
  readonly line = new Int32Array(BOARD_HEIGHT);
  stackHeight = -1;
  lockedBottom = -1;

  init(): void {
    this.line.fill(0);
    this.stackHeight = -1;
    this.lockedBottom = -1;
  }

  clone(): Board {
    const b = new Board();
    b.line.set(this.line);
    b.stackHeight = this.stackHeight;
    b.lockedBottom = this.lockedBottom;
    return b;
  }

  rowAt(y: number): number {
    return this.line[y] ?? 0;
  }

  private hitAt(mino: FallMino, x: number, y: number): number {
    const sh = shapeFor(mino.m, mino.r);
    for (const c of sh.cells) {
      const col = x + c.x;
      const row = y - c.y;
      if (col < 0 || col >= BOARD_WIDTH || row < 0 || row >= BOARD_HEIGHT) continue;
      if (((this.line[row] ?? 0) & (1 << (9 - col))) !== 0) return 1;
    }
    return 0;
  }

  /** Board.CollisionBoard: bounds + the anchor rows. */
  collisionBoard(mino: FallMino): number {
    const sh = shapeFor(mino.m, mino.r);
    if (mino.x + sh.minX < 0) return 1;
    if (mino.x + sh.maxX >= BOARD_WIDTH) return 1;
    if (mino.y - sh.maxY < 0) return 1;
    return this.hitAt(mino, mino.x, mino.y);
  }

  /** Board.CollisionBottom: one row down (the floor counts as a collision). */
  collisionBottom(mino: FallMino): number {
    const sh = shapeFor(mino.m, mino.r);
    if (mino.y - sh.maxY < 1) return 1;
    return this.hitAt(mino, mino.x, mino.y - 1);
  }

  collisionLeft(mino: FallMino): number {
    const sh = shapeFor(mino.m, mino.r);
    if (mino.x + sh.minX < 1) return 1;
    return this.hitAt(mino, mino.x - 1, mino.y);
  }

  collisionRight(mino: FallMino): number {
    const sh = shapeFor(mino.m, mino.r);
    if (mino.x + sh.maxX >= BOARD_WIDTH - 1) return 1;
    return this.hitAt(mino, mino.x + 1, mino.y);
  }

  /**
   * Board.CollisionDistance — rows the piece can still fall (the native loop
   * scans candidate anchors from just under the top down; equivalently the
   * first colliding anchor below the current one).
   */
  collisionDistance(mino: FallMino): number {
    const limit = Math.min(mino.y, this.stackHeight + 40) + 4;
    let s = 1;
    while (s <= limit) {
      if (this.hitAt(mino, mino.x, mino.y - s) !== 0) break;
      if (mino.y - s - shapeFor(mino.m, mino.r).maxY < 0) break;
      s += 1;
    }
    const drop = s - 1;
    return drop > 0 ? drop : 0;
  }

  /** Board.GetSpawnHeight — binary checks only local rows y=1 and y=0. */
  getSpawnHeight(mino: FallMino): number {
    if (this.stackHeight + 1 <= 19) return 20;
    const sh = shapeFor(mino.m, mino.r);
    const m1 = (sh.rowMask[1] ?? 0) >> 3;
    const m0 = (sh.rowMask[0] ?? 0) >> 3;
    let hit = 0;
    if (((this.line[19] ?? 0) & m1) !== 0) hit += 1;
    if (((this.line[20] ?? 0) & m0) !== 0) hit += 1;
    if (hit === 0) return 20;
    hit = 0;
    if (((this.line[20] ?? 0) & m1) !== 0) hit += 1;
    if (((this.line[21] ?? 0) & m0) !== 0) hit += 1;
    return hit === 0 ? 21 : -1;
  }

  private srsSpin(mino: FallMino, spins: "A" | "B"): number {
    if (spins === "A") mino.spinA();
    else mino.spinB();
    if (this.collisionBoard(mino) === 0) return 1;
    const kind = minoToKind(mino.m);
    if (kind === null) {
      if (spins === "A") mino.spinB();
      else mino.spinA();
      return 0;
    }
    const newR = mino.r;
    const oldR = spins === "A" ? (newR + 3) % 4 : (newR + 1) % 4;
    const kicks = kickTable(kind, oldR as Rotation, newR as Rotation);
    const x0 = mino.x;
    const y0 = mino.y;
    for (let i = 0; i < 4; i += 1) {
      const k = kicks[i + 1];
      if (k === undefined) break;
      mino.x = x0 + k.dx;
      mino.y = y0 + k.dy;
      if (this.collisionBoard(mino) === 0) return i + 2;
    }
    mino.x = x0;
    mino.y = y0;
    if (spins === "A") mino.spinB();
    else mino.spinA();
    return 0;
  }

  /** Board.SrsA — CW rotation with the 4 native kick tests; returns 0..5. */
  srsA(mino: FallMino): number {
    return this.srsSpin(mino, "A");
  }

  /** Board.SrsB — CCW rotation. */
  srsB(mino: FallMino): number {
    return this.srsSpin(mino, "B");
  }

  /** Board.LockMino — returns cleared rows, or -1 on top-out. */
  lockMino(mino: FallMino): number {
    const sh = shapeFor(mino.m, mino.r);
    if (mino.y - sh.maxY > 19) return -1;
    for (const c of sh.cells) {
      const row = mino.y - c.y;
      const col = mino.x + c.x;
      if (row < 0 || row >= BOARD_HEIGHT || col < 0 || col >= BOARD_WIDTH) continue;
      this.line[row] = (this.line[row] ?? 0) | (1 << (9 - col));
    }
    let cleared = 0;
    for (let k = 3; k >= 0; k -= 1) {
      const row = mino.y - k;
      if (row >= 0 && row < BOARD_HEIGHT && (this.line[row] ?? 0) === FULL_ROW) cleared += 1;
    }
    const top = mino.y - sh.minY;
    if (this.stackHeight < top) this.stackHeight = top;
    this.lockedBottom = mino.y - sh.maxY;
    return cleared;
  }

  clearLine(): void {
    let i = this.lockedBottom;
    let end = this.stackHeight;
    while (i <= end) {
      if ((this.line[i] ?? 0) === FULL_ROW) {
        for (let k = i; k < end; k += 1) this.line[k] = this.line[k + 1] ?? 0;
        this.line[end] = 0;
        i -= 1;
        end -= 1;
        this.stackHeight -= 1;
      }
      i += 1;
    }
  }

  updateMaxHeight(): void {
    for (let y = BOARD_HEIGHT - 1; y >= 0; y -= 1) {
      if ((this.line[y] ?? 0) !== 0) {
        this.stackHeight = y;
        return;
      }
    }
    this.stackHeight = -1;
  }

  boardPopCount(): number {
    let total = 0;
    for (let y = this.stackHeight; y >= 0; y -= 1) total += popCount(this.line[y] ?? 0);
    return total;
  }

  isEvenPop(): boolean {
    return (this.boardPopCount() & 1) === 0;
  }

  /** Board.IsTspin — binary returns 0 none, 1 T-spin, 2 mini. */
  isTspin(mino: FallMino): number {
    if (mino.m !== 4) return 0;
    if (mino.lastSrs === 0) return 0;
    const x = mino.x;
    const y = mino.y;
    const l0 = y - 2 >= 0 ? this.line[y] ?? 0 : 0;
    const l1 = y - 2 >= 0 ? this.line[y - 2] ?? 0 : 0;
    const corners = [0, 0, 0, 0];
    let fill = 0;
    if (x < 0 || (l0 & (512 >> x)) !== 0) {
      corners[0] = 1;
      fill += 1;
    }
    if (x >= 8 || (l0 & (512 >> (x + 2))) !== 0) {
      corners[1] = 1;
      fill += 1;
    }
    if (x >= 8 || y - 2 < 0 || (l1 & (512 >> (x + 2))) !== 0) {
      corners[2] = 1;
      fill += 1;
    }
    if (x < 0 || y - 2 < 0 || (l1 & (512 >> x)) !== 0) {
      corners[3] = 1;
      fill += 1;
    }
    if (fill < 3) return 0;
    const nr = mino.r > 2 ? 0 : mino.r + 1;
    if ((corners[mino.r] ?? 0) !== (corners[nr] ?? 0) && mino.lastSrs !== 5) return 2;
    return 1;
  }

  /** Board.GetColumnHeight — fills `columnHeight`, returns garbageHeight. */
  getColumnHeight(columnHeight: Int32Array): number {
    let bit = 0;
    let min = 0;
    for (let y = this.stackHeight; y >= 0; y -= 1) {
      bit |= this.line[y] ?? 0;
      if (bit === FULL_ROW) {
        min = y + 1;
        break;
      }
      for (let x = 0; x < 10; x += 1) {
        columnHeight[x] = (columnHeight[x] ?? 0) + ((bit & (0x200 >> x)) !== 0 ? 1 : 0);
      }
    }
    if (min > 0) {
      for (let x = 0; x < 10; x += 1) columnHeight[x] = (columnHeight[x] ?? 0) + min;
    }
    return min - 1;
  }
}

export { FallMino, Command, HoldMino } from "./mino.js";
export type { NextSource } from "./mino.js";
export { GamePack, totaling } from "./gamepack.js";
export type { Others } from "./gamepack.js";
