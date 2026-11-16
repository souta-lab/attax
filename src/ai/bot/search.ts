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
import { type NodeState, rootState, type SearchInput } from "./state.js";
import type { ClearKind, Weights } from "./weights.js";

export type { SearchInput } from "./state.js";

export type SearchProfile = "guideline" | "s2";

export interface SearchOptions {
  readonly weights: Weights;
  readonly width: number;
  /** Preserve roots and attack-economy states in competition search. */
  readonly diverse?: boolean;
  /** Cost per squared exposed row on every intermediate board. */
  readonly exposure?: number;
  /** External guideline rig: no combo/PC attack; lock-out above row 20. */
  readonly guideline?: boolean;
  /** Dedupe rules profile: "guideline" preserves the frozen Hoiko/TBP key; "s2" keeps full provenance. */
  readonly profile?: SearchProfile;
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
  /** The single per-node state record (board, hold, queue index, b2b, combo, lift, etc.). */
  readonly state: NodeState;
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
    state: rootState(input, rootFeatures, null),
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
                node.state.board,
                option.kind,
                spawnPosition(option.kind, node.state.board.length),
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
            : option.usedHold && node.state.hold !== null
              ? {
                  rotation: 0,
                  x: 3,
                  y: node.state.board.length > 20 ? node.state.board.length - 21 : 0,
                }
              : spawnPosition(option.kind, node.state.board.length);
        for (const placement of generatePlacements(node.state.board, option.kind, start)) {
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
      : dedupe(children, width, options.guideline ?? false, options.profile ?? "guideline");
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
    breakdown: weighBoard(boardFeatures(first.state.board, first.state.lift), w),
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
  const s = node.state;
  const current = sequence[s.next];
  if (current === undefined) return [];
  const options: PieceOption[] = [
    { kind: current, usedHold: false, next: s.next + 1, hold: s.hold },
  ];
  if (!s.canHold) return options;
  if (s.hold === null) {
    const after = sequence[s.next + 1];
    if (after !== undefined && after !== current) {
      options.push({ kind: after, usedHold: true, next: s.next + 2, hold: current });
    }
  } else if (s.hold !== current) {
    options.push({ kind: s.hold, usedHold: true, next: s.next + 1, hold: current });
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
  const s = node.state;
  if (
    guideline &&
    s.board.length > 20 &&
    cellsFor(placement.kind, placement.rotation).every(
      (cell) => placement.y + cell.y < s.board.length - 20,
    )
  )
    return null;
  const outcome = lockPlacement(s.board, placement);
  const lines = outcome.linesCleared;
  const combo = lines > 0 ? s.combo + 1 : -1;
  const attack = attackForClear({
    lines,
    tspinLines: placement.tspin === "full" ? lines : 0,
    combo: guideline ? -1 : combo,
    b2bActive: s.b2bActive,
    perfectClear: !guideline && outcome.perfectClear,
    tspinKind: placement.tspin,
  });
  const difficult = isDifficultClear(lines, placement.tspin);
  // Compute the boolean b2b outcome as before, then store as 0 or 1 in b2bChain.
  const b2bBool = lines === 0 ? s.b2bActive : outcome.perfectClear ? lines >= 4 : difficult;
  const b2bChain = b2bBool ? 1 : 0;

  // Garbage: our attack cancels what is pending; the rest lands under the stack on this
  // lock (garbage delay 1). Only the root's pending garbage is known.
  const pending = node.depth === 0 ? rootPending : 0;
  const lift = s.lift + Math.max(0, pending - attack);

  let reward = attack * w.attack;
  const kind = clearKind(lines, placement.tspin, !guideline && outcome.perfectClear);
  if (kind !== null) reward += w.clear[kind];
  if (s.b2bActive && lines > 0 && !difficult && !outcome.perfectClear) reward += w.b2bBreak;
  if (placement.kind === "T" && placement.tspin === "none" && s.tSlot > 0) reward += w.wastedT;

  const features = boardFeatures(outcome.board, lift);
  if (features.maxHeight >= s.board.length) return null;
  const scale = w.discount ** node.depth;
  const accumulated = node.reward + scale * (reward - exposure * features.danger);
  const value = accumulated + scale * w.discount * dot(features, w);

  const childState: NodeState = {
    board: outcome.board,
    garbageRows: null,
    hold: option.hold,
    canHold: true,
    next: option.next,
    b2bChain,
    b2bActive: b2bBool,
    combo,
    pending: 0,
    lift,
    dueThisLock: 0,
    bagRemaining: null,
    tSlot: features.tSlot,
  };

  return {
    state: childState,
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
 * Node shape that dedupe/selectBeam can read: either direct fields (for tests)
 * or via a state property (for internal Nodes).
 */
type DedupeableFields = {
  board: BitBoard;
  next: number;
  hold: PieceKind | null;
  canHold: boolean;
  b2b: boolean;
  combo: number;
  lift: number;
};
type DedupeableViaState = {
  state: NodeState;
};
type Dedupeable = DedupeableFields | DedupeableViaState;

function dedupeField<K extends keyof DedupeableFields>(
  node: Dedupeable,
  key: K,
): DedupeableFields[K] {
  if ("state" in node) {
    if (key === "b2b") return node.state.b2bActive as DedupeableFields[K];
    return node.state[key as keyof NodeState] as DedupeableFields[K];
  }
  return node[key];
}

/**
 * Keep the best `width` children, dropping later copies of an identical position.
 *
 * Under the guideline profile (`profile = "guideline"`, default), the legacy key
 * (`next|hold|b2b|board`) is preserved so the frozen guideline/Hoiko record is unchanged.
 * Under the S2 profile (`profile = "s2"`), two nodes match only if every piece of state
 * the search reads later matches: board, queue index, hold, hold availability, B2B, combo
 * (folded to -1 under the guideline rig) and lift.
 */
export function dedupe<T extends Dedupeable>(
  sorted: readonly T[],
  width: number,
  guideline = false,
  profile: SearchProfile = "guideline",
): T[] {
  const kept: T[] = [];
  const seen = new Set<string>();
  for (const node of sorted) {
    if (kept.length >= width) break;
    const board = dedupeField(node, "board");
    const next = dedupeField(node, "next");
    const hold = dedupeField(node, "hold");
    const canHold = dedupeField(node, "canHold");
    const b2b = dedupeField(node, "b2b");
    const combo = guideline ? -1 : dedupeField(node, "combo");
    const lift = dedupeField(node, "lift");
    const key =
      profile === "s2"
        ? `${next}|${hold}|${Number(canHold)}|${Number(b2b)}|${combo}|${lift}|${board.join(",")}`
        : `${next}|${hold}|${b2b ? 1 : 0}|${board.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(node);
  }
  return kept;
}

/** Keep distinct attack economies and reserve a bounded set of first moves. */
export function selectBeam<T extends Dedupeable & { root: number; value: number }>(
  sorted: readonly T[],
  width: number,
): T[] {
  if (width <= 0) return [];
  const pool: T[] = [];
  const seen = new Set<string>();
  for (const node of sorted) {
    const board = dedupeField(node, "board");
    const next = dedupeField(node, "next");
    const hold = dedupeField(node, "hold");
    const canHold = dedupeField(node, "canHold");
    const b2b = dedupeField(node, "b2b");
    const combo = dedupeField(node, "combo");
    const lift = dedupeField(node, "lift");
    const key = `${next}|${hold}|${Number(canHold)}|${Number(b2b)}|${combo}|${lift}|${board.join(",")}`;
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
