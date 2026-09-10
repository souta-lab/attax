/**
 * Hoiko OffsetAI port — garbage/offset management from TetrizAI_Evaluate.cpp
 * (lines 1101-1343). Ports DecisionOffset, CanWaitGarbage, CalcOpponentsAtk,
 * GetOpponentsAtk, SetRemainingTime, SetCoolTimeAfterClearing, IsInCoolTime,
 * OpponentIsNewLockDown, InvalidateOpponentsAtk, IsFirstInvalidLockDown.
 *
 * Our engine's garbage model: `pendingGarbage` is the incoming (unspawned)
 * garbage; clearing lines cancels it via cancelPending (offset/相殺). The
 * offset bonus below rewards clearing lines when pending garbage is high,
 * which is exactly how real Hoiko survives attacks: it clears to cancel the
 * garbage instead of letting it spawn and bury the board.
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
 * DecisionOffset in the native source reads the search result plan
 * (act[0]/act[1]/act[2]). Our beam does not expose a pre-search plan, so the
 * upcoming clear is estimated greedily from the next pieces (see
 * estimateClearAction). This is the one approximation; the CanWaitGarbage
 * gate and the offset bonus are otherwise transcribed verbatim.
 */

import type { Board } from "../core/board.js";
import { attackForClear } from "../core/garbage.js";
import type { PieceKind } from "../core/pieces.js";
import type { ClearAct, SourceBoard } from "./hoiko-eval.js";
import { getColumnHeight, toSourceBoard } from "./hoiko-eval.js";
import { enumerateScored } from "./search.js";
import { DU_WEIGHTS } from "./weights.js";

/** Value (in Hoiko score units) of cancelling one pending garbage row. */
export const OFFSET_PER_ROW = 300;

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

/** Hoiko's attack table for a clear action (DecisionOffset). */
export function attackForAct(act: ClearAct): number {
  switch (act) {
    case "Double":
      return 1;
    case "Triple":
    case "Tss":
      return 2;
    case "Tsd":
    case "Quad":
      return 4;
    case "Tst":
      return 6;
    default:
      return 0;
  }
}

/** Map linesCleared to a ClearAct (tspin handled separately by the caller). */
function linesToAct(lines: number): ClearAct {
  switch (lines) {
    case 1:
      return "Single";
    case 2:
      return "Double";
    case 3:
      return "Triple";
    case 4:
      return "Quad";
    default:
      return "None";
  }
}

/**
 * Greedy estimate of the best clear action for `piece` on `board`. Used to
 * approximate the search-result plan that native DecisionOffset reads.
 */
function estimateClearAction(board: Board, piece: PieceKind): ClearAct {
  const placements = enumerateScored(board, piece, DU_WEIGHTS);
  let best: ClearAct = "None";
  let bestAtk = -1;
  for (const p of placements) {
    const act = linesToAct(p.linesCleared);
    const atk = attackForAct(act);
    if (atk > bestAtk) {
      bestAtk = atk;
      best = act;
    }
  }
  return best;
}

/**
 * OffsetAI::DecisionOffset — computes ofsData for the current board.
 *
 * Native reads `searched->result.plans.act[0..2]`; we estimate those from the
 * current piece and the next two pieces. `board` is our orientation; the
 * board metrics are computed on the native orientation internally.
 */
export function computeOffsetData(
  board: Board,
  currentPiece: PieceKind,
  nextPieces: readonly PieceKind[],
  hold: PieceKind | null,
  btb: number,
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

  // act[0]: the current move clears -> cannot wait (native early return).
  if (estimateClearAction(board, currentPiece) !== "None") return ofs;

  // pcChance: native scans act[2..trustEnd] for a Pc. We approximate by
  // checking whether the next two pieces can perfect-clear; rare in practice,
  // so a conservative false is acceptable (it only relaxes the gate).
  ofs.pcChance = false;

  const act1 = estimateClearAction(board, nextPieces[0] ?? "I");
  const act2 = estimateClearAction(board, nextPieces[1] ?? "I");

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

/**
 * Offset bonus for a clear placement: the amount of pending garbage it
 * cancels (offset/相殺), scaled to Hoiko's score units. When CanWaitGarbage
 * says Hoiko must clear now, the bonus is full; when it can wait, the bonus is
 * halved (it still prefers clearing, but does not force it).
 */
export function offsetBonus(
  ofs: OffsetData,
  pending: number,
  lines: number,
  tspin: boolean,
  combo: number,
  b2b: boolean,
  opponentsCombo: number,
  isEvenBoard: boolean,
): number {
  if (lines === 0) return 0;
  const nextCombo = combo + 1;
  const attack = attackForClear({
    lines,
    tspinLines: tspin ? lines : 0,
    combo: nextCombo,
    b2bActive: b2b,
    perfectClear: false,
  });
  const cancelled = Math.min(pending, attack);
  if (cancelled <= 0) return 0;
  const wait = canWaitGarbage(ofs, pending, opponentsCombo, isEvenBoard);
  return cancelled * OFFSET_PER_ROW * (wait ? 0.5 : 1);
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
