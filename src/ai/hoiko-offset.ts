/**
 * Hoiko OffsetAI port — garbage/offset management from TetrizAI_Evaluate.cpp
 * (lines 1101-1343). Ports DecisionOffset, CanWaitGarbage, CalcOpponentsAtk,
 * GetOpponentsAtk, SetRemainingTime, SetCoolTimeAfterClearing, IsInCoolTime,
 * OpponentIsNewLockDown, InvalidateOpponentsAtk, IsFirstInvalidLockDown.
 *
 * Our engine's garbage model: `pendingGarbage` is the incoming (unspawned)
 * garbage; clearing lines cancels it via cancelPending (offset/相殺).
 *
 * Mapping notes (native -> ours):
 *   ofsData.canWaitGarbage  -> whether a clear is coming in the next 1-2 moves
 *   ofsData.atk             -> attack value of the upcoming clear (Hoiko table)
 *   ofsData.center4Height   -> max column height of columns 3..6 (0-based)
 *   ofsData.garbageHeight   -> y of the highest full row (getColumnHeight)
 *   gbData.opponentsAtk     -> last attack the opponent sent (approximated)
 *   gbData.coolTime         -> frame until which clearing is suppressed
 *   gbData.remainingTime    -> clear-delay budget (SetRemainingTime)
 *
 * DecisionOffset in the native source reads the selected search result plan
 * (act[0]/act[1]/act[2]); the Hoiko search supplies that plan directly.
 */

import type { Board } from "../core/board.js";
import type { PieceKind } from "../core/pieces.js";
import type { ClearAct, SourceBoard } from "./hoiko-eval.js";
import { getColumnHeight, toSourceBoard } from "./hoiko-eval.js";

/** OffsetAI::OffsetData. */
export interface OffsetData {
  canWaitGarbage: boolean;
  center4Height: number;
  garbageHeight: number;
  atk: number;
  pcChance: boolean;
  nearOffset: boolean;
}

/** OffsetAI::GarbageData. */
export interface GarbageData {
  opponentsAtk: number;
  coolTime: number;
  remainingTime: number;
  opponentsLockCount: number;
  firstInvalidLock: boolean;
}

/** Fresh GarbageData (native static init). */
export function newGarbageData(): GarbageData {
  return {
    opponentsAtk: 0,
    coolTime: 0,
    remainingTime: 0,
    opponentsLockCount: 0,
    firstInvalidLock: false,
  };
}

/**
 * OffsetAI::DecisionOffset — computes ofsData for the current board.
 *
 * `planActs` is the selected leaf's action plan in native depth order.
 * `board` is our orientation; the board metrics are computed on the native
 * orientation internally.
 */
export function computeOffsetData(
  board: Board,
  nextPieces: readonly PieceKind[],
  hold: PieceKind | null,
  btb: number,
  planActs: readonly ClearAct[],
  isEvenBoard: boolean,
): OffsetData {
  const src: SourceBoard = toSourceBoard(board);
  const column = new Array<number>(10).fill(-1);
  const garbageHeight = getColumnHeight(src, column);
  let center4Height = Math.max(column[3] ?? 0, column[4] ?? 0);
  center4Height = Math.max(column[5] ?? 0, center4Height);
  center4Height = Math.max(column[6] ?? 0, center4Height);

  const ofs: OffsetData = {
    canWaitGarbage: false,
    center4Height,
    garbageHeight,
    atk: 0,
    pcChance: false,
    nearOffset: false,
  };

  const act0 = planActs[0] ?? "None";
  if (act0 !== "None") return ofs;

  if (isEvenBoard) {
    const trustEndExclusive = Math.min(planActs.length, nextPieces.length + 1);
    for (let i = 2; i < trustEndExclusive; i += 1) {
      if (planActs[i] === "Pc") {
        ofs.pcChance = true;
        break;
      }
    }
  }

  const act1 = planActs[1] ?? "None";
  const act2 = planActs[2] ?? "None";

  // Port of the switch on act[1] (with the act[2] fallback when act[1]==None).
  switch (act1) {
    case "None":
      switch (act2) {
        case "Tss":
          if (hold !== "T" && nextPieces[2] === "T") return ofs;
          ofs.atk = 2;
          break;
        case "Quad":
          if (hold !== "I" && nextPieces[2] === "I") return ofs;
          ofs.atk = 4;
          break;
        case "Tsd":
          if (hold !== "T" && nextPieces[2] === "T") return ofs;
          ofs.atk = 4;
          break;
        case "Tst":
          if (hold !== "T" && nextPieces[2] === "T") return ofs;
          ofs.atk = 6;
          break;
        default:
          return ofs;
      }
      ofs.atk += btb > 0 ? 1 : 0;
      ofs.nearOffset = true;
      break;
    case "Pc":
      return ofs;
    case "Single":
      if (ofs.pcChance) break;
      return ofs;
    case "Double":
      ofs.atk = 1;
      break;
    case "Triple":
      ofs.atk = 2;
      break;
    case "Tss":
      ofs.atk = 2 + (btb > 0 ? 1 : 0);
      break;
    case "Quad":
    case "Tsd":
      ofs.atk = 4 + (btb > 0 ? 1 : 0);
      break;
    case "Tst":
      ofs.atk = 6 + (btb > 0 ? 1 : 0);
      break;
    case "Tsm":
      if (btb > 0) {
        ofs.atk = 1;
        break;
      }
      return ofs;
  }

  return { ...ofs, canWaitGarbage: true };
}

/**
 * OffsetAI::CanWaitGarbage — whether Hoiko can afford to WAIT for `garbage`
 * rows (i.e. not clear now). Returns false when it must clear now to offset.
 */
export function canWaitGarbage(
  ofs: OffsetData,
  garbage: number,
  opponentsCombo: number,
  isEvenBoard: boolean,
): boolean {
  if (!ofs.canWaitGarbage) return false;
  if (ofs.center4Height + garbage >= 15) return false;
  if (ofs.garbageHeight >= 3) {
    if (opponentsCombo >= 9) {
      if (garbage - ofs.atk !== 1) return false;
      if (ofs.garbageHeight >= 7) return false;
    }
  }
  if (isEvenBoard) {
    if (ofs.pcChance) {
      if (ofs.atk >= garbage) return false;
    }
  }
  if (ofs.nearOffset) {
    if (opponentsCombo <= 8) {
      if (garbage >= 4) return true;
    }
  }
  if (ofs.atk < garbage) return true;
  if (garbage <= 2) return false;
  return true;
}

/** OffsetAI::ResetOpponentsAtk. */
export function resetOpponentsAtk(gb: GarbageData): void {
  gb.opponentsAtk = 0;
}

/**
 * OffsetAI::CalcOpponentsAtk — estimate the attack the opponent just sent.
 * `line` is the opponent's clear size, `btb` its b2b flag, `btbBonus` its b2b
 * bonus, `combo` its combo count.
 */
export function calcOpponentsAtk(
  gb: GarbageData,
  line: number,
  btb: number,
  btbBonus: number,
  combo: number,
): void {
  if (line <= 1) return;
  if (btb === 0) return;
  if (combo > 4) return;
  gb.opponentsAtk = line === 4 ? 4 : line * 2;
  gb.opponentsAtk += btbBonus;
  if (combo > 2) gb.opponentsAtk += 1;
}

/** OffsetAI::GetOpponentsAtk. */
export function getOpponentsAtk(gb: GarbageData): number {
  return gb.opponentsAtk;
}

/** OffsetAI::SetRemainingTime — clear-delay budget per clear action. */
export function setRemainingTime(gb: GarbageData, act: ClearAct): void {
  switch (act) {
    case "None":
      gb.remainingTime = 0;
      break;
    case "Single":
    case "Tss":
    case "Tsm":
      gb.remainingTime = 15;
      break;
    case "Double":
    case "Triple":
    case "Tsd":
    case "Tst":
      gb.remainingTime = 10;
      break;
    case "Quad":
      gb.remainingTime = 5;
      break;
    case "Pc":
      gb.remainingTime = 21;
      break;
  }
}

/** OffsetAI::SetCoolTimeAfterClearing. */
export function setCoolTimeAfterClearing(
  gb: GarbageData,
  frame: number,
  sendingGarbage: number,
  lock: number,
): void {
  if (gb.remainingTime > 0) {
    gb.coolTime = frame + gb.remainingTime;
    if (sendingGarbage <= 0) gb.coolTime += 24;
    opponentIsNewLockDown(gb, lock);
    gb.firstInvalidLock = true;
    invalidateOpponentsAtk(gb);
  }
}

/** OffsetAI::OpponentIsNewLockDown. */
export function opponentIsNewLockDown(gb: GarbageData, lock: number): boolean {
  const isNewLock = gb.opponentsLockCount !== lock;
  gb.opponentsLockCount = lock;
  return isNewLock;
}

/** OffsetAI::InvalidateOpponentsAtk. */
export function invalidateOpponentsAtk(gb: GarbageData): void {
  gb.opponentsAtk = -1;
}

/** OffsetAI::IsInCoolTime. */
export function isInCoolTime(gb: GarbageData, frame: number): boolean {
  return gb.coolTime > frame;
}

/** OffsetAI::IsFirstInvalidLockDown. */
export function isFirstInvalidLockDown(gb: GarbageData): boolean {
  const isFirst = gb.firstInvalidLock;
  gb.firstInvalidLock = false;
  return isFirst;
}
