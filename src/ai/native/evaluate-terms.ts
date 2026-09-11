/**
 * Native EvaluateAI board terms (SPEC_EvaluateAI §2): GetHeight, GetWellColumn,
 * GetUpDown, GetUnderground, GetGround, GetResource. Rows are native orientation
 * (column c = bit 9-c); `ch` is the per-column height array from GetColumnHeight.
 */

import type { HoikoWeights } from "../hoiko-weights.js";
import type { Board } from "./board.js";
import { FULL_ROW, log2, popCount } from "./board.js";
import type { GamePack } from "./gamepack.js";
import { WI, columnAt, weightAt } from "./weight-index.js";

function w(ew: HoikoWeights, i: number): number {
  return weightAt(ew, i);
}

function col(ew: HoikoWeights, x: number): number {
  return columnAt(ew, x);
}

export function buildColumnHeight(board: Board, ch: Int32Array): number {
  ch.fill(-1);
  return board.getColumnHeight(ch);
}

export function getHeight(board: Board, ch: Int32Array, ew: HoikoWeights): number {
  let score = (board.stackHeight + 1) * w(ew, WI.MaxHeight);
  if (board.stackHeight > 9) {
    let c4 = Math.max(ch[3] ?? 0, ch[4] ?? 0, ch[5] ?? 0, ch[6] ?? 0);
    c4 = Math.max(10, c4);
    score += (c4 + 1 - 10) * w(ew, WI.Over10);
    if (c4 > 14) score += (c4 + 1 - 15) * w(ew, WI.Over15);
  }
  return score;
}

export function getWellColumn(
  board: Board,
  _ch: Int32Array,
  garbageHeight: number,
  ew: HoikoWeights,
): { score: number; wellColumn: number; wellDepth: number } {
  const well = (line: number): number => {
    if (popCount(line) !== 9) return -1;
    line += 1;
    return popCount(line) - 1;
  };
  const line = board.rowAt(garbageHeight + 1);
  const column = well(line);
  if (column === -1) return { score: 0, wellColumn: -1, wellDepth: 0 };
  let depth = 1;
  for (let y = garbageHeight + 2; y < 32; y += 1) {
    if (board.rowAt(y) !== line) break;
    depth += 1;
  }
  let hint = 1;
  const mask = (1280 >> column) & FULL_ROW;
  for (let y = garbageHeight + 2; y < 32; y += 1) {
    if ((board.rowAt(y) & mask) !== mask) break;
    hint += 1;
  }
  const peak = (dep: number): number => (dep === 2 ? 1 : Math.min(dep, w(ew, WI.WellPeak)));
  const score =
    peak(hint) * w(ew, WI.WellHint) + peak(depth) * w(ew, WI.WellDepth) + col(ew, column);
  return { score, wellColumn: column, wellDepth: depth };
}

export function getUpDown(
  ch: Int32Array,
  wellColumn: number,
  wellDepth: number,
  ew: HoikoWeights,
): number {
  const c = Int32Array.from(ch);
  const peak = (dep: number): number => Math.min(dep, w(ew, WI.WellPeak));
  if (wellColumn >= 0) c[wellColumn] = (c[wellColumn] ?? 0) + peak(wellDepth);
  let updown2 = 0;
  let diff = (c[0] ?? 0) - (c[1] ?? 0);
  updown2 += diff * diff * (diff < 0 ? 2 : 1);
  for (let x = 1; x < 8; x += 1) {
    diff = (c[x] ?? 0) - (c[x + 1] ?? 0);
    updown2 += diff * diff;
  }
  diff = (c[8] ?? 0) - (c[9] ?? 0);
  updown2 += diff * diff * (diff > 0 ? 2 : 1);
  return updown2 * w(ew, WI.UpDown2);
}

export function getUnderground(
  board: Board,
  ch: Int32Array,
  garbageHeight: number,
  ew: HoikoWeights,
): number {
  if (garbageHeight === -1) return 0;
  let cover = 0;
  let donateCover = 0;
  let bit = board.rowAt(garbageHeight) ^ FULL_ROW;
  let prevBit = bit;
  while (bit !== 0) {
    const x = bit & -bit;
    const depth = (ch[log2(x)] ?? 0) - garbageHeight;
    donateCover += Math.min(depth, 5);
    bit &= ~x;
  }
  for (let y = garbageHeight - 1; y >= 0; y -= 1) {
    bit = board.rowAt(y) ^ FULL_ROW;
    if ((bit & ~prevBit) !== 0) {
      let x = bit & -bit;
      if ((bit & ~x) === 0) {
        const depth = (ch[log2(x)] ?? 0) - y;
        cover += Math.min(depth, 5);
      } else {
        for (;;) {
          const depth = (ch[log2(x)] ?? 0) - y;
          donateCover += depth;
          bit &= ~x;
          if (bit === 0) break;
          x = bit & -bit;
        }
      }
    }
    prevBit = board.rowAt(y) ^ FULL_ROW;
  }
  return donateCover * w(ew, WI.DonateCover) + cover * w(ew, WI.Cover);
}

export function getResource(
  board: Board,
  _ch: Int32Array,
  garbageHeight: number,
  ew: HoikoWeights,
  useS4W: boolean,
): number {
  const well = (line: number): number => {
    if (popCount(line) !== 9) return -1;
    line += 1;
    return popCount(line) - 1;
  };
  let anabara = 0;
  let resource = 0;
  let line = board.rowAt(0);
  for (let y = 1; y <= garbageHeight; y += 1) {
    if ((line | board.rowAt(y)) !== line) anabara += 1;
    line = board.rowAt(y);
  }
  for (let y = garbageHeight + 1; y <= board.stackHeight; y += 1) {
    resource += popCount(board.rowAt(y));
    if (resource >= w(ew, WI.ResourceMax)) {
      resource = w(ew, WI.ResourceMax);
      break;
    }
  }
  line = 0;
  if (garbageHeight >= 0) {
    const x = well(board.rowAt(garbageHeight));
    if (x >= 0) line = Math.trunc(col(ew, x) * 0.5);
  }
  if (useS4W) {
    // UNDETERMINED: SPEC_EvaluateAI §8.2/#6 — the binary's S4W body is inert
    // under the shipped config (useS4W=false); the non-inert branch is not
    // reversed, so it contributes 0 here.
    line += 0;
  }
  return line + anabara * w(ew, WI.Anabara) + resource * w(ew, WI.Resource);
}

/** GetGround (SPEC_EvaluateAI §2, binary 11273-11346). */
export function getGround(g: GamePack, ch: Int32Array, y0: number, ew: HoikoWeights): number {
  let roof = 0;
  let roofCnt = 0;
  let badRoof = 0;
  let pierce = 0;
  const bd = g.board;
  const topRow = 0 >= bd.stackHeight ? 0 : bd.stackHeight;
  let cover = bd.rowAt(topRow);
  let y = bd.stackHeight - 1;
  if (y > y0) {
    let count = y - y0;
    do {
      let empty = ~bd.rowAt(y) & cover;
      let rowMax = 0;
      while (empty !== 0) {
        const x = log2(empty & -empty);
        const depth = (ch[x] ?? 0) - y;
        if (x < 8 && (ch[x + 1] ?? 0) < y) {
          if ((ch[x + 2] ?? 0) < y) {
            roof += depth;
            roofCnt += 1;
          } else {
            badRoof += depth;
          }
        } else if (x > 1 && (ch[x - 1] ?? 0) < y) {
          if ((ch[x - 2] ?? 0) < y) {
            roof += depth;
            roofCnt += 1;
          } else {
            badRoof += depth;
          }
        } else {
          rowMax = Math.max(rowMax, depth);
        }
        empty &= ~(512 >> x);
      }
      pierce += rowMax;
      cover |= bd.rowAt(y);
      y -= 1;
      count -= 1;
    } while (count !== 0);
    if (roofCnt === 1) roof = 1;
  }
  return w(ew, WI.Pierce) * pierce + w(ew, WI.BadRoof) * badRoof + w(ew, WI.Roof) * roof;
}
