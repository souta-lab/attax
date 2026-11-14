/**
 * Beam search over the known piece queue.
 *
 * Every node is a board after some placements. A node's value is the (discounted) sum of
 * the rewards of the placements that led to it plus the weighted shape of its board. Each
 * ply expands every surviving node with every reachable placement of the current piece
 * (and of the hold piece), then keeps the best `width` children. The move played is the
 * first placement on the line that ends at the best leaf.
 */
import { attackForClear, isDifficultClear } from "../../core/garbage.js";
import { cellsFor, type PieceKind } from "../../core/pieces.js";
import type { TspinKind } from "../../core/tspin.js";
import { BOARD_FEATURES, type BoardFeatures, boardFeatures } from "./features.js";
import {
  type BitBoard,
  generatePlacements,
  lockPlacement,
  type Placement,
  spawnPosition,
} from "./movegen.js";
import type { ClearKind, Weights } from "./weights.js";

export interface SearchInput {
  readonly board: BitBoard;
  readonly active: { kind: PieceKind; rotation: number; x: number; y: number };
  readonly hold: PieceKind | null;
  readonly canHold: boolean;
  /** Upcoming pieces after the active one (the visible preview). */
  readonly preview: readonly PieceKind[];
  readonly b2b: boolean;
  /** Engine combo counter: -1 = no chain, 0 = first clear of a chain, ... */
  readonly combo: number;
  /** Incoming garbage rows not yet on the board. */
  readonly pending: number;
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
  /** External guideline rig: no combo/PC attack; lock-out above row 20. */
  readonly guideline?: boolean;
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
  readonly hold: PieceKind | null;
  /** Index into the piece sequence of the piece to place next. */
  readonly next: number;
  readonly canHold: boolean;
  readonly b2b: boolean;
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
                  options.guideline ?? false,
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
          const child = expand(
            node,
            placement,
            option,
            input.pending,
            w,
            firstMoves.length,
            options.exposure ?? 0,
            options.guideline ?? false,
          );
          nodes += 1;
          if (child === null) continue;
          if (node.depth === 0) firstMoves.push(child);
          children.push(child);
        }
      }
    }
    children.sort((a, b) => b.value - a.value);
    beam = options.diverse
      ? selectBeam(children, width)
      : dedupe(children, width, options.guideline ?? false);
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
  guideline: boolean,
): Node | null {
  if (
    guideline &&
    node.board.length > 20 &&
    cellsFor(placement.kind, placement.rotation).every(
      (cell) => placement.y + cell.y < node.board.length - 20,
    )
  )
    return null;
  const outcome = lockPlacement(node.board, placement);
  const lines = outcome.linesCleared;
  const combo = lines > 0 ? node.combo + 1 : -1;
  const attack = attackForClear({
    lines,
    tspinLines: placement.tspin === "full" ? lines : 0,
    combo: guideline ? -1 : combo,
    b2bActive: node.b2b,
    perfectClear: !guideline && outcome.perfectClear,
    tspinKind: placement.tspin,
  });
  const difficult = isDifficultClear(lines, placement.tspin);
  const b2b = lines === 0 ? node.b2b : outcome.perfectClear ? lines >= 4 : difficult;

  // Garbage: our attack cancels what is pending; the rest lands under the stack on this
  // lock (garbage delay 1). Only the root's pending garbage is known.
  const pending = node.depth === 0 ? rootPending : 0;
  const lift = node.lift + Math.max(0, pending - attack);

  let reward = attack * w.attack;
  const kind = clearKind(lines, placement.tspin, !guideline && outcome.perfectClear);
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

/**
 * Keep the best `width` children, dropping later copies of an identical position.
 *
 * Two nodes are the same position only if every piece of state the search reads later
 * matches: board, queue index, hold, hold availability, B2B, combo (it feeds attack) and
 * lift (it feeds the height/danger features and the top-out test). Under the guideline rig
 * combo never reaches attack (see `expand`), so it is folded to -1 there.
 */
export function dedupe<
  T extends {
    board: BitBoard;
    next: number;
    hold: PieceKind | null;
    canHold: boolean;
    b2b: boolean;
    combo: number;
    lift: number;
  },
>(sorted: readonly T[], width: number, guideline = false): T[] {
  const kept: T[] = [];
  const seen = new Set<string>();
  for (const node of sorted) {
    if (kept.length >= width) break;
    const combo = guideline ? -1 : node.combo;
    const key = `${node.next}|${node.hold}|${Number(node.canHold)}|${Number(node.b2b)}|${combo}|${node.lift}|${node.board.join(",")}`;
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
    b2b: boolean;
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
