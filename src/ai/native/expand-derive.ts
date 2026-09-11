/**
 * ExpandAI.ExpandDeriveNode + the TryDerive helpers and GetAboveCell
 * (SPEC_ExpandAI §4.3-§4.10).
 * Derived placements are soft-dropped tucks (T-spins, spins into gaps); they are
 * only emitted when the derive guard detects an overhang/hole (or the piece is T).
 */

import type { Board } from "./board.js";
import type { Baby } from "./baby.js";
import { addBaby, overrideSameNode } from "./baby.js";
import { shapeFor } from "./shapes.js";

export function getAboveCell(columnHeight: Int32Array, mino: Baby["fallingMino"]): number {
  const cells = shapeFor(mino.m, mino.r).cells;
  for (const c of cells) {
    const col = mino.x + c.x;
    const row = mino.y - c.y;
    if ((columnHeight[col] ?? -1) > row) return 1;
  }
  return 0;
}

function deriveGuard(root: Baby, columnHeight: Int32Array, board: Board): boolean {
  if (root.fallingMino.m === 4) return true;
  let minH = columnHeight[0] ?? 0;
  for (let x = 1; x < 10; x += 1) minH = Math.min(minH, columnHeight[x] ?? 0);
  let acc = board.rowAt(Math.max(board.stackHeight, 0));
  for (let y = board.stackHeight - 1; y > minH; y -= 1) {
    const row = board.rowAt(y);
    if (((row ^ 0x3ff) & acc) !== 0) return true;
    acc |= row;
  }
  return false;
}

function tryDeriveRotateB(target: Baby, board: Board, ch: Int32Array, buckets: Baby[][]): number {
  if (target.commands.rotateB(target.fallingMino, board) === 0) return 0;
  const f = target.fallingMino;
  if (getAboveCell(ch, f) === 0) {
    const special =
      f.m === 4 &&
      f.lastSrs === 2 &&
      f.r === 3 &&
      (((512 >> (f.x + 1)) | board.rowAt(f.y - 2)) === 1023);
    if (!special) return 0;
  }
  return overrideSameNode(buckets, target) !== 1 ? 1 : 0;
}

function tryDeriveRotateA(target: Baby, board: Board, ch: Int32Array, buckets: Baby[][]): number {
  if (target.commands.rotateA(target.fallingMino, board) === 0) return 0;
  const f = target.fallingMino;
  if (getAboveCell(ch, f) === 0) {
    const special =
      f.m === 4 &&
      f.lastSrs === 2 &&
      f.r === 1 &&
      (((512 >> (f.x + 1)) | board.rowAt(f.y - 2)) === 1023);
    if (!special) return 0;
  }
  return overrideSameNode(buckets, target) !== 1 ? 1 : 0;
}

function tryDeriveMove(
  target: Baby,
  board: Board,
  ch: Int32Array,
  buckets: Baby[][],
  dir: "left" | "right",
): number {
  const step = (): number =>
    dir === "left"
      ? target.commands.moveLeft(target.fallingMino, board)
      : target.commands.moveRight(target.fallingMino, board);
  if (step() === 0) return 0;
  if (getAboveCell(ch, target.fallingMino) === 0) return 0;
  let n = 0;
  while (step() !== 0) {
    if (getAboveCell(ch, target.fallingMino) !== 0) {
      n += 1;
      if (n >= 10) break;
      continue;
    }
    return 0;
  }
  return overrideSameNode(buckets, target) !== 1 ? 1 : 0;
}

function tryDeriveFinB(target: Baby, board: Board, buckets: Baby[][]): number {
  const f = target.fallingMino;
  if ((board.rowAt(f.y - 2) & (512 >> f.x)) > 0) {
    if (target.commands.moveRight(f, board) === 0) return 0;
    target.commands.moveDelay -= 30;
  }
  if (target.commands.rotateB(f, board) === 0) return 0;
  if (
    f.lastSrs === 5 &&
    (((512 >> (f.x + 1)) | board.rowAt(f.y - 2)) === 1023)
  ) {
    return overrideSameNode(buckets, target) !== 1 ? 1 : 0;
  }
  return 0;
}

function tryDeriveFinA(target: Baby, board: Board, buckets: Baby[][]): number {
  const f = target.fallingMino;
  if (((512 >> (f.x + 2)) & board.rowAt(f.y - 2)) > 0) {
    if (target.commands.moveLeft(f, board) === 0) return 0;
    target.commands.moveDelay -= 30;
  }
  if (target.commands.rotateA(f, board) === 0) return 0;
  if (
    f.lastSrs === 5 &&
    (((512 >> (f.x + 1)) | board.rowAt(f.y - 2)) === 1023)
  ) {
    return overrideSameNode(buckets, target) !== 1 ? 1 : 0;
  }
  return 0;
}

/** ExpandDeriveNode (IL 14706); appends derived babies, returns new count. */
export function expandDeriveNode(
  babies: Baby[],
  board: Board,
  columnHeight: Int32Array,
  buckets: Baby[][],
): number {
  const root = babies[0];
  if (root === undefined || !deriveGuard(root, columnHeight, board)) return babies.length;
  let num = 0;
  let num2 = babies.length;
  while (num < babies.length) {
    const end = babies.length;
    for (let i = num; i < end; i += 1) {
      const src = babies[i];
      if (src === undefined) continue;
      const local = src.clone();
      local.commands.softDrop(local.fallingMino, board);

      let cand = local.clone();
      if (tryDeriveMove(cand, board, columnHeight, buckets, "left") === 1) {
        addBaby(buckets, cand);
        babies.push(cand);
        if (cand.fallingMino.m === 4 && cand.fallingMino.r === 2) {
          const fin = cand.clone();
          if (tryDeriveFinB(fin, board, buckets) === 1) {
            addBaby(buckets, fin);
            babies.push(fin);
          }
        }
      }
      cand = local.clone();
      if (tryDeriveMove(cand, board, columnHeight, buckets, "right") === 1) {
        addBaby(buckets, cand);
        babies.push(cand);
        if (cand.fallingMino.m === 4 && cand.fallingMino.r === 2) {
          const fin = cand.clone();
          if (tryDeriveFinA(fin, board, buckets) === 1) {
            addBaby(buckets, fin);
            babies.push(fin);
          }
        }
      }
      cand = local.clone();
      if (tryDeriveRotateB(cand, board, columnHeight, buckets) === 1) {
        addBaby(buckets, cand);
        babies.push(cand);
      }
      cand = local.clone();
      if (tryDeriveRotateA(cand, board, columnHeight, buckets) === 1) {
        addBaby(buckets, cand);
        babies.push(cand);
      }
    }
    if (num2 === babies.length) break;
    num = num2;
    num2 = babies.length;
  }
  return babies.length;
}
