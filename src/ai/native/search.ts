/**
 * Native SearchAI.Search (SPEC_Search §3, binary IL 15619) + MaxElement,
 * WriteResult and SetNextOption.
 *
 * Final selection is by RAW accumulated `score` at Node+308 — the binary has no
 * `CorrectScore`/`pcScore` correction. Generation 1 is never beam-capped; the
 * per-generation parent cap is `beamSizeLimit` (150, halved to 75 when depth>7).
 * The first move is recovered by propagating the gen-1 node's placed
 * rotation/column/hold flag, act and command moveDelay down the tree. Binary
 * `WriteResult` (IL 15774) walks `depth-1` parents from the best leaf, so it
 * copies the gen-1 node's GamePack to `root+120`; `RootNode.GetDelay` (IL 7148)
 * therefore reads the FIRST move's `moveDelay`/`act`, and `SetNextOption`
 * (IL 15892) uses that delay — never the leaf's.
 */

import type { HoikoWeights } from "../hoiko-weights.js";
import type { ExpandedChild } from "./baby.js";
import { evaluate, evaluateFirst, transitionWeight, type EvalOut } from "./evaluate.js";
import { expandNode } from "./expand.js";
import type { GamePack } from "./gamepack.js";
import { ACT_NONE, ACT_PC, type ClearAct } from "./shapes.js";

export interface SearchState {
  maxBeamSize: number;
  beamSizeLimit: number;
  timerLimitMs: number;
  weightIndex: number;
  minDepth: number;
  depthLimit: number;
}

export const TAKE_OVER_TIME = 5;

export function defaultSearchState(): SearchState {
  return {
    maxBeamSize: 50,
    beamSizeLimit: 150,
    timerLimitMs: 1000,
    weightIndex: 0,
    minDepth: 10,
    depthLimit: 14,
  };
}

interface NodeState {
  game: GamePack;
  score: number;
  familyScore: number;
  childCount: number;
  firstX: number;
  firstR: number;
  firstM: number;
  firstHold: boolean;
  firstAct: ClearAct;
  firstMoveDelay: number;
  firstY: number;
  firstLastSrs: number;
}

export interface SearchOutcome {
  readonly firstX: number;
  readonly firstR: number;
  readonly firstM: number;
  readonly firstHold: boolean;
  readonly firstAct: ClearAct;
  readonly score: number;
  readonly depth: number;
  readonly node: number;
  readonly overTime: number;
  readonly moveDelay: number;
  readonly firstPlacement: {
    readonly rotation: number;
    readonly x: number;
    readonly y: number;
    readonly lastSrs: number;
  };
}

function makeNode(child: ExpandedChild, parent: NodeState | null, genOne: boolean): NodeState {
  const lm = child.game.lockedMino;
  return {
    game: child.game,
    score: 0,
    familyScore: 0,
    childCount: 0,
    firstX: genOne || parent === null ? child.placedX : parent.firstX,
    firstR: genOne || parent === null ? child.placedR : parent.firstR,
    firstM: genOne || parent === null ? child.placedM : parent.firstM,
    firstHold: genOne || parent === null ? child.holdUsed : parent.firstHold,
    firstAct: genOne || parent === null ? child.act : parent.firstAct,
    firstMoveDelay:
      genOne || parent === null ? child.game.commands.moveDelay : parent.firstMoveDelay,
    firstY: genOne || parent === null ? lm.y : parent.firstY,
    firstLastSrs: genOne || parent === null ? lm.lastSrs : parent.firstLastSrs,
  };
}

function applyEval(node: NodeState, ev: EvalOut, parentFamily: number): void {
  node.familyScore = ev.familyScore + parentFamily;
  node.score = ev.score + parentFamily;
}

/** SearchAI.Search (IL 15619). Returns null when no first move exists. */
export function runSearch(
  state: SearchState,
  root: GamePack,
  weightList: readonly HoikoWeights[],
  isEvenBoard: boolean,
  useS4W: boolean,
  viewNext: number,
  now: () => number,
  timeLimitMs?: number,
  allowHold = true,
): SearchOutcome | null {
  const limit = timeLimitMs ?? state.timerLimitMs;
  const t0 = now();
  const weightIndex = transitionWeight(root.board, state.weightIndex, isEvenBoard);
  state.weightIndex = weightIndex;
  const ew = weightList[weightIndex] ?? weightList[0];
  if (ew === undefined) return null;

  const gen1 = expandNode(root, allowHold);
  if (gen1.length === 0) return null;

  let parents: NodeState[] = gen1.map((child) => {
    const node = makeNode(child, null, true);
    const ev = evaluateFirst(node.game, ew, weightIndex, isEvenBoard);
    node.familyScore = ev.familyScore;
    node.score = ev.familyScore;
    return node;
  });
  let total = parents.length;
  let depth = 1;
  let results: NodeState[] = parents;

  while (true) {
    depth += 1;
    const trustRate = depth > viewNext + 2 ? 0.9 : 1;
    let numChildren = 0;
    const children: NodeState[] = [];
    for (const parent of parents) {
      const expanded = expandNode(parent.game, allowHold);
      parent.childCount = expanded.length;
      numChildren += expanded.length;
      for (const c of expanded) {
        const node = makeNode(c, parent, false);
        const ev = evaluate(node.game, ew, weightIndex, isEvenBoard, useS4W, trustRate);
        applyEval(node, ev, parent.familyScore);
        children.push(node);
      }
      if (depth >= state.minDepth + 1 && now() - t0 > limit) break;
    }
    total += numChildren;
    results = children;
    if (depth >= state.depthLimit) break;
    if (depth >= state.minDepth && now() - t0 > limit) break;
    if (numChildren <= 0) break;
    const cap = depth > 7 ? Math.trunc(state.beamSizeLimit / 2) : state.beamSizeLimit;
    const nextBeam = Math.min(cap, numChildren);
    children.sort((a, b) => b.score - a.score);
    parents = children.slice(0, nextBeam);
  }

  if (results.length === 0) return null;
  let best = results[0];
  if (best === undefined) return null;
  for (const n of results) if (n.score > best.score) best = n;

  const overTime = now() - t0 - limit;
  return {
    firstX: best.firstX,
    firstR: best.firstR,
    firstM: best.firstM,
    firstHold: best.firstHold,
    firstAct: best.firstAct,
    score: best.score,
    depth,
    node: total,
    overTime,
    moveDelay: best.firstMoveDelay,
    firstPlacement: {
      rotation: ((best.firstR % 4) + 4) % 4,
      x: best.firstX,
      y: best.firstY,
      lastSrs: best.firstLastSrs,
    },
  };
}

function clearDelay(act: ClearAct): number {
  switch (act) {
    case ACT_NONE:
      return 0;
    case 1:
    case 5:
    case 8:
      return 36;
    case 2:
    case 3:
    case 6:
    case 7:
      return 41;
    case 4:
      return 46;
    case ACT_PC:
      return 1;
    default:
      return 0;
  }
}

export function getDelay(moveDelay: number, act: ClearAct): number {
  return clearDelay(act) * 16 + moveDelay;
}

/** SearchAI.SetNextOption (IL 15892): readies the globals for the next search. */
export function setNextOption(
  state: SearchState,
  overTime: number,
  depth: number,
  moveDelay: number,
  act: ClearAct,
  safe: boolean,
): void {
  if (overTime > 0) {
    state.maxBeamSize += (depth - 14) * 10;
    state.maxBeamSize = Math.min(500, Math.max(50, state.maxBeamSize));
  } else if (overTime < -33 && state.timerLimitMs < 336) {
    state.maxBeamSize += Math.trunc((overTime + 16) * 0.06) * -10;
    state.maxBeamSize = Math.min(500, Math.max(50, state.maxBeamSize));
  }
  state.timerLimitMs = getDelay(moveDelay, act) - TAKE_OVER_TIME;
  state.beamSizeLimit = Math.trunc((state.maxBeamSize * state.timerLimitMs) / 112);
  state.beamSizeLimit = Math.min(state.beamSizeLimit, state.maxBeamSize * 3);
  if (!safe) state.beamSizeLimit = Math.trunc(state.beamSizeLimit * 0.8);
  state.depthLimit = 14;
}
