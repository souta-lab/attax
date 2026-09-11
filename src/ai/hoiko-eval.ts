/**
 * Hoiko exact evaluator, ported line-for-line from TetrizAI_Evaluate.cpp.
 *
 * The native evaluator operates on a Board whose row bitmask uses
 * `column x = bit (9 - x)` (bit 9 = column 0, bit 0 = column 9). Our beam
 * Board uses `column x = bit x`. Every entry point converts the afterstate to
 * the native orientation (`toSourceBoard`) so the bit constants below are
 * transcribed verbatim from the C++ source.
 *
 * Stubbed native searches (EvalGround, EvalTsd, EvalTst, EvalDTCannon,
 * EvalPcBoard) all return 0 in the real source and are ported as 0.
 */

import type { Board } from "../core/board.js";
import type { PieceKind } from "../core/pieces.js";
import type { HoikoWeights } from "./hoiko-weights.js";

/** W enum indices (EvaluateAI::W). */
export const W = {
  MaxHeight: 0,
  Over10: 1,
  Over15: 2,
  UpDown2: 3,
  DonateCover: 4,
  Cover: 5,
  Roof: 6,
  BadRoof: 7,
  Pierce: 8,
  Anabara: 9,
  WellHint: 10,
  WellDepth: 11,
  WellPeak: 12,
  Column: 13,
  PcStack: 14,
  PcChance: 15,
  Resource: 16,
  ResourceMax: 17,
  TsdHole: 18,
  TsdSpinable: 19,
  TsdClearable: 20,
  TsdOffensive: 21,
  TstHole: 22,
  TstSpinable: 23,
  TstClearable: 24,
  TstHint: 25,
  TstOffensive: 26,
  TDHole: 27,
  TDHint: 28,
  MoveDelay: 29,
  HoldI: 30,
  HoldT: 31,
  WasteI: 32,
  WasteT: 33,
  Single: 34,
  Double: 35,
  Triple: 36,
  Quad: 37,
  Tss: 38,
  Tsd: 39,
  Tst: 40,
  Btb: 41,
  Pc: 42,
  ComboBtb: 43,
  ComboAtk: 44,
  ComboDebt: 45,
  Nexus: 46,
} as const;

/** Clear action (ClearAct::CAType). */
export type ClearAct =
  | "None"
  | "Single"
  | "Double"
  | "Triple"
  | "Quad"
  | "Tss"
  | "Tsd"
  | "Tst"
  | "Tsm"
  | "Pc";

/** Native-orientation board: row y = bitmask with column x = bit (9-x). */
export interface SourceBoard {
  readonly line: readonly number[];
  readonly stackHeight: number;
}

const FULL = 0x3ff;

function w(ew: HoikoWeights, index: number): number {
  return ew.weight[index] ?? 0;
}

function col(ew: HoikoWeights, x: number): number {
  return ew.column[x] ?? 0;
}

function comboTable(ew: HoikoWeights, rank: number): number {
  return ew.comboTable[rank] ?? 0;
}

/** Bit::PopCount (10-bit). */
export function popcount(v: number): number {
  let n = v & 0x3ff;
  n -= (n >> 1) & 0x555;
  n = (n & 0x333) + ((n >> 2) & 0x333);
  return ((((n + (n >> 4)) & 0xf0f) * 0x101) >> 8) & 0x3ff;
}

/** Bit::Log2 — column index of the single set bit (source orientation). */
export function log2(bit: number): number {
  return 9 - popcount(bit - 1);
}

/** Convert our Board (column x = bit x) to native orientation. */
export function toSourceBoard(board: Board): SourceBoard {
  const line: number[] = new Array<number>(board.length).fill(0);
  let stackHeight = -1;
  for (let y = 0; y < board.length; y += 1) {
    const row = board[y] ?? 0;
    let src = 0;
    for (let x = 0; x < 10; x += 1) {
      if ((row & (1 << x)) !== 0) src |= 1 << (9 - x);
    }
    line[y] = src;
    if (src !== 0) stackHeight = y;
  }
  return { line, stackHeight };
}

/**
 * Board::GetColumnHeight — fills columnHeight[x] = height[x] - 1 and returns
 * garbageHeight (y of the highest full row, or -1 when none).
 */
export function getColumnHeight(src: SourceBoard, columnHeight: number[]): number {
  let bit = 0;
  let min = 0;
  for (let y = src.stackHeight; y >= 0; y -= 1) {
    bit |= src.line[y] ?? 0;
    if (bit === FULL) {
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

/** Board::IsEvenPop. */
export function isEvenPop(src: SourceBoard): boolean {
  let total = 0;
  for (let y = src.stackHeight; y >= 0; y -= 1) total += popcount(src.line[y] ?? 0);
  return (total & 1) === 0;
}

/** EvalHeight. */
export function evalHeight(
  src: SourceBoard,
  columnHeight: readonly number[],
  ew: HoikoWeights,
): number {
  let score = (src.stackHeight + 1) * w(ew, W.MaxHeight);
  if (src.stackHeight > 9) {
    let center4Height = Math.max(columnHeight[3] ?? 0, columnHeight[4] ?? 0);
    center4Height = Math.max(columnHeight[5] ?? 0, center4Height);
    center4Height = Math.max(columnHeight[6] ?? 0, center4Height);
    center4Height = Math.max(10, center4Height);
    score += (center4Height + 1 - 10) * w(ew, W.Over10);
    if (center4Height > 14) {
      score += (center4Height + 1 - 15) * w(ew, W.Over15);
    }
  }
  return score;
}

/** EvalWellColumn. */
export function evalWellColumn(
  src: SourceBoard,
  _columnHeight: readonly number[],
  garbageHeight: number,
  ew: HoikoWeights,
): { readonly score: number; readonly wellColumn: number; readonly wellDepth: number } {
  const well = (line: number): number => {
    if (popcount(line) !== 9) return -1;
    line += 1;
    return popcount(line) - 1;
  };
  let line = src.line[garbageHeight + 1] ?? 0;
  const column = well(line);
  if (column === -1) return { score: 0, wellColumn: -1, wellDepth: 0 };
  let depth = 1;
  for (let y = garbageHeight + 2; y < src.line.length; y += 1) {
    if ((src.line[y] ?? 0) !== line) break;
    depth += 1;
  }
  let hint = 1;
  line = (1280 >> column) & FULL;
  for (let y = garbageHeight + 2; y < src.line.length; y += 1) {
    if (((src.line[y] ?? 0) & line) !== line) break;
    hint += 1;
  }
  const wellPeak = (dep: number): number => {
    if (dep === 2) return 1;
    return Math.min(dep, w(ew, W.WellPeak));
  };
  const score =
    wellPeak(hint) * w(ew, W.WellHint) + wellPeak(depth) * w(ew, W.WellDepth) + col(ew, column);
  return { score, wellColumn: column, wellDepth: depth };
}

/** EvalUpDown. */
export function evalUpDown(
  columnHeight: readonly number[],
  wellColumn: number,
  wellDepth: number,
  ew: HoikoWeights,
): number {
  const c = columnHeight.slice();
  const wellPeak = (dep: number): number => Math.min(dep, w(ew, W.WellPeak));
  if (wellColumn >= 0) {
    c[wellColumn] = (c[wellColumn] ?? 0) + wellPeak(wellDepth);
  }
  let updown2 = 0;
  let diff = (c[0] ?? 0) - (c[1] ?? 0);
  updown2 += diff * diff * (diff < 0 ? 2 : 1);
  for (let x = 1; x < 8; x += 1) {
    diff = (c[x] ?? 0) - (c[x + 1] ?? 0);
    updown2 += diff * diff;
  }
  diff = (c[8] ?? 0) - (c[9] ?? 0);
  updown2 += diff * diff * (diff > 0 ? 2 : 1);
  if (wellColumn >= 0) {
    c[wellColumn] = (c[wellColumn] ?? 0) - wellPeak(wellDepth);
  }
  return updown2 * w(ew, W.UpDown2);
}

/** EvalUnderground. */
export function evalUnderground(
  src: SourceBoard,
  columnHeight: readonly number[],
  garbageHeight: number,
  ew: HoikoWeights,
): number {
  if (garbageHeight === -1) return 0;
  let cover = 0;
  let donateCover = 0;
  let prevBit = FULL;
  let bit = 0;
  bit = (src.line[garbageHeight] ?? 0) ^ FULL;
  prevBit = bit;
  for (let x = 0; bit !== 0; ) {
    x = bit & -bit;
    const depth = (columnHeight[log2(x)] ?? 0) - garbageHeight;
    donateCover += Math.min(depth, 5);
    bit &= ~x;
  }
  for (let y = garbageHeight - 1; y >= 0; y -= 1) {
    bit = (src.line[y] ?? 0) ^ FULL;
    if ((bit & ~prevBit) !== 0) {
      let x = bit & -bit;
      if ((bit & ~x) === 0) {
        const depth = (columnHeight[log2(x)] ?? 0) - y;
        cover += Math.min(depth, 5);
      } else {
        for (;;) {
          const depth = (columnHeight[log2(x)] ?? 0) - y;
          donateCover += depth;
          bit &= ~x;
          if (bit === 0) break;
          x = bit & -bit;
        }
      }
    }
    prevBit = (src.line[y] ?? 0) ^ FULL;
  }
  return donateCover * w(ew, W.DonateCover) + cover * w(ew, W.Cover);
}

/** EvalResource (includes the S4W bonus when enabled). */
export function evalResource(
  src: SourceBoard,
  _columnHeight: readonly number[],
  garbageHeight: number,
  ew: HoikoWeights,
  useS4W: boolean,
  opponentIsPowerful: boolean,
  combo: number,
): number {
  const well = (line: number): number => {
    if (popcount(line) !== 9) return -1;
    line += 1;
    return popcount(line) - 1;
  };
  let anabara = 0;
  let resource = 0;
  let line = src.line[0] ?? 0;
  for (let y = 1; y <= garbageHeight; y += 1) {
    if ((line | (src.line[y] ?? 0)) !== line) anabara += 1;
    line = src.line[y] ?? 0;
  }
  for (let y = garbageHeight + 1; y <= src.stackHeight; y += 1) {
    resource += popcount(src.line[y] ?? 0);
    if (resource >= w(ew, W.ResourceMax)) {
      resource = w(ew, W.ResourceMax);
      break;
    }
  }
  line = 0;
  if (garbageHeight >= 0) {
    const x = well(src.line[garbageHeight] ?? 0);
    if (x >= 0) {
      line = Math.trunc(col(ew, x) * 0.5);
    }
  }
  if (useS4W) {
    line += s4w(src, garbageHeight, ew, opponentIsPowerful, combo);
  }
  return line + anabara * w(ew, W.Anabara) + resource * w(ew, W.Resource);
}

/** S4W bonus (native lambda inside EvalResource). */
function s4w(
  src: SourceBoard,
  garbageHeight: number,
  ew: HoikoWeights,
  opponentIsPowerful: boolean,
  combo: number,
): number {
  let h = 0;
  let wide = 0;
  for (let y = src.stackHeight, fill = 0; y > garbageHeight; y -= 1) {
    const r = src.line[y] ?? 0;
    fill |= r;
    if (r === 0x3f0) {
      if ((fill & 0x00f) !== 0) return 0;
      wide = 0x3f0;
      h = y;
      break;
    }
    if (r === 0x01f) {
      if ((fill & 0x3e0) !== 0) return 0;
      wide = 0x01f;
      h = y;
      break;
    }
    if (r === 0x387) {
      if ((fill & 0x078) !== 0) return 0;
      wide = 0x387;
      h = y;
      break;
    }
  }
  if (h === 0) return 0;
  const goal = wide !== 0x387 ? 13 : 19;
  if (src.stackHeight + 1 > goal) return 0;
  {
    let y = h - 1;
    h = 1;
    for (; y > garbageHeight; y -= 1) {
      if ((src.line[y] ?? 0) !== wide) break;
      h += 1;
    }
    let seed = 0;
    for (let bit = ~wide; y > garbageHeight; y -= 1) {
      seed += popcount(bit & (src.line[y] ?? 0));
    }
    if (seed < 2) return 0;
    if (seed === 5) h -= 1;
    if (h >= 4) {
      if (combo > 2) h += combo;
    }
  }
  let score = 0;
  if (wide === 0x387) {
    score += h * h * w(ew, W.UpDown2);
    if (garbageHeight < 2) {
      h += 4 - (garbageHeight + 1);
    }
    if (garbageHeight <= h) {
      score *= 2;
      if (h >= 4) {
        if (garbageHeight < 4) h -= 1;
        if (h >= 6) {
          if (garbageHeight < 4) h -= 1;
          if (h >= 8) {
            if (h >= 11) {
              if (h >= 12) {
                score += comboTable(ew, 4);
              }
              score += comboTable(ew, 3);
            }
            score += comboTable(ew, 2);
          } else if (opponentIsPowerful) return 0;
          score += comboTable(ew, 1);
        } else if (opponentIsPowerful) return 0;
        score += comboTable(ew, 0);
      }
    }
  } else {
    if (garbageHeight <= h) {
      if (h >= 4) {
        if (h >= 6) {
          if (h >= 8) {
            if (h >= 11) {
              if (h >= 12) {
                score += comboTable(ew, 4);
              }
              score += comboTable(ew, 3);
            } else if (opponentIsPowerful) return 0;
            score += comboTable(ew, 2);
          } else if (opponentIsPowerful) return 0;
          score += comboTable(ew, 1);
        } else if (opponentIsPowerful) return 0;
        score += comboTable(ew, 0);
      }
    }
  }
  return score;
}

/** EvalContBonus. */
export function evalContBonus(hold: PieceKind | null, btb: number, ew: HoikoWeights): number {
  let score = 0;
  if (hold === "I") score += w(ew, W.HoldI);
  else if (hold === "T") score += w(ew, W.HoldT);
  if (btb > 0) score += w(ew, W.Btb);
  return score;
}

/** EvalFinalAction. */
export function evalFinalAction(
  act: ClearAct,
  lockedMino: PieceKind,
  combo: number,
  btb: number,
  moveDelay: number,
  ew: HoikoWeights,
  weightIndex: number,
): number {
  let score = 0;
  score += (moveDelay >> 4) * w(ew, W.MoveDelay);
  switch (act) {
    case "None":
      if (lockedMino === "T") score += w(ew, W.WasteT);
      else if (lockedMino === "I") score += w(ew, W.WasteI);
      score += combo * w(ew, W.ComboDebt);
      return score;
    case "Single":
      score += w(ew, W.Single);
      break;
    case "Double":
      score += w(ew, W.Double);
      break;
    case "Triple":
      score += w(ew, W.Triple);
      break;
    case "Quad":
      score += w(ew, W.Quad);
      break;
    case "Tss":
      score += w(ew, W.Tss);
      break;
    case "Tsd":
      score += w(ew, W.Tsd);
      break;
    case "Tst":
      score += w(ew, W.Tst);
      break;
    case "Tsm":
      score += w(ew, W.Single) + w(ew, W.WasteT);
      score += -w(ew, W.Btb);
      break;
    case "Pc":
      score += w(ew, W.Pc);
      score += (moveDelay >> 5) * -w(ew, W.MoveDelay);
      break;
  }
  if (btb === 0) {
    if (lockedMino === "T") score += w(ew, W.WasteT);
    else if (lockedMino === "I") score += w(ew, W.WasteI);
  } else if (btb > 1) {
    score += w(ew, W.ComboBtb);
    if (combo > 1) score += w(ew, W.ComboBtb);
  }
  score += w(ew, W.ComboDebt);
  if (act !== "Pc") {
    const cmb = combo;
    switch (cmb) {
      case 0:
      case 1:
      case 2:
        break;
      case 3:
      case 4:
        score += comboTable(ew, 0);
        break;
      case 5:
      case 6:
        score += comboTable(ew, 1);
        break;
      case 7:
      case 8:
        score += comboTable(ew, 2);
        break;
      case 9:
      case 10:
      case 11:
        score += comboTable(ew, 3);
        break;
      default:
        score += comboTable(ew, 4);
        break;
    }
  }
  if (weightIndex >= 2) {
    let atk = 0;
    switch (act) {
      case "Double":
        atk = 1;
        break;
      case "Triple":
      case "Tss":
        atk = 2;
        break;
      case "Tsd":
      case "Quad":
        atk = 4;
        break;
      case "Tst":
        atk = 6;
        break;
    }
    if (btb > 1) atk += 1;
    if (atk > 0) {
      atk = Math.min(atk, 5);
      score += comboTable(ew, atk - 1);
    }
  }
  return score;
}

/** EvalPrePcBoard — PC reachable by the falling/hold piece. */
export function evalPrePcBoard(
  src: SourceBoard,
  garbageHeight: number,
  fallingMino: PieceKind,
  hold: PieceKind | null,
  ew: HoikoWeights,
  isEvenBoard: boolean,
): number {
  if (!isEvenBoard) return 0;
  const searchPc = (m: PieceKind): boolean => {
    if (m === "I") {
      if (src.stackHeight === 0) {
        for (let x = 0; x < 7; x += 1) {
          if (((src.line[0] ?? 0) ^ (0x3c0 >> x)) === FULL) return true;
        }
      } else if (src.stackHeight === 3) {
        for (let x = 0; x < 10; x += 1) {
          if (((src.line[3] ?? 0) ^ (0x200 >> x)) === FULL) {
            const target = src.line[3] ?? 0;
            if ((src.line[2] ?? 0) !== target) break;
            if ((src.line[1] ?? 0) !== target) break;
            if ((src.line[0] ?? 0) !== target) break;
            return true;
          }
        }
      }
    } else if (m === "J") {
      if (src.stackHeight === 1) {
        for (let x = 0; x < 8; x += 1) {
          if (((src.line[1] ?? 0) ^ (0x380 >> x)) === FULL) {
            if (((src.line[0] ?? 0) ^ (0x080 >> x)) !== FULL) break;
            return true;
          }
        }
        for (let x = 0; x < 8; x += 1) {
          if (((src.line[0] ?? 0) ^ (0x380 >> x)) === FULL) {
            if (((src.line[1] ?? 0) ^ (0x200 >> x)) !== FULL) break;
            return true;
          }
        }
      } else if (src.stackHeight === 2) {
        for (let x = 0; x < 9; x += 1) {
          if (((src.line[2] ?? 0) ^ (0x300 >> x)) === FULL) {
            if (((src.line[1] ?? 0) ^ (0x200 >> x)) !== FULL) break;
            if (((src.line[0] ?? 0) ^ (0x200 >> x)) !== FULL) break;
            return true;
          }
        }
      }
    } else if (m === "L") {
      if (src.stackHeight === 1) {
        for (let x = 0; x < 8; x += 1) {
          if (((src.line[1] ?? 0) ^ (0x380 >> x)) === FULL) {
            if (((src.line[0] ?? 0) ^ (0x200 >> x)) !== FULL) break;
            return true;
          }
        }
        for (let x = 0; x < 8; x += 1) {
          if (((src.line[0] ?? 0) ^ (0x380 >> x)) === FULL) {
            if (((src.line[1] ?? 0) ^ (0x080 >> x)) !== FULL) break;
            return true;
          }
        }
      } else if (src.stackHeight === 2) {
        for (let x = 0; x < 9; x += 1) {
          if (((src.line[2] ?? 0) ^ (0x300 >> x)) === FULL) {
            if (((src.line[1] ?? 0) ^ (0x100 >> x)) !== FULL) break;
            if (((src.line[0] ?? 0) ^ (0x100 >> x)) !== FULL) break;
            return true;
          }
        }
      }
    } else if (m === "O") {
      if (src.stackHeight === 1) {
        for (let x = 0; x < 9; x += 1) {
          if (((src.line[1] ?? 0) ^ (0x300 >> x)) === FULL) {
            if (((src.line[0] ?? 0) ^ (0x300 >> x)) !== FULL) break;
            return true;
          }
        }
      }
    } else if (m === "T") {
      if (src.stackHeight === 1) {
        for (let x = 0; x < 8; x += 1) {
          if (((src.line[1] ?? 0) ^ (0x380 >> x)) === FULL) {
            if (((src.line[0] ?? 0) ^ (0x100 >> x)) !== FULL) break;
            return true;
          }
        }
      }
    } else if (m === "S") {
      if (src.stackHeight === 1) {
        for (let x = 0; x < 8; x += 1) {
          if (((src.line[1] ?? 0) ^ (0x180 >> x)) === FULL) {
            if (((src.line[0] ?? 0) ^ (0x300 >> x)) !== FULL) break;
            return true;
          }
        }
      }
    } else if (m === "Z") {
      if (src.stackHeight === 1) {
        for (let x = 0; x < 8; x += 1) {
          if (((src.line[1] ?? 0) ^ (0x300 >> x)) === FULL) {
            if (((src.line[0] ?? 0) ^ (0x180 >> x)) !== FULL) break;
            return true;
          }
        }
      }
    }
    return false;
  };
  if (garbageHeight === -1) {
    if (searchPc(fallingMino)) return w(ew, W.PcChance);
    if (fallingMino !== hold && hold !== null) {
      if (searchPc(hold)) return w(ew, W.PcChance);
    }
  }
  return 0;
}

/**
 * TransitionWeight (VS mode, multiEvaluation=false — the gate runs a single
 * player vs DeepSeek, so the opponent-combo branches never fire). Returns the
 * weightList index to use. `weightIndex` is the current index (starts at 0).
 */
export function transitionWeight(
  src: SourceBoard,
  weightIndex: number,
  isEvenBoard: boolean,
): number {
  let transitionHeight = 15;
  if (weightIndex >= 2) transitionHeight = 13;
  const column = new Array<number>(10).fill(-1);
  const garbageHeight = getColumnHeight(src, column);
  let center4Height = Math.max(column[3] ?? 0, column[4] ?? 0);
  center4Height = Math.max(column[5] ?? 0, center4Height);
  center4Height = Math.max(column[6] ?? 0, center4Height);
  if (center4Height + 1 <= transitionHeight) {
    if (src.stackHeight + 1 >= 11) return 0;
    if (!isEvenBoard) {
      if (weightIndex === 1) return 1;
      if (garbageHeight === -1 && src.stackHeight + 1 <= 5) return 1;
    }
    return 0;
  }
  return 2;
}

/** Per-node evaluation breakdown (EvaluateAI::Evaluate internals). */
export interface NodeEvaluation {
  readonly boardScore: number;
  readonly actionScore: number;
  /** familyScore contribution = trunc((actionScore + trunc(boardScore*nexus)) * trustRate). */
  readonly familyScore: number;
  /** score contribution = trunc((actionScore + boardScore) * trustRate). */
  readonly score: number;
  /** pcScore = EvalPrePcBoard (subtracted from the child's actionScore). */
  readonly pcScore: number;
}

/**
 * EvaluateAI::Evaluate — full per-node breakdown. `parentPcScore` is the
 * parent node's pcScore, subtracted from this node's actionScore (the native
 * `actionScore -= node->parentNode->pcScore`). The search accumulates
 * `familyScore`/`score` across the path; `evaluateNode` (below) returns only
 * the familyScore contribution for callers that do not track pcScore.
 */
export function evaluateNodeFull(
  src: SourceBoard,
  ctx: {
    readonly act: ClearAct;
    readonly combo: number;
    readonly btb: number;
    readonly lockedMino: PieceKind;
    readonly hold: PieceKind | null;
    readonly fallingMino: PieceKind;
    readonly moveDelay: number;
  },
  ew: HoikoWeights,
  weightIndex: number,
  isEvenBoard: boolean,
  useS4W: boolean,
  opponentIsPowerful: boolean,
  trustRate: number,
  parentPcScore: number,
): NodeEvaluation {
  const columnHeight = new Array<number>(10).fill(-1);
  const garbageHeight = getColumnHeight(src, columnHeight);
  let boardScore = 0;
  boardScore += evalHeight(src, columnHeight, ew);
  const well = evalWellColumn(src, columnHeight, garbageHeight, ew);
  boardScore += well.score;
  boardScore += evalUpDown(columnHeight, well.wellColumn, well.wellDepth, ew);
  boardScore += evalUnderground(src, columnHeight, garbageHeight, ew);
  // EvalGround = 0 (stubbed)
  boardScore += evalResource(
    src,
    columnHeight,
    garbageHeight,
    ew,
    useS4W,
    opponentIsPowerful,
    ctx.combo,
  );
  // EvalTsd = 0, EvalTst = 0, EvalPcBoard = 0 (stubbed)
  boardScore += evalContBonus(ctx.hold, ctx.btb, ew);
  let actionScore = evalFinalAction(
    ctx.act,
    ctx.lockedMino,
    ctx.combo,
    ctx.btb,
    ctx.moveDelay,
    ew,
    weightIndex,
  );
  actionScore -= parentPcScore;
  const nodePcScore = evalPrePcBoard(
    src,
    garbageHeight,
    ctx.fallingMino,
    ctx.hold,
    ew,
    isEvenBoard,
  );
  actionScore += nodePcScore;
  const fs = actionScore + Math.trunc(boardScore * ew.nexus);
  const familyScore = Math.trunc(fs * trustRate);
  const score = Math.trunc((actionScore + boardScore) * trustRate);
  return { boardScore, actionScore, familyScore, score, pcScore: nodePcScore };
}

/** EvaluateAI::Evaluate — per-node familyScore contribution. */
export function evaluateNode(
  src: SourceBoard,
  ctx: {
    readonly act: ClearAct;
    readonly combo: number;
    readonly btb: number;
    readonly lockedMino: PieceKind;
    readonly hold: PieceKind | null;
    readonly fallingMino: PieceKind;
    readonly moveDelay: number;
  },
  ew: HoikoWeights,
  weightIndex: number,
  isEvenBoard: boolean,
  useS4W: boolean,
  opponentIsPowerful: boolean,
  trustRate: number,
): number {
  return evaluateNodeFull(
    src,
    ctx,
    ew,
    weightIndex,
    isEvenBoard,
    useS4W,
    opponentIsPowerful,
    trustRate,
    0,
  ).familyScore;
}
