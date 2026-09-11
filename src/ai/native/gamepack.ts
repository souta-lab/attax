/**
 * Native HoldMino / Others / GamePack (binary IL 6928-6959, 21211).
 *
 * `Others.Totaling` reproduces the binary's combo/btb/ClearAct computation
 * (the C++ `Others::CalcAtk` is the equivalent older version). `GamePack`
 * mirrors the 304-byte native struct used by ExpandAI/EvaluateAI.
 */

import { Board, FULL_ROW } from "./board.js";
import { Command, FallMino, HoldMino } from "./mino.js";
import { NextIterator, type NextMino } from "./nextmino.js";
import {
  ACT_DOUBLE,
  ACT_NONE,
  ACT_PC,
  ACT_QUAD,
  ACT_SINGLE,
  ACT_TRIPLE,
  ACT_TSD,
  ACT_TSM,
  ACT_TSS,
  ACT_TST,
  type ClearAct,
  type MinoType,
} from "./shapes.js";

export interface Others {
  combo: number;
  btb: number;
  act: ClearAct;
}

/**
 * Others.Totaling (IL 21211). `cleared` is the number of rows LockMino found;
 * the PC test `line[cleared-1] == FULL && line[cleared] == 0` matches the
 * binary exactly (it assumes cleared rows sit at the floor).
 */
export function totaling(others: Others, mino: FallMino, bd: Board, cleared: number): void {
  if (cleared === 0) {
    if (others.combo > 0) others.combo = -others.combo;
    else others.combo = 0;
    others.act = ACT_NONE;
    return;
  }
  if (others.combo < 0) others.combo = 0;
  if (bd.rowAt(cleared - 1) === FULL_ROW && bd.rowAt(cleared) === 0) {
    if (cleared >= 4) others.btb += 1;
    else others.btb = 0;
    others.combo += 1;
    others.act = ACT_PC;
    return;
  }
  if (cleared >= 4) {
    others.btb += 1;
    others.act = ACT_QUAD;
  } else {
    const tspin = bd.isTspin(mino);
    if (tspin === 1) {
      others.act = cleared === 1 ? ACT_TSS : cleared === 2 ? ACT_TSD : ACT_TST;
      others.btb += 1;
    } else {
      others.act = cleared === 1 ? ACT_SINGLE : cleared === 2 ? ACT_DOUBLE : ACT_TRIPLE;
      if (tspin === 2) {
        others.act = ACT_TSM;
        others.btb += 1;
      } else {
        others.btb = 0;
      }
    }
  }
  others.combo += 1;
}

export class GamePack {
  readonly nextIt = new NextIterator();
  next: NextMino | null = null;
  readonly hold = new HoldMino();
  fallingMino = new FallMino();
  lockedMino = new FallMino();
  readonly board = new Board();
  readonly commands = new Command();
  combo = 0;
  btb = 0;
  act: ClearAct = ACT_NONE;

  init(next: NextMino, realNext: readonly MinoType[]): void {
    this.board.init();
    this.hold.init();
    this.commands.init();
    this.combo = 0;
    this.btb = 0;
    this.act = ACT_NONE;
    this.fallingMino.init();
    this.lockedMino.init();
    next.init(realNext);
    this.setNewCurrent(next);
  }

  setNewCurrent(next: NextMino): void {
    this.next = next;
    this.nextIt.setSource(next);
    this.fallingMino.spawn(this.nextIt.get(), this.board);
  }

  advanceMino(next: NextMino): void {
    this.next = next;
    this.nextIt.setSource(next);
    this.fallingMino.spawn(this.nextIt.get(), this.board);
  }

  isSafe(): boolean {
    return this.board.stackHeight < this.fallingMino.y - 3;
  }

  /** GamePack.LockDown (IL 6928): returns 0 on top-out / blocked spawn. */
  lockDown(): number {
    this.commands.hardDrop(this.fallingMino, this.board);
    const cleared = this.board.lockMino(this.fallingMino);
    if (cleared === -1) return 0;
    totaling(this, this.fallingMino, this.board, cleared);
    if (cleared > 0) this.board.clearLine();
    this.hold.swappedHold = 0;
    this.lockedMino = this.fallingMino.clone();
    this.nextIt.advance();
    return this.fallingMino.spawn(this.nextIt.get(), this.board);
  }

  clone(): GamePack {
    const g = new GamePack();
    g.nextIt.copyFrom(this.nextIt);
    g.hold.m = this.hold.m;
    g.hold.swappedHold = this.hold.swappedHold;
    g.hold.abnormalHold = this.hold.abnormalHold;
    g.fallingMino = this.fallingMino.clone();
    g.lockedMino = this.lockedMino.clone();
    g.board.line.set(this.board.line);
    g.board.stackHeight = this.board.stackHeight;
    g.board.lockedBottom = this.board.lockedBottom;
    g.commands.s.push(...this.commands.s);
    g.commands.moveDelay = this.commands.moveDelay;
    g.combo = this.combo;
    g.btb = this.btb;
    g.act = this.act;
    return g;
  }

  /** Consume the current piece outside the search (NextMino.ShiftNext). */
  shiftNext(next: NextMino): void {
    next.shiftNext();
    this.nextIt.advance();
  }
}
