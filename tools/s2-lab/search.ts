/** S2 integration specialization of src/ai/bot/search.ts.
 * The beam algorithm and weights are unchanged. Only exact B2B, staged S2
 * awards/spin classification and amount-only root garbage timing differ.
 * Kept here to avoid changing the shipping guideline bot/benchmark policy.
 */
/**
 * Beam search over the known piece queue.
 *
 * Every node is a board after some placements. A node's value is the (discounted) sum of
 * the rewards of the placements that led to it plus the weighted shape of its board. Each
 * ply expands every surviving node with every reachable placement of the current piece
 * (and of the hold piece), then keeps the best `width` children. The move played is the
 * first placement on the line that ends at the best leaf.
 */

import { BOARD_FEATURES, type BoardFeatures, boardFeatures } from "../../src/ai/bot/features.js";
import {
  type BitBoard,
  collides,
  FULL_ROW,
  generatePlacements,
  lockPlacement,
  type Placement,
  spawnPosition,
} from "../../src/ai/bot/movegen.js";
import type { ClearKind, Weights } from "../../src/ai/bot/weights.js";
import { cellsFor, type PieceKind } from "../../src/core/pieces.js";
import { awardLock, s2GarbageMultiplier } from "../../src/core/rules.js";
import { classifyS2Spin } from "../../src/core/s2-spin.js";
import type { TspinKind } from "../../src/core/tspin.js";

export interface SearchInput {
  readonly board: BitBoard;
  /** Logical referee frame at the root decision (lockTime). */
  readonly frame?: number;
  /** Garbage flags in bottom-first order, index 0 = bottom. */
  readonly garbageRows?: readonly number[];
  readonly active: { kind: PieceKind; rotation: number; x: number; y: number };
  readonly hold: PieceKind | null;
  readonly canHold: boolean;
  /** Upcoming pieces after the active one (the visible preview). */
  readonly preview: readonly PieceKind[];
  readonly b2b: number;
  /** Engine combo counter: -1 = no chain, 0 = first clear of a chain, ... */
  readonly combo: number;
  /** Incoming garbage rows not yet on the board. */
  readonly pending: number;
  readonly dueThisLock: number;
  /** Referee kickset witness required for root placements only. */
  readonly acceptRoot?: (placement: Placement, usedHold: boolean) => boolean;
  /** Possible next pieces after the visible queue, uniformly distributed by 7-bag. */
  readonly speculativePieces?: readonly PieceKind[];
}

export interface SearchOptions {
  readonly weights: Weights;
  readonly width: number;
  /** Preserve roots and attack-economy states in competition search. */
  readonly diverse?: boolean;
  /** Cost per squared exposed row on every intermediate board. */
  readonly exposure?: number;
}

export interface Step {
  readonly placement: Placement;
  readonly usedHold: boolean;
  readonly linesCleared: number;
  readonly attack: number;
  readonly reward: number;
}

/** One candidate first move with the value of the best line that starts with it. */
export interface Candidate {
  readonly placement: Placement;
  readonly usedHold: boolean;
  readonly value: number;
}

export interface SearchResult {
  readonly best: Step;
  /** The full planned line (first element = `best`). */
  readonly line: readonly Step[];
  readonly value: number;
  /** Shape breakdown of the board after the first move (feature -> weighted points). */
  readonly breakdown: Readonly<Record<string, number>>;
  /** Best first moves, best first. */
  readonly candidates: readonly Candidate[];
  readonly nodes: number;
  readonly depth: number;
}

interface Node {
  readonly board: BitBoard;
  /** Garbage flags in the same top-first coordinates as board. */
  readonly garbageRows: Uint8Array;
  readonly hold: PieceKind | null;
  /** Index into the piece sequence of the piece to place next. */
  readonly next: number;
  readonly canHold: boolean;
  readonly b2b: number;
  readonly combo: number;
  /** Garbage rows that have landed under the stack during the line. */
  readonly lift: number;
  readonly tSlot: number;
  readonly reward: number;
  readonly value: number;
  readonly depth: number;
  readonly step: Step | null;
  readonly parent: Node | null;
  readonly root: number;
}

export function search(input: SearchInput, options: SearchOptions): SearchResult | null {
  const { weights: w, width } = options;
  const sequence: PieceKind[] = [input.active.kind, ...input.preview];
  const rootFeatures = boardFeatures(input.board, 0);
  const root: Node = {
    board: input.board,
    garbageRows: Uint8Array.from(input.board, (_, row) => (input.garbageRows?.[row] ? 1 : 0)),
    hold: input.hold,
    next: 0,
    canHold: input.canHold,
    b2b: input.b2b,
    combo: input.combo,
    lift: 0,
    tSlot: rootFeatures.tSlot,
    reward: 0,
    value: 0,
    depth: 0,
    step: null,
    parent: null,
    root: -1,
  };
  let beam: Node[] = [root];
  let nodes = 0;
  const firstMoves: Node[] = [];
  const finished: Node[] = [];
  let deepest: Node[] = [];

  while (beam.length > 0) {
    const children: Node[] = [];
    for (const node of beam) {
      const pieces = pieceOptions(node, sequence);
      // Out of known pieces: the line ends here. (A node whose piece has no legal
      // placement is a top-out and simply produces no children.)
      if (pieces.length === 0) {
        const possibilities = input.speculativePieces ?? [];
        if (possibilities.length === 0) finished.push(node);
        else {
          let sum = 0;
          for (const kind of possibilities) {
            let best = Number.NEGATIVE_INFINITY;
            const future = [...sequence, kind];
            for (const option of pieceOptions(node, future)) {
              for (const placement of generatePlacements(
                node.board,
                option.kind,
                spawnPosition(option.kind, node.board.length),
              )) {
                const child = expand(
                  node,
                  placement,
                  option,
                  0,
                  w,
                  0,
                  options.exposure ?? 0,
                  0,
                  input.frame ?? 0,
                );
                nodes += 1;
                if (child !== null) best = Math.max(best, child.value);
              }
            }
            // A dead branch must not disappear from the chance average.
            sum += Number.isFinite(best) ? best : -1_000_000;
          }
          finished.push({ ...node, value: sum / possibilities.length });
        }
      }
      for (const option of pieces) {
        const start =
          node.depth === 0 && !option.usedHold
            ? input.active
            : option.usedHold && node.hold !== null
              ? { rotation: 0, x: 3, y: node.board.length > 20 ? node.board.length - 21 : 0 }
              : spawnPosition(option.kind, node.board.length);
        for (const placement of generatePlacements(node.board, option.kind, start)) {
          if (node.depth === 0 && input.acceptRoot && !input.acceptRoot(placement, option.usedHold))
            continue;
          const child = expand(
            node,
            placement,
            option,
            input.pending,
            w,
            firstMoves.length,
            options.exposure ?? 0,
            input.dueThisLock,
            input.frame ?? 0,
          );
          nodes += 1;
          if (child === null) continue;
          if (node.depth === 0) firstMoves.push(child);
          children.push(child);
        }
      }
    }
    children.sort((a, b) => b.value - a.value);
    beam = options.diverse ? selectBeam(children, width) : dedupe(children, width);
    if (beam.length > 0) deepest = beam;
  }
  // Normal case: lines that used every known piece. If every line tops out first, fall
  // back to the deepest surviving positions so the bot still picks its best try.
  const leaves = finished.length > 0 ? finished : deepest;
  let bestLeaf: Node | null = null;
  for (const leaf of leaves) {
    if (leaf.depth === 0) continue;
    if (bestLeaf === null || leaf.value > bestLeaf.value) bestLeaf = leaf;
  }
  if (bestLeaf === null) return null;

  const line: Step[] = [];
  for (let n: Node | null = bestLeaf; n !== null && n.step !== null; n = n.parent)
    line.unshift(n.step);
  const first = firstMoves[bestLeaf.root] as Node;

  const rootBest = new Map<number, number>();
  for (const leaf of leaves) {
    if (leaf.depth === 0) continue;
    const prev = rootBest.get(leaf.root);
    if (prev === undefined || leaf.value > prev) rootBest.set(leaf.root, leaf.value);
  }
  const candidates: Candidate[] = [...rootBest.entries()]
    .map(([index, value]) => {
      const n = firstMoves[index] as Node;
      const step = n.step as Step;
      return { placement: step.placement, usedHold: step.usedHold, value };
    })
    .sort((a, b) => b.value - a.value);

  return {
    best: line[0] as Step,
    line,
    value: bestLeaf.value,
    breakdown: weighBoard(boardFeatures(first.board, first.lift), w),
    candidates,
    nodes,
    depth: bestLeaf.depth,
  };
}

interface PieceOption {
  readonly kind: PieceKind;
  readonly usedHold: boolean;
  readonly next: number;
  readonly hold: PieceKind | null;
}

function pieceOptions(node: Node, sequence: readonly PieceKind[]): PieceOption[] {
  const current = sequence[node.next];
  if (current === undefined) return [];
  const options: PieceOption[] = [
    { kind: current, usedHold: false, next: node.next + 1, hold: node.hold },
  ];
  if (!node.canHold) return options;
  if (node.hold === null) {
    const after = sequence[node.next + 1];
    if (after !== undefined && after !== current) {
      options.push({ kind: after, usedHold: true, next: node.next + 2, hold: current });
    }
  } else if (node.hold !== current) {
    options.push({ kind: node.hold, usedHold: true, next: node.next + 1, hold: current });
  }
  return options;
}

function clearKind(lines: number, tspin: TspinKind, perfectClear: boolean): ClearKind | null {
  if (lines === 0) return null;
  if (perfectClear) return "perfectClear";
  if (tspin === "mini") return "tspinMini";
  if (tspin === "full")
    return lines === 1 ? "tspinSingle" : lines === 2 ? "tspinDouble" : "tspinTriple";
  return lines === 1 ? "single" : lines === 2 ? "double" : lines === 3 ? "triple" : "quad";
}

function expand(
  node: Node,
  placement: Placement,
  option: PieceOption,
  rootPending: number,
  w: Weights,
  rootIndex: number,
  exposure: number,
  dueThisLock: number,
  rootFrame: number,
): Node | null {
  // Use staged S2 lock awards and All-Mini+; exact d is never reduced to a flag.
  const spin = classifyS2Spin(
    placement,
    (x, y) =>
      x < 0 ||
      x >= 10 ||
      y >= node.board.length ||
      (y >= 0 && ((node.board[y] ?? 0) & (1 << x)) !== 0),
    (dx, dy) =>
      !collides(node.board, placement.kind, placement.rotation, placement.x + dx, placement.y + dy),
  );
  placement = { ...placement, tspin: spin };
  // Match lockPlacement's cell coordinates and bottom-to-top survivor collapse.
  const filled = node.board.slice();
  for (const cell of cellsFor(placement.kind, placement.rotation)) {
    const row = placement.y + cell.y;
    if (row >= 0 && row < filled.length)
      filled[row] = (filled[row] as number) | (1 << (placement.x + cell.x));
  }
  const garbageRows = new Uint8Array(node.board.length);
  let garbageCleared = 0;
  let write = 0;
  for (let read = 0; read < filled.length; read += 1) {
    if (filled[read] === FULL_ROW) {
      garbageCleared += node.garbageRows[read] ?? 0;
    } else {
      garbageRows[write++] = node.garbageRows[read] ?? 0;
    }
  }
  const outcome = lockPlacement(node.board, placement);
  const lines = outcome.linesCleared;
  const combo = lines > 0 ? node.combo + 1 : -1;
  const award = awardLock(
    "tetrio-s2",
    {
      lines,
      tspinLines: spin === "full" ? lines : 0,
      tspinKind: spin,
      combo,
      b2bActive: node.b2b > 0,
      perfectClear: outcome.perfectClear,
    },
    node.b2b,
    { multiplier: s2GarbageMultiplier(rootFrame + 60 * node.depth), garbageCleared },
  );
  const attack = award.attack;
  const difficult = lines > 0 && (lines === 4 || spin !== "none" || outcome.perfectClear);
  const b2b = award.difficultChain;

  // Garbage: our attack cancels what is pending; the rest lands under the stack on this
  // lock (garbage delay 1). Only the root's pending garbage is known.
  const pending = node.depth === 0 ? rootPending : 0;
  const lift = node.lift + (lines === 0 ? Math.min(dueThisLock, Math.max(0, pending - attack)) : 0);

  let reward = attack * w.attack;
  // Attack is paid pre-cancel; only excess converts to pressure. Pending is known only at root.
  if (node.depth === 0) reward += w.conversion * Math.max(0, attack - rootPending);
  const kind = clearKind(lines, placement.tspin, outcome.perfectClear);
  if (kind !== null) reward += w.clear[kind];
  if (node.b2b && lines > 0 && !difficult && !outcome.perfectClear) reward += w.b2bBreak;
  if (placement.kind === "T" && placement.tspin === "none" && node.tSlot > 0) reward += w.wastedT;

  const features = boardFeatures(outcome.board, lift);
  if (features.maxHeight >= node.board.length) return null;
  const scale = w.discount ** node.depth;
  const accumulated = node.reward + scale * (reward - exposure * features.danger);
  const value = accumulated + scale * w.discount * dot(features, w);

  return {
    board: outcome.board,
    garbageRows,
    hold: option.hold,
    next: option.next,
    canHold: true,
    b2b,
    combo,
    lift,
    tSlot: features.tSlot,
    reward: accumulated,
    value,
    depth: node.depth + 1,
    step: { placement, usedHold: option.usedHold, linesCleared: lines, attack, reward },
    parent: node,
    root: node.depth === 0 ? rootIndex : node.root,
  };
}

function dot(features: BoardFeatures, w: Weights): number {
  let total = 0;
  for (const name of BOARD_FEATURES) total += features[name] * w.board[name];
  return total;
}

function weighBoard(features: BoardFeatures, w: Weights): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of BOARD_FEATURES) out[name] = features[name] * w.board[name];
  return out;
}

/** Keep the best `width` children, dropping later copies of an identical position. */
function dedupe(sorted: readonly Node[], width: number): Node[] {
  const kept: Node[] = [];
  const seen = new Set<string>();
  for (const node of sorted) {
    if (kept.length >= width) break;
    const key = `${node.next}|${node.hold}|${node.b2b}|${node.combo}|${node.board.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(node);
  }
  return kept;
}

/** Keep distinct attack economies and reserve a bounded set of first moves. */
export function selectBeam<
  T extends {
    board: BitBoard;
    next: number;
    hold: PieceKind | null;
    canHold: boolean;
    b2b: number;
    combo: number;
    lift: number;
    root: number;
    value: number;
  },
>(sorted: readonly T[], width: number): T[] {
  if (width <= 0) return [];
  const pool: T[] = [];
  const seen = new Set<string>();
  for (const node of sorted) {
    const key = `${node.next}|${node.hold}|${Number(node.canHold)}|${Number(node.b2b)}|${node.combo}|${node.lift}|${node.board.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(node);
    if (pool.length >= width * 4) break;
  }
  const chosen = new Set<T>();
  const roots = new Set<number>();
  const quota = Math.min(8, Math.floor(width / 6));
  for (const node of pool) {
    if (roots.size >= quota) break;
    if (roots.has(node.root)) continue;
    roots.add(node.root);
    chosen.add(node);
  }
  for (const node of pool) {
    if (chosen.size >= width) break;
    chosen.add(node);
  }
  return [...chosen].sort((a, b) => b.value - a.value);
}
