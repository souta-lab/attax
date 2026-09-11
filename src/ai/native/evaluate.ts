/**
 * Native EvaluateAI core (SPEC_EvaluateAI §7): GetContBonus, GetFinalAction,
 * TransitionWeight, Evaluate, EvaluateFirst. Board terms live in
 * ./evaluate-terms.js; the TSD/TST/DTCannon and PcBoard searches live in
 * ./evaluate-tsd.js and ./evaluate-pc.js.
 */

import type { HoikoWeights } from "../hoiko-weights.js";
import type { Board } from "./board.js";
import type { GamePack } from "./gamepack.js";
import { searchPcBoard } from "./evaluate-pc.js";
import {
  buildColumnHeight,
  getGround,
  getHeight,
  getResource,
  getUnderground,
  getUpDown,
  getWellColumn,
} from "./evaluate-terms.js";
import { searchTsd, searchTst } from "./evaluate-tsd.js";
import { ACT_NONE, ACT_PC, ACT_TSM, MINO_I, MINO_T } from "./shapes.js";
import { WI, comboAt, weightAt } from "./weight-index.js";

export const DEFAULT_IS_EVEN_BOARD = true;
export const DEFAULT_VIEW_NEXT = 2;

function w(ew: HoikoWeights, i: number): number {
  return weightAt(ew, i);
}

export function getContBonus(g: GamePack, ew: HoikoWeights): number {
  let score = 0;
  if (g.hold.m === MINO_I) score += w(ew, WI.HoldI);
  else if (g.hold.m === MINO_T) score += w(ew, WI.HoldT);
  if (g.btb > 0) score += w(ew, WI.Btb);
  return score;
}

/** GetFinalAction (binary 13099) — Pc returns immediately (SPEC §8 #8). */
export function getFinalAction(g: GamePack, ew: HoikoWeights, weightIndex: number): number {
  let score = (g.commands.moveDelay >> 4) * w(ew, WI.MoveDelay);
  const locked = g.lockedMino.m;
  switch (g.act) {
    case ACT_NONE:
      if (locked === MINO_T) score += w(ew, WI.WasteT);
      else if (locked === MINO_I) score += w(ew, WI.WasteI);
      score += g.combo * w(ew, WI.ComboDebt);
      return score;
    case 1:
      score += w(ew, WI.Single);
      break;
    case 2:
      score += w(ew, WI.Double);
      break;
    case 3:
      score += w(ew, WI.Triple);
      break;
    case 4:
      score += w(ew, WI.Quad);
      break;
    case 5:
      score += w(ew, WI.Tss);
      break;
    case 6:
      score += w(ew, WI.Tsd);
      break;
    case 7:
      score += w(ew, WI.Tst);
      break;
    case ACT_TSM:
      score += w(ew, WI.Single) + w(ew, WI.WasteT);
      score += -w(ew, WI.Btb);
      break;
    case ACT_PC:
      score += w(ew, WI.Pc);
      score += (g.commands.moveDelay >> 5) * -w(ew, WI.MoveDelay);
      if (g.btb === 0) {
        if (locked === MINO_T) score += w(ew, WI.WasteT);
        else if (locked === MINO_I) score += w(ew, WI.WasteI);
      } else {
        score += w(ew, WI.ComboBtb);
      }
      return score;
    default:
      break;
  }
  if (g.btb === 0) {
    if (locked === MINO_T) score += w(ew, WI.WasteT);
    else if (locked === MINO_I) score += w(ew, WI.WasteI);
  } else if (g.btb > 1) {
    score += w(ew, WI.ComboBtb);
    if (g.combo > 1) score += w(ew, WI.ComboBtb);
  }
  score += w(ew, WI.ComboDebt);
  const cmb = g.combo;
  if (cmb >= 3 && cmb <= 4) score += comboAt(ew, 0);
  else if (cmb >= 5 && cmb <= 6) score += comboAt(ew, 1);
  else if (cmb >= 7 && cmb <= 8) score += comboAt(ew, 2);
  else if (cmb >= 9 && cmb <= 11) score += comboAt(ew, 3);
  else if (cmb >= 12) score += comboAt(ew, 4);
  if (weightIndex >= 2) {
    let atk = 0;
    switch (g.act) {
      case 2:
        atk = 1;
        break;
      case 3:
      case 5:
        atk = 2;
        break;
      case 6:
      case 4:
        atk = 4;
        break;
      case 7:
        atk = 6;
        break;
      default:
        break;
    }
    if (g.btb > 1) atk += 1;
    if (atk > 0) score += comboAt(ew, Math.min(atk, 5) - 1);
  }
  return score;
}

export interface EvalOut {
  readonly score: number;
  readonly familyScore: number;
}

/** EvaluateAI.Evaluate (binary 11066). */
export function evaluate(
  g: GamePack,
  ew: HoikoWeights,
  weightIndex: number,
  isEvenBoard: boolean,
  useS4W: boolean,
  trustRate: number,
): EvalOut {
  const ch = new Int32Array(10);
  const minHeight = buildColumnHeight(g.board, ch);
  let board = getHeight(g.board, ch, ew);
  const well = getWellColumn(g.board, ch, minHeight, ew);
  board += well.score;
  board += getUpDown(ch, well.wellColumn, well.wellDepth, ew);
  board += getUnderground(g.board, ch, minHeight, ew);
  const y0 = well.wellDepth + minHeight;
  board += getResource(g.board, ch, minHeight, ew, useS4W);
  board += getGround(g, ch, y0, ew);
  board += searchTsd(g, ch, y0, ew);
  board += searchTst(g, ch, y0, minHeight, ew);
  board += searchPcBoard(g, minHeight, ew, isEvenBoard);
  board += getContBonus(g, ew);
  const action = getFinalAction(g, ew, weightIndex);
  return {
    familyScore: Math.trunc((Math.trunc(ew.nexus * board) + action) * trustRate),
    score: Math.trunc((action + board) * trustRate),
  };
}

/** EvaluateAI.EvaluateFirst (binary 11098). */
export function evaluateFirst(
  g: GamePack,
  ew: HoikoWeights,
  weightIndex: number,
  isEvenBoard: boolean,
): EvalOut {
  const ch = new Int32Array(10);
  const minHeight = buildColumnHeight(g.board, ch);
  let board = getHeight(g.board, ch, ew);
  board += searchPcBoard(g, minHeight, ew, isEvenBoard);
  board += getContBonus(g, ew);
  const familyScore = getFinalAction(g, ew, weightIndex) + Math.trunc(board * ew.nexus);
  return { familyScore, score: familyScore };
}

/** EvaluateAI.TransitionWeight (binary 13533) for the VS/single-eval config. */
export function transitionWeight(board: Board, weightIndex: number, isEvenBoard: boolean): number {
  const transitionHeight = weightIndex >= 2 ? 13 : 15;
  const ch = new Int32Array(10);
  const garbageHeight = buildColumnHeight(board, ch);
  let c4 = Math.max(ch[3] ?? 0, ch[4] ?? 0, ch[5] ?? 0, ch[6] ?? 0);
  c4 = Math.max(c4, 0);
  if (c4 + 1 <= transitionHeight) {
    if (board.stackHeight + 1 >= 11) return 0;
    if (!isEvenBoard) {
      if (weightIndex === 1) return 1;
      if (garbageHeight === -1 && board.stackHeight + 1 <= 5) return 1;
    }
    return 0;
  }
  return 2;
}

export type { ClearAct } from "./shapes.js";
export { getGround, getHeight, getWellColumn, getUpDown, getUnderground, getResource } from "./evaluate-terms.js";
