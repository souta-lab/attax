/**
 * Native FallMino + Command (Tetriz_Common.cpp / binary IL 6687-6920).
 *
 * FallMino anchor: a cell `(cx, cy)` occupies column `p.x + cx` and row
 * `p.y - cy`. Command opcodes (ASCII): l/r move, a/b rotate, u hard drop,
 * d soft drop (followed by `'A'+y`), g bug-gravity drop, h swap hold,
 * f first hold. Move delays (binary): move 30, rotate 16, soft-drop/row 33,
 * hard-drop 112, hold 16.
 */

import type { Board } from "./board.js";
import { MINO_NONE, MINO_O, shapeFor, type MinoType } from "./shapes.js";

export class HoldMino {
  m: MinoType = MINO_NONE;
  swappedHold = 0;
  abnormalHold = 0;

  init(): void {
    this.m = MINO_NONE;
    this.swappedHold = 0;
    this.abnormalHold = 0;
  }

  clone(): HoldMino {
    const h = new HoldMino();
    h.m = this.m;
    h.swappedHold = this.swappedHold;
    h.abnormalHold = this.abnormalHold;
    return h;
  }
}

/** Minimal view over the shared NextMino array used by Command.SwapHold. */
export interface NextSource {
  get(): MinoType;
  advance(): void;
}

export class FallMino {
  x = 3;
  y = 20;
  r = 0;
  m: MinoType = MINO_NONE;
  lastSrs = 0;
  bugGravity = 0;

  init(): void {
    this.x = 3;
    this.y = 20;
    this.r = 0;
    this.m = MINO_NONE;
    this.lastSrs = 0;
    this.bugGravity = 0;
  }

  clone(): FallMino {
    const f = new FallMino();
    f.x = this.x;
    f.y = this.y;
    f.r = this.r;
    f.m = this.m;
    f.lastSrs = this.lastSrs;
    f.bugGravity = this.bugGravity;
    return f;
  }

  spawn(newM: MinoType, board: Board): number {
    this.m = newM;
    this.x = 3;
    this.y = 20;
    this.r = 0;
    this.lastSrs = 0;
    this.bugGravity = 0;
    const h = board.getSpawnHeight(this);
    if (h === -1) return 0;
    this.y = h;
    return 1;
  }

  spinA(): void {
    this.r = this.r > 2 ? 0 : this.r + 1;
  }

  spinB(): void {
    this.r = this.r < 1 ? 3 : this.r - 1;
  }

  left(): number {
    return this.x + shapeFor(this.m, this.r).minX;
  }

  right(): number {
    return this.x + shapeFor(this.m, this.r).maxX;
  }

  top(): number {
    return this.y - shapeFor(this.m, this.r).minY;
  }

  bottom(): number {
    return this.y - shapeFor(this.m, this.r).maxY;
  }
}

function charCode(c: string): number {
  return c.charCodeAt(0);
}

export class Command {
  readonly s: number[] = [];
  moveDelay = 0;

  init(): void {
    this.s.length = 0;
    this.moveDelay = 0;
  }

  clone(): Command {
    const c = new Command();
    c.s.push(...this.s);
    c.moveDelay = this.moveDelay;
    return c;
  }

  addCommand(cmd: string): void {
    this.s.push(charCode(cmd));
  }

  private addCommandSoftDrop(cmd: string, y: number): void {
    this.s.push(charCode(cmd));
    this.s.push(65 + y);
  }

  addCommands(cmds: string): void {
    for (const ch of cmds) this.s.push(charCode(ch));
  }

  isFirstHold(): boolean {
    return this.s[0] === 102;
  }

  hardDrop(mino: FallMino, bd: Board): number {
    this.addCommand("u");
    this.moveDelay += 112;
    const d = bd.collisionDistance(mino);
    if (d > 0) {
      mino.y -= d;
      mino.lastSrs = 0;
    }
    return 1;
  }

  softDrop(mino: FallMino, bd: Board): number {
    const d = bd.collisionDistance(mino);
    if (d === 0) return 0;
    mino.y -= d;
    this.addCommandSoftDrop("d", mino.y);
    this.moveDelay += d * 33;
    mino.lastSrs = 0;
    return 1;
  }

  softDropOnce(mino: FallMino, bd: Board): number {
    if (bd.collisionBottom(mino) === 1) return 0;
    mino.y -= 1;
    this.addCommandSoftDrop("d", mino.y);
    this.moveDelay += 33;
    mino.lastSrs = 0;
    return 1;
  }

  private bugGravityDrop(mino: FallMino, bd: Board): void {
    if (mino.bugGravity === 1 && bd.collisionBottom(mino) === 0) {
      mino.y -= 1;
      mino.bugGravity = 0;
      this.addCommandSoftDrop("g", mino.y);
    }
  }

  moveLeft(mino: FallMino, bd: Board): number {
    if (bd.collisionLeft(mino) === 1) return 0;
    mino.x -= 1;
    mino.lastSrs = 0;
    this.addCommand("l");
    this.moveDelay += 30;
    this.bugGravityDrop(mino, bd);
    return 1;
  }

  moveRight(mino: FallMino, bd: Board): number {
    if (bd.collisionRight(mino) === 1) return 0;
    mino.x += 1;
    mino.lastSrs = 0;
    this.addCommand("r");
    this.moveDelay += 30;
    this.bugGravityDrop(mino, bd);
    return 1;
  }

  rotateA(mino: FallMino, bd: Board): number {
    if (mino.m === MINO_O) return 0;
    const srs = bd.srsA(mino);
    if (srs === 0) return 0;
    this.addCommand("a");
    this.moveDelay += 16;
    mino.lastSrs = srs;
    this.bugGravityDrop(mino, bd);
    return 1;
  }

  rotateB(mino: FallMino, bd: Board): number {
    if (mino.m === MINO_O) return 0;
    const srs = bd.srsB(mino);
    if (srs === 0) return 0;
    this.addCommand("b");
    this.moveDelay += 16;
    mino.lastSrs = srs;
    this.bugGravityDrop(mino, bd);
    return 1;
  }

  /**
   * Command.SwapHold (IL 6863). Follows the binary: non-empty hold swaps
   * without consuming the queue, empty hold takes the next piece and advances.
   * `forPPT1` is false in the shipped config (the static `ppt` is never set).
   */
  swapHold(mino: FallMino, hld: HoldMino, bd: Board, nx: NextSource): number {
    if (hld.swappedHold === 1) return 0;
    const prevAbnormal = hld.abnormalHold;
    hld.abnormalHold = mino.y === 20 ? 0 : 1;
    if (hld.m !== MINO_NONE) {
      mino.m = hld.m;
      hld.m = nx.get();
      this.addCommand("h");
      this.moveDelay += 16;
    } else {
      hld.m = mino.m;
      nx.advance();
      mino.m = nx.get();
      this.addCommand("f");
      this.moveDelay += 16;
    }
    mino.x = 3;
    mino.r = 0;
    const spawnHeight = bd.getSpawnHeight(mino);
    if (prevAbnormal === 0) {
      if (spawnHeight === 20) {
        mino.y = 20;
      } else {
        mino.y = 21;
        mino.bugGravity = 1;
      }
    } else {
      mino.y = 21;
    }
    mino.lastSrs = 0;
    hld.swappedHold = 1;
    if (spawnHeight === -1) {
      if (this.rotateB(mino, bd) === 0) this.rotateA(mino, bd);
    }
    return 1;
  }
}
