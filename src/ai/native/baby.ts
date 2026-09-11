/**
 * ExpandAI BabyNode + ExpandedBaby bucket helpers (SPEC_ExpandAI §1, §5, §6).
 *
 * `Baby` mirrors the 120-byte native BabyNode (fallingMino/commands/hold/nextIt).
 * `ExpandedBaby` is 48 buckets keyed by `r*12 + (x+2)`; `OverrideSameNode`
 * dedups within a bucket by `(r, x, y)` keeping the smaller `commands.moveDelay`.
 */

import type { GamePack } from "./gamepack.js";
import { Command, FallMino, HoldMino } from "./mino.js";
import { NextIterator } from "./nextmino.js";
import type { ClearAct } from "./shapes.js";

// UNDETERMINED: SPEC_ExpandAI §8.3 — the binary has no bounds check on its
// 300-slot babyNode arena; the port grows JS arrays instead of capping.
export const MAX_BABYS = 300;
export const BABY_BUCKETS = 48;

export class Baby {
  fallingMino = new FallMino();
  commands = new Command();
  hold = new HoldMino();
  nextIt = new NextIterator();

  clone(): Baby {
    const b = new Baby();
    b.copyFrom(this);
    return b;
  }

  copyFrom(src: Baby): void {
    this.fallingMino = src.fallingMino.clone();
    this.commands.s.length = 0;
    this.commands.s.push(...src.commands.s);
    this.commands.moveDelay = src.commands.moveDelay;
    this.hold.m = src.hold.m;
    this.hold.swappedHold = src.hold.swappedHold;
    this.hold.abnormalHold = src.hold.abnormalHold;
    this.nextIt.copyFrom(src.nextIt);
  }
}

export function makeRootBaby(parent: GamePack): Baby {
  const b = new Baby();
  b.fallingMino = parent.fallingMino.clone();
  b.hold = parent.hold.clone();
  b.nextIt.copyFrom(parent.nextIt);
  b.commands.init();
  return b;
}

export function newBabyBuckets(): Baby[][] {
  return Array.from({ length: BABY_BUCKETS }, () => [] as Baby[]);
}

export function clearBabyBuckets(buckets: Baby[][]): void {
  for (const bucket of buckets) bucket.length = 0;
}

function bucketIndex(baby: Baby): number {
  return baby.fallingMino.r * 12 + (baby.fallingMino.x + 2);
}

export function addBaby(buckets: Baby[][], baby: Baby): void {
  const idx = bucketIndex(baby);
  const bucket = buckets[idx];
  if (bucket === undefined) return;
  bucket.push(baby);
}

/** OverrideSameNode (IL 14270): returns 1 when an (r,x,y) match exists. */
export function overrideSameNode(buckets: Baby[][], target: Baby): number {
  const bucket = buckets[bucketIndex(target)];
  if (bucket === undefined) return 0;
  const y = target.fallingMino.y;
  for (const s of bucket) {
    if (s.fallingMino.y !== y) continue;
    if (s.commands.moveDelay > target.commands.moveDelay) s.copyFrom(target);
    return 1;
  }
  return 0;
}

export interface ExpandedChild {
  game: GamePack;
  holdUsed: boolean;
  placedX: number;
  placedR: number;
  placedM: number;
  act: ClearAct;
}

export function copyGame(dst: GamePack, src: GamePack): void {
  dst.nextIt.copyFrom(src.nextIt);
  dst.hold.m = src.hold.m;
  dst.hold.swappedHold = src.hold.swappedHold;
  dst.hold.abnormalHold = src.hold.abnormalHold;
  dst.fallingMino = src.fallingMino.clone();
  dst.lockedMino = src.lockedMino.clone();
  dst.board.line.set(src.board.line);
  dst.board.stackHeight = src.board.stackHeight;
  dst.board.lockedBottom = src.board.lockedBottom;
  dst.commands.s.length = 0;
  dst.commands.s.push(...src.commands.s);
  dst.commands.moveDelay = src.commands.moveDelay;
  dst.combo = src.combo;
  dst.btb = src.btb;
  dst.act = src.act;
}
