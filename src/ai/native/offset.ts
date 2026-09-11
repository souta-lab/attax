/**
 * Native OffsetOffAI (garbage/offset management) — binary IL 13777–14069.
 *
 * Authoritative spec: tools/hoiko-oracle/SPEC_OffsetOffAI.md. This is the
 * SHIPPING revision: unlike the older C++ OffsetAI it has no `opponentsCombo`
 * branches in `CanOffsetOff`. `GarbageData`/`OffsetData` are per-fighter state
 * (the binary keeps them static; the app runs one instance per side).
 *
 * Frame clock: `frame` is `Memory.GetMatchFrames()` in the binary (game frames
 * at ~60/s). The app supplies a wall-clock mapping (see hoiko-native adapter).
 */

import type { NextMino } from "./nextmino.js";
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
  MINO_I,
  MINO_T,
  type ClearAct,
  type MinoType,
} from "./shapes.js";

/** OffsetOffAI::OffsetData (16 B). Binary offsets in comments. */
export interface OffsetData {
  canWaitGarbage: boolean;
  center4Height: number;
  atk: number;
  pcChance: boolean;
  nearOffset: boolean;
}

/** OffsetOffAI::GarbageData (20 B). Binary offsets in comments. */
export interface GarbageData {
  opponentsAtk: number;
  coolTime: number;
  remainingTime: number;
  opponentsLockCount: number;
  firstInvalidLock: boolean;
}

function freshOffsetData(): OffsetData {
  return {
    canWaitGarbage: false,
    center4Height: 0,
    atk: 0,
    pcChance: false,
    nearOffset: false,
  };
}

function freshGarbageData(): GarbageData {
  return {
    opponentsAtk: 0,
    coolTime: 0,
    remainingTime: 0,
    opponentsLockCount: 0,
    firstInvalidLock: false,
  };
}

export class OffsetOffAI {
  useOffsetOff = false;
  ofsData: OffsetData = freshOffsetData();
  gbData: GarbageData = freshGarbageData();

  constructor(useOffsetOff = false) {
    this.setUseOffsetOff(useOffsetOff);
  }

  /** OffsetOffAI.UseOffsetOff(set): set the flag and zero both structs. */
  setUseOffsetOff(enabled: boolean): void {
    this.useOffsetOff = enabled;
    this.ofsData = freshOffsetData();
    this.gbData = freshGarbageData();
  }

  /** OffsetOffAI.CanOffsetOff (IL 13799): may HOIKO wait instead of locking? */
  canOffsetOff(garbage: number, isEvenBoard: boolean): boolean {
    const ofs = this.ofsData;
    if (!ofs.canWaitGarbage) return false;
    if (ofs.center4Height + garbage >= 15) return false;
    if (isEvenBoard && ofs.pcChance && ofs.atk >= garbage) return false;
    if (ofs.nearOffset && garbage >= 4) return true;
    if (ofs.atk < garbage) return true;
    return garbage > 2;
  }

  /**
   * OffsetOffAI.DecisionOffsetOff (IL 13824). Fills ofsData from the chosen
   * search line: `planActs[i]` is the ClearAct of the i-th planned move,
   * `depth` the searched depth, `next` the root NextMino, `hold` the root
   * HoldMino.m, `btb` the root Others.btb, `columnHeights` the result of
   * Board.GetColumnHeight.
   */
  computeDecision(
    planActs: readonly ClearAct[],
    depth: number,
    hold: MinoType,
    next: NextMino,
    btb: number,
    isEvenBoard: boolean,
    columnHeights: Int32Array,
  ): void {
    const ofs = this.ofsData;
    ofs.canWaitGarbage = false;
    if (!this.useOffsetOff || (planActs[0] ?? ACT_NONE) !== ACT_NONE) return;

    ofs.pcChance = false;
    if (isEvenBoard) {
      const end = Math.min(depth - 1, next.trustEnd + 1);
      for (let i = 2; i <= end; i += 1) {
        if ((planActs[i] ?? ACT_NONE) === ACT_PC) {
          ofs.pcChance = true;
          break;
        }
      }
    }

    ofs.nearOffset = false;
    ofs.atk = 0;
    const btbBonus = btb > 0 ? 1 : 0;
    const act1 = planActs[1] ?? ACT_NONE;
    const act2 = planActs[2] ?? ACT_NONE;

    let compute = false;
    switch (act1) {
      case ACT_NONE:
        switch (act2) {
          case ACT_TST:
            if (hold === MINO_T || next.at(2) !== MINO_T) ofs.atk = 6;
            else return;
            break;
          case ACT_TSD:
            if (hold === MINO_T || next.at(2) !== MINO_T) ofs.atk = 4;
            else return;
            break;
          case ACT_TSS:
            if (hold === MINO_T || next.at(2) !== MINO_T) ofs.atk = 2;
            else return;
            break;
          case ACT_QUAD:
            if (hold === MINO_I || next.at(2) !== MINO_I) ofs.atk = 4;
            else return;
            break;
          default:
            return;
        }
        ofs.atk += btbBonus;
        ofs.nearOffset = true;
        compute = true;
        break;
      case ACT_SINGLE:
        if (!ofs.pcChance) return;
        compute = true;
        break;
      case ACT_DOUBLE:
        ofs.atk = 1;
        compute = true;
        break;
      case ACT_TRIPLE:
        ofs.atk = 2;
        compute = true;
        break;
      case ACT_TSS:
        ofs.atk = 2 + btbBonus;
        compute = true;
        break;
      case ACT_QUAD:
      case ACT_TSD:
        ofs.atk = 4 + btbBonus;
        compute = true;
        break;
      case ACT_TST:
        ofs.atk = 6 + btbBonus;
        compute = true;
        break;
      case ACT_TSM:
        if (btbBonus === 1) {
          ofs.atk = 1;
          compute = true;
        } else return;
        break;
      case ACT_PC:
        return;
      default:
        compute = true;
        break;
    }
    if (!compute) return;
    ofs.center4Height = Math.max(
      columnHeights[3] ?? 0,
      columnHeights[4] ?? 0,
      columnHeights[5] ?? 0,
      columnHeights[6] ?? 0,
    );
    ofs.canWaitGarbage = true;
  }

  /** OffsetOffAI.ResetOpponentsAtk (IL 13969). */
  resetOpponentsAtk(): void {
    this.gbData.opponentsAtk = 0;
  }

  /** OffsetOffAI.CalcOpponentsAtk (IL 13974). */
  calcOpponentsAtk(line: number, btb: number, btbBuff: number, combo: number): void {
    if (this.useOffsetOff && line > 1 && btb !== 0 && combo <= 4) {
      this.gbData.opponentsAtk = (line === 4 ? 4 : line * 2) + btbBuff + (combo > 2 ? 1 : 0);
    }
  }

  /** OffsetOffAI.GetOpponentsAtk (IL 13994). */
  getOpponentsAtk(): number {
    return this.gbData.opponentsAtk;
  }

  /** OffsetOffAI.SetPrevAct (IL 13999) -> gbData.remainingTime. */
  setPrevAct(act: ClearAct): void {
    switch (act) {
      case ACT_NONE:
        this.gbData.remainingTime = 0;
        break;
      case ACT_SINGLE:
      case ACT_TSS:
      case ACT_TSM:
        this.gbData.remainingTime = 15;
        break;
      case ACT_DOUBLE:
      case ACT_TRIPLE:
      case ACT_TSD:
      case ACT_TST:
        this.gbData.remainingTime = 10;
        break;
      case ACT_QUAD:
        this.gbData.remainingTime = 5;
        break;
      case ACT_PC:
        this.gbData.remainingTime = 21;
        break;
      default:
        this.gbData.remainingTime = 0;
        break;
    }
  }

  /** OffsetOffAI.LockOffsetAfterClearing (IL 14029). */
  lockOffsetAfterClearing(frame: number, sendingGarbage: number, lock: number): void {
    const gb = this.gbData;
    if (gb.remainingTime > 0) {
      gb.coolTime = frame + gb.remainingTime;
      if (sendingGarbage <= 0) gb.coolTime += 24;
      gb.opponentsLockCount = lock;
      gb.firstInvalidLock = true;
      gb.opponentsAtk = -1;
    }
  }

  /** OffsetOffAI.OpponentIsNewLockDown (IL 14045). */
  opponentIsNewLockDown(lock: number): boolean {
    const isNew = this.gbData.opponentsLockCount !== lock;
    this.gbData.opponentsLockCount = lock;
    return isNew;
  }

  /** OffsetOffAI.InvalidateGettingEnemysAtk (IL 14052). */
  invalidateGettingEnemysAtk(): void {
    this.gbData.opponentsAtk = -1;
  }

  /** OffsetOffAI.IsLocked (IL 14058). */
  isLocked(frame: number): boolean {
    return this.gbData.coolTime > frame;
  }

  /** OffsetOffAI.IsFirstInvalidLockDown (IL 14064): consuming. */
  isFirstInvalidLockDown(): boolean {
    const first = this.gbData.firstInvalidLock;
    this.gbData.firstInvalidLock = false;
    return first;
  }
}
