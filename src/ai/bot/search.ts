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
import type { PieceKind } from "../../core/pieces.js";
import type { TspinKind } from "../../core/tspin.js";
import { BOARD_FEATURES, type BoardFeatures, boardFeatures } from "./features.js";
import {
  type BitBoard,
  generatePlacements,
  lockPlacement,
  type Placement,
  ROWS,
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
}

export interface SearchOptions {
  readonly weights: Weights;
  readonly width: number;
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
  /** Garbage arrives before the next decision, and its hole is not yet known. */
  readonly uncertainGarbage: boolean;
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
    uncertainGarbage: false,
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
      // The engine inserts uncancelled garbage immediately after this lock. Its hole
      // position is hidden until it lands, so searching further on the old board
      // would reward placements that cannot actually be played.
      if (node.uncertainGarbage) {
        finished.push(node);
        continue;
      }
      const options = pieceOptions(node, sequence);
      // Out of known pieces: the line ends here. (A node whose piece has no legal
      // placement is a top-out and simply produces no children.)
      if (options.length === 0) finished.push(node);
      for (const option of options) {
        const start =
          node.depth === 0 && !option.usedHold
            ? input.active
            : option.usedHold && node.hold !== null
              ? { rotation: 0, x: 3, y: 0 }
              : spawnPosition(option.kind);
        for (const placement of generatePlacements(node.board, option.kind, start)) {
          const child = expand(node, placement, option, input.pending, w, firstMoves.length);
          nodes += 1;
          if (child === null) continue;
          if (node.depth === 0) firstMoves.push(child);
          children.push(child);
        }
      }
    }
    children.sort((a, b) => b.value - a.value);
    beam = selectBeam(children, width);
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
): Node | null {
  const outcome = lockPlacement(node.board, placement);
  const lines = outcome.linesCleared;
  const combo = lines > 0 ? node.combo + 1 : -1;
  const attack = attackForClear({
    lines,
    tspinLines: placement.tspin === "full" ? lines : 0,
    combo,
    b2bActive: node.b2b,
    perfectClear: outcome.perfectClear,
    tspinKind: placement.tspin,
  });
  const difficult = isDifficultClear(lines, placement.tspin);
  const b2b = lines === 0 ? node.b2b : outcome.perfectClear ? lines >= 4 : difficult;

  // Garbage: our attack cancels what is pending; the rest lands under the stack on this
  // lock (garbage delay 1). Only the root's pending garbage is known.
  const pending = node.depth === 0 ? rootPending : 0;
  const lift = node.lift + Math.max(0, pending - attack);

  let reward = attack * w.attack;
  const kind = clearKind(lines, placement.tspin, outcome.perfectClear);
  if (kind !== null) reward += w.clear[kind];
  if (node.b2b && lines > 0 && !difficult && !outcome.perfectClear) reward += w.b2bBreak;
  if (placement.kind === "T" && placement.tspin === "none" && node.tSlot > 0) reward += w.wastedT;

  const features = boardFeatures(outcome.board, lift);
  if (features.maxHeight >= ROWS) return null;
  const scale = w.discount ** node.depth;
  const accumulated = node.reward + scale * reward;
  const value = accumulated + scale * w.discount * dot(features, w);

  return {
    board: outcome.board,
    hold: option.hold,
    next: option.next,
    canHold: true,
    b2b,
    combo,
    lift,
    uncertainGarbage: node.depth === 0 && lift > 0,
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
 * Fields that determine the legal continuations and attack economy of a beam state.
 * Combo and garbage must participate in deduplication: the same board with a different
 * combo or incoming stack can produce a different attack and survival outcome.
 */
export interface BeamState {
  readonly board: BitBoard;
  readonly hold: PieceKind | null;
  readonly next: number;
  readonly canHold: boolean;
  readonly b2b: boolean;
  readonly combo: number;
  readonly lift: number;
  readonly root: number;
  readonly value: number;
}

/**
 * Keep the strongest continuations while reserving a small fraction of the beam for
 * distinct first moves. This reduces the risk that one optimistic line monopolises
 * the entire search before its alternatives can develop.
 *
 * Input must be ordered best-first. The candidate pool is bounded for predictable cost.
 */
export function selectBeam<T extends BeamState>(sorted: readonly T[], width: number): T[] {
  if (width <= 0) return [];
  const pool: T[] = [];
  const seen = new Set<string>();
  const poolLimit = width * 4;
  for (const node of sorted) {
    if (pool.length >= poolLimit) break;
    const key = `${node.next}|${node.hold ?? "-"}|${Number(node.canHold)}|${Number(node.b2b)}|${node.combo}|${node.lift}|${node.board.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(node);
  }
  if (pool.length <= width) return pool;

  // At width 48, protect up to eight different first placements. Every other slot
  // remains available to the globally highest-scoring continuations.
  const rootQuota = Math.min(8, Math.max(1, Math.floor(width / 6)));
  const chosen: T[] = [];
  const roots = new Set<number>();
  const included = new Set<T>();
  for (const node of pool) {
    if (roots.size >= rootQuota) break;
    if (roots.has(node.root)) continue;
    roots.add(node.root);
    chosen.push(node);
    included.add(node);
  }
  for (const node of pool) {
    if (chosen.length >= width) break;
    if (included.has(node)) continue;
    chosen.push(node);
  }
  chosen.sort((a, b) => b.value - a.value);
  return chosen;
}
