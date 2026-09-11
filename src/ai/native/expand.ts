/**
 * ExpandAI.ExpandNode / ExpandBaseNode / RegistChildNode (SPEC_ExpandAI §4.1-§4.2,
 * §4.13). Expansion is selected by board state exactly as the binary:
 * `!IsSafe ? ExpandBaseNode : ExpandTemplateNode`, then ExpandDeriveNode and
 * RegistChildNode; a hold-swap pass follows when the current piece != hold.
 */

import type { Board } from "./board.js";
import {
  Baby,
  type ExpandedChild,
  addBaby,
  clearBabyBuckets,
  copyGame,
  makeRootBaby,
  newBabyBuckets,
  overrideSameNode,
} from "./baby.js";
import { expandDeriveNode } from "./expand-derive.js";
import { expandTemplateNode } from "./expand-template.js";
import { GamePack } from "./gamepack.js";

export const MAX_CHILDREN = 100;
const BASE_PRUNE_THRESHOLD = 34;
const PRUNE_MARKER = 1000000;
const PRUNE_KEEP_BELOW = 10000;
const CHILD_BUCKETS = 64;

function getFilteredCount(buckets: Baby[][], childCount: number): number {
  let kept = childCount;
  for (const bucket of buckets) {
    const c = bucket.length;
    if (c > 1) {
      kept += 1 - c;
      let best = bucket[0];
      for (const b of bucket) {
        if (best === undefined || b.commands.moveDelay < best.commands.moveDelay) best = b;
      }
      for (const b of bucket) if (b !== best) b.commands.moveDelay = PRUNE_MARKER;
    }
  }
  return kept;
}

/** ExpandBaseNode (IL 14595): BFS over L,R,B,A from the spawn state. */
export function expandBaseNode(babies: Baby[], board: Board, buckets: Baby[][]): number {
  let num = 0;
  let num2 = 1;
  while (true) {
    if (num < num2) {
      const end = num2;
      for (let i = num; i < end; i += 1) {
        const src = babies[i];
        if (src === undefined) continue;
        for (const cmd of ["left", "right", "rotB", "rotA"] as const) {
          const cand = src.clone();
          const ok =
            cmd === "left"
              ? cand.commands.moveLeft(cand.fallingMino, board)
              : cmd === "right"
                ? cand.commands.moveRight(cand.fallingMino, board)
                : cmd === "rotB"
                  ? cand.commands.rotateB(cand.fallingMino, board)
                  : cand.commands.rotateA(cand.fallingMino, board);
          if (ok === 1 && overrideSameNode(buckets, cand) === 0) {
            addBaby(buckets, cand);
            babies.push(cand);
          }
        }
      }
    }
    if (num2 === babies.length) break;
    num = num2;
    num2 = babies.length;
  }
  const count = babies.length;
  if (count > BASE_PRUNE_THRESHOLD) {
    const kept = getFilteredCount(buckets, count);
    const filtered = babies.filter((b) => b.commands.moveDelay < PRUNE_KEEP_BELOW);
    babies.length = 0;
    babies.push(...filtered.slice(0, kept));
    clearBabyBuckets(buckets);
    for (let i = 0; i < kept; i += 1) {
      const b = babies[i];
      if (b !== undefined) addBaby(buckets, b);
    }
  }
  return babies.length;
}

function deleteSameNode(childBuckets: ExpandedChild[][], cand: ExpandedChild): number {
  const lb = cand.game.board.lockedBottom;
  const r = cand.game.lockedMino.r;
  const bucket = childBuckets[lb * 2 + (r & 1)];
  if (bucket === undefined) return 0;
  for (const s of bucket) {
    if (s.game.board.rowAt(lb) !== cand.game.board.rowAt(lb)) continue;
    if (s.game.board.rowAt(lb + 1) !== cand.game.board.rowAt(lb + 1)) continue;
    if (s.game.board.rowAt(lb + 2) !== cand.game.board.rowAt(lb + 2)) continue;
    if (s.game.board.rowAt(lb + 3) !== cand.game.board.rowAt(lb + 3)) continue;
    if (s.game.act !== cand.game.act) continue;
    if (s.game.commands.moveDelay > cand.game.commands.moveDelay) {
      copyGame(s.game, cand.game);
      s.placedX = cand.placedX;
      s.placedR = cand.placedR;
      s.placedM = cand.placedM;
      s.holdUsed = cand.holdUsed;
      s.act = cand.act;
    }
    return 1;
  }
  return 0;
}

function registChildNode(babies: Baby[], parent: GamePack, holdUsed: boolean): ExpandedChild[] {
  const childBuckets: ExpandedChild[][] = Array.from({ length: CHILD_BUCKETS }, () => []);
  const out: ExpandedChild[] = [];
  for (const baby of babies) {
    const g = new GamePack();
    g.board.line.set(parent.board.line);
    g.board.stackHeight = parent.board.stackHeight;
    g.board.lockedBottom = parent.board.lockedBottom;
    g.combo = parent.combo;
    g.btb = parent.btb;
    g.fallingMino = baby.fallingMino.clone();
    g.hold.m = baby.hold.m;
    g.hold.swappedHold = baby.hold.swappedHold;
    g.hold.abnormalHold = baby.hold.abnormalHold;
    g.nextIt.copyFrom(baby.nextIt);
    g.commands.s.length = 0;
    g.commands.s.push(...baby.commands.s);
    g.commands.moveDelay = baby.commands.moveDelay;
    if (g.lockDown() === 0) continue;
    const cand: ExpandedChild = {
      game: g,
      holdUsed,
      placedX: g.lockedMino.x,
      placedR: g.lockedMino.r,
      placedM: g.lockedMino.m,
      act: g.act,
    };
    if (deleteSameNode(childBuckets, cand) === 1) continue;
    childBuckets[g.board.lockedBottom * 2 + (g.lockedMino.r & 1)]?.push(cand);
    out.push(cand);
  }
  return out;
}

/** ExpandNode (IL 14207): non-hold + hold passes, capped at MAX_CHILDREN. */
export function expandNode(parent: GamePack, allowHold = true): ExpandedChild[] {
  const ch = new Int32Array(10).fill(-1);
  parent.board.getColumnHeight(ch);
  const safe = parent.isSafe();

  const root = makeRootBaby(parent);
  const babies: Baby[] = [root];
  const buckets = newBabyBuckets();
  addBaby(buckets, root);
  if (safe) expandTemplateNode(babies, root);
  else expandBaseNode(babies, parent.board, buckets);
  expandDeriveNode(babies, parent.board, ch, buckets);
  const out = registChildNode(babies, parent, false);

  if (allowHold && parent.fallingMino.m !== parent.hold.m) {
    const holdBaby = makeRootBaby(parent);
    holdBaby.commands.swapHold(holdBaby.fallingMino, holdBaby.hold, parent.board, holdBaby.nextIt);
    const hb: Baby[] = [holdBaby];
    const hbuckets = newBabyBuckets();
    addBaby(hbuckets, holdBaby);
    if (safe) expandTemplateNode(hb, holdBaby);
    else expandBaseNode(hb, parent.board, hbuckets);
    expandDeriveNode(hb, parent.board, ch, hbuckets);
    for (const c of registChildNode(hb, parent, true)) {
      if (out.length >= MAX_CHILDREN) break;
      out.push(c);
    }
  }
  return out.slice(0, MAX_CHILDREN);
}
