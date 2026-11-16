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
import { rulesProfile } from "../../core/profile.js";
import { awardLock, s2GarbageMultiplier } from "../../core/rules.js";
import { classifyS2Spin } from "../../core/s2-spin.js";
import type { TspinKind } from "../../core/tspin.js";
import { BOARD_FEATURES, type BoardFeatures, boardFeatures } from "./features.js";
import {
  type BitBoard,
  collides,
  FULL_ROW,
  generatePlacements,
  lockPlacement,
  type Placement,
  spawnPosition,
} from "./movegen.js";
import {
  assessSolvency,
  type SolvencyParams,
  solvencyMargin,
  solvencyStateFrom,
} from "./solvency.js";
import { type NodeState, rootState, type SearchInput } from "./state.js";
import { type StockParams, stockPotential, stockStateFrom } from "./stock.js";
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
  /**
   * Rules profile (src/core/profile.ts). Selects the full rules semantics, not
   * only the dedupe key: "guideline" (default) is the frozen Hoiko/TBP search;
   * "s2" is the TETR.IO S2 lab search (exact B2B chain, staged S2 awards and
   * frame multiplier, All-Mini+ spins, 180 rotations, materialized garbage with
   * carried pending, terminal death at row 21, full-provenance dedupe key).
   * The guideline-rig option `guideline` is ignored under "s2".
   */
  readonly profile?: SearchProfile;
  /** S2 only — C1 stock potential (canonical §C1). Absent or scale 0 = Φ ≡ 0. */
  readonly stock?: StockParams;
  /** S2 only — C2 solvency layer (canonical §C2). Absent or coefficient 0 = no penalty. */
  readonly solvency?: SolvencyParams;
  /**
   * S2 only — hard root solvency veto: the champion's choose_rescue as a pure
   * decision-stage filter over the ranked root lines (see search()).
   * Absent/false = no veto; the search values are never modified by it.
   */
  readonly rootVeto?: boolean;
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
  /** S2: terminal under the referee death rule (valued as a leaf, never expanded). */
  readonly dead: boolean;
  readonly depth: number;
  readonly step: Step | null;
  readonly parent: Node | null;
  readonly root: number;
}

/** S2-only parameters threaded through expandS2(). */
interface S2Context {
  readonly rootFrame: number;
  readonly stock: StockParams | undefined;
  readonly solvency: SolvencyParams | undefined;
}

export function search(input: SearchInput, options: SearchOptions): SearchResult | null {
  const { weights: w, width } = options;
  const profile = rulesProfile(options.profile ?? "guideline");
  const s2 = profile.id === "s2";
  const movegen = s2
    ? { spinEvidence: profile.spinEvidence, rotate180: profile.rotate180 }
    : undefined;
  const s2ctx: S2Context = {
    rootFrame: input.frame ?? 0,
    stock: options.stock,
    solvency: options.solvency,
  };
  const exposure = options.exposure ?? 0;
  const guideline = options.guideline ?? false;
  const expandChild = (
    node: Node,
    placement: Placement,
    option: PieceOption,
    rootPending: number,
    rootIndex: number,
  ): Node | null =>
    s2
      ? expandS2(node, placement, option, w, rootIndex, exposure, s2ctx)
      : expand(node, placement, option, rootPending, w, rootIndex, exposure, guideline);
  const sequence: PieceKind[] = [input.active.kind, ...input.preview];
  const rootFeatures = boardFeatures(input.board, 0);
  const root: Node = {
    state: rootState(input, rootFeatures, null),
    reward: 0,
    value: 0,
    dead: false,
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
                movegen,
              )) {
                const child = expandChild(node, placement, option, 0, 0);
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
        for (const placement of generatePlacements(node.state.board, option.kind, start, movegen)) {
          if (node.depth === 0 && input.acceptRoot && !input.acceptRoot(placement, option.usedHold))
            continue;
          const child = expandChild(node, placement, option, input.pending, firstMoves.length);
          nodes += 1;
          if (child === null) continue;
          if (node.depth === 0) firstMoves.push(child);
          // S2: dead lines are leaves — valued for the fallback/best-try choice
          // (and as root moves when every lock is fatal), never expanded. The
          // guideline expand returns null on death instead, so dead is never set.
          if (child.dead) finished.push(child);
          else children.push(child);
        }
      }
    }
    children.sort((a, b) => b.value - a.value);
    beam = options.diverse
      ? selectBeam(children, width, profile.dedupe)
      : dedupe(children, width, guideline, profile.dedupe);
    if (beam.length > 0) deepest = beam;
  }
  // Normal case: lines that used every known piece. If every line tops out first, fall
  // back to the deepest surviving positions so the bot still picks its best try.
  const leaves = finished.length > 0 ? finished : deepest;
  let bestLeaf: Node | null = null;
  // One pass over the leaves in their original order: the best leaf overall and,
  // per root, the best value (insertion order = first leaf seen per root, as in
  // both pre-port searches) and the leaf that attains it (for the S2 veto).
  const rootBest = new Map<number, number>();
  const bestLeafByRoot = new Map<number, Node>();
  for (const leaf of leaves) {
    if (leaf.depth === 0) continue;
    if (bestLeaf === null || leaf.value > bestLeaf.value) bestLeaf = leaf;
    const prev = rootBest.get(leaf.root);
    if (prev === undefined || leaf.value > prev) {
      rootBest.set(leaf.root, leaf.value);
      bestLeafByRoot.set(leaf.root, leaf);
    }
  }
  if (bestLeaf === null) return null;

  // S2 hard root solvency veto — the champion's choose_rescue, a pure
  // decision-stage filter over the ranked root lines. A root is insolvent
  // when its post-lock state cannot pay the pending margin, quantity-only:
  // margin = 20 − post-lock height − residual pending < 0 (the landed tank
  // is already inside the child's height; see solvencyMargin). If the
  // value-best root is insolvent and any other root is solvent, play the
  // FIRST solvent root in rank order (not the best-scoring solvent one —
  // the champion does not re-rank). If no root is solvent, the value-best
  // line stands: it is the least-bad try, and search still returns a move.
  // Search values are untouched, so veto-off is bit-identical.
  if (s2 && options.rootVeto) {
    const marginOf = (rootIndex: number): number => {
      const first = firstMoves[rootIndex];
      if (first === undefined) return Number.NEGATIVE_INFINITY;
      return solvencyMargin({
        maxHeight: boardFeatures(first.state.board, first.state.lift).maxHeight,
        pending: first.state.pending,
      });
    };
    if (marginOf(bestLeaf.root) < 0) {
      const ranked = [...rootBest.entries()].sort((a, b) => b[1] - a[1]);
      for (const [rootIndex] of ranked) {
        if (rootIndex === bestLeaf.root) continue;
        if (marginOf(rootIndex) >= 0) {
          bestLeaf = bestLeafByRoot.get(rootIndex) ?? bestLeaf;
          break;
        }
      }
    }
  }

  const line: Step[] = [];
  for (let n: Node | null = bestLeaf; n !== null && n.step !== null; n = n.parent)
    line.unshift(n.step);
  const first = firstMoves[bestLeaf.root] as Node;

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
  const value = accumulated + scale * w.discount * stateValue(features, b2bBool, w);

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
    dead: false,
    depth: node.depth + 1,
    step: { placement, usedHold: option.usedHold, linesCleared: lines, attack, reward },
    parent: node,
    root: node.depth === 0 ? rootIndex : node.root,
  };
}

/**
 * S2 expansion (rules profile "s2"): exact difficult-clear chain, staged S2
 * awards with the lock-frame margin multiplier, All-Mini+ spin classification,
 * garbage flags compacted with the clear, carried residual pending with landed
 * rows materialized into the child board, terminal death at the visible field
 * top (row 21), and the optional C1 Φ / C2 solvency terms in the terminal
 * bracket. Ported verbatim in behaviour from the former tools/s2-lab search.
 */
function expandS2(
  node: Node,
  placement: Placement,
  option: PieceOption,
  w: Weights,
  rootIndex: number,
  exposure: number,
  ctx: S2Context,
): Node {
  const s = node.state;
  // Staged S2 lock awards and All-Mini+; the exact chain is never reduced to a flag.
  const spin = classifyS2Spin(
    placement,
    (x, y) =>
      x < 0 || x >= 10 || y >= s.board.length || (y >= 0 && ((s.board[y] ?? 0) & (1 << x)) !== 0),
    (dx, dy) =>
      !collides(s.board, placement.kind, placement.rotation, placement.x + dx, placement.y + dy),
  );
  placement = { ...placement, tspin: spin };
  // Match lockPlacement's cell coordinates and bottom-to-top survivor collapse.
  const filled = s.board.slice();
  for (const cell of cellsFor(placement.kind, placement.rotation)) {
    const row = placement.y + cell.y;
    if (row >= 0 && row < filled.length)
      filled[row] = (filled[row] as number) | (1 << (placement.x + cell.x));
  }
  // Compact the surviving flags in the same direction lockPlacement collapses
  // the board (write cursor from the high-index end), so each flag stays on
  // its own board row after a clear.
  const garbageRows = new Uint8Array(s.board.length);
  let garbageCleared = 0;
  let write = s.board.length - 1;
  for (let read = filled.length - 1; read >= 0; read -= 1) {
    if (filled[read] === FULL_ROW) {
      garbageCleared += s.garbageRows?.[read] ?? 0;
    } else {
      garbageRows[write--] = s.garbageRows?.[read] ?? 0;
    }
  }
  const outcome = lockPlacement(s.board, placement);
  const lines = outcome.linesCleared;
  const combo = lines > 0 ? s.combo + 1 : -1;
  const multiplier = s2GarbageMultiplier(ctx.rootFrame + 60 * node.depth);
  const award = awardLock(
    "tetrio-s2",
    {
      lines,
      tspinLines: spin === "full" ? lines : 0,
      tspinKind: spin,
      combo,
      b2bActive: s.b2bChain > 0,
      perfectClear: outcome.perfectClear,
    },
    s.b2bChain,
    { multiplier, garbageCleared },
  );
  const attack = award.attack;
  const difficult = lines > 0 && (lines === 4 || spin !== "none" || outcome.perfectClear);
  const b2bChain = award.difficultChain;

  // Garbage: our attack cancels what is pending; the due remainder lands under
  // the stack on a non-clearing lock. The residual pending is carried into the
  // child: a clear blocks this lock's intake but does not erase the uncanceled
  // remainder, and a non-clearing lock lands only the due part. The lab runs
  // zero-frame garbage delay with instant entry, so past the root every
  // residual row is due at the next non-clearing lock.
  const pendingIn = s.pending;
  let pending = pendingIn;
  let landed = 0;
  if (lines > 0) {
    pending = Math.max(0, pendingIn - attack);
  } else {
    landed = Math.min(node.depth === 0 ? s.dueThisLock : pendingIn, pendingIn);
    pending = pendingIn - landed;
  }

  let reward = attack * w.attack;
  // Attack is paid pre-cancel; only excess converts to pressure. Priced at the
  // root only, against the referee's known pending figure.
  if (node.depth === 0) reward += w.conversion * Math.max(0, attack - pendingIn);
  const kind = clearKind(lines, placement.tspin, outcome.perfectClear);
  if (kind !== null) reward += w.clear[kind];
  if (s.b2bChain !== 0 && lines > 0 && !difficult && !outcome.perfectClear) reward += w.b2bBreak;
  if (placement.kind === "T" && placement.tspin === "none" && s.tSlot > 0) reward += w.wastedT;

  // Materialize the landed rows into the child board: in the referee they
  // tank under the stack before the next decision, so deeper placements plan
  // around real garbage rows, not a height scalar (child lift is therefore 0).
  // The hole column is the post-lock board's well — the amount-only interface
  // cannot know the referee's hole; one shared hole per tank.
  let board = outcome.board;
  let childGarbageRows = garbageRows;
  if (landed > 0) {
    const len = outcome.board.length;
    const mask = FULL_ROW ^ (1 << wellColumn(outcome.board));
    const shifted = new Uint16Array(len);
    const shiftedFlags = new Uint8Array(len);
    for (let row = 0; row < len; row += 1) {
      const source = row + landed;
      shifted[row] = source < len ? (outcome.board[source] as number) : mask;
      shiftedFlags[row] = source < len ? (garbageRows[source] as number) : 1;
    }
    board = shifted;
    childGarbageRows = shiftedFlags;
  }
  const features = boardFeatures(board, 0);
  // Referee death rule (occupied-buffer): any occupied cell above the visible
  // 20-row field after the lock is a loss. Death is TERMINAL, not null: the
  // node is valued and kept as a leaf but never expanded, so search still
  // returns a move when every root lock is fatal.
  const dead = features.maxHeight >= Math.min(s.board.length, 21);
  const scale = w.discount ** node.depth;
  const accumulated = node.reward + scale * (reward - exposure * features.danger);

  const childState: NodeState = {
    board,
    garbageRows: childGarbageRows,
    hold: option.hold,
    canHold: true,
    next: option.next,
    b2bChain,
    b2bActive: b2bChain > 0,
    combo,
    pending,
    lift: 0,
    dueThisLock: 0,
    bagRemaining: null,
    tSlot: features.tSlot,
  };

  // C1: the stock potential is a terminal estimate inside the same discounted
  // bracket as the board evaluation. Skipped when absent or scaled to 0.
  const phi =
    ctx.stock !== undefined && ctx.stock.scale !== 0
      ? stockPotential(
          stockStateFrom(childState, features, multiplier),
          ctx.stock,
          w.attack,
          w.discount,
        )
      : 0;
  // C2: the solvency penalty shares the terminal bracket, so survival is priced
  // at every beam layer. Skipped when absent or coefficient 0.
  const risk =
    ctx.solvency !== undefined && ctx.solvency.coefficient !== 0
      ? assessSolvency(solvencyStateFrom(childState, features), ctx.solvency).penalty
      : 0;
  const value = accumulated + scale * w.discount * (dot(features, w) + phi - risk);

  return {
    state: childState,
    reward: accumulated,
    value,
    dead,
    depth: node.depth + 1,
    step: { placement, usedHold: option.usedHold, linesCleared: lines, attack, reward },
    parent: node,
    root: node.depth === 0 ? rootIndex : node.root,
  };
}

/** Column with the lowest stack (the board's well), in board coordinates. */
function wellColumn(board: BitBoard): number {
  let well = 0;
  let lowest = Number.POSITIVE_INFINITY;
  for (let x = 0; x < 10; x += 1) {
    let height = 0;
    for (let row = 0; row < board.length; row += 1) {
      if (((board[row] as number) & (1 << x)) !== 0) {
        height = board.length - row;
        break;
      }
    }
    if (height < lowest) {
      lowest = height;
      well = x;
    }
  }
  return well;
}

function dot(features: BoardFeatures, w: Weights): number {
  let total = 0;
  for (const name of BOARD_FEATURES) total += features[name] * w.board[name];
  return total;
}

/**
 * Terminal state value of a guideline node: the weighted board shape plus the adopt
 * state terms. Every adopt term is skipped when its weight is 0 or absent, so with
 * defaults this is exactly `dot(features, w)` (bit-identical). The S2 path (expandS2)
 * keeps its own bracket (dot + Φ − risk) and does not read the adopt terms.
 */
function stateValue(features: BoardFeatures, b2b: boolean, w: Weights): number {
  let total = dot(features, w);
  const b2bState = w.b2bState ?? 0;
  if (b2bState !== 0 && b2b) total += b2bState;
  return total;
}

function weighBoard(features: BoardFeatures, w: Weights): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of BOARD_FEATURES) out[name] = features[name] * w.board[name];
  return out;
}

/**
 * Node shape that dedupe/selectBeam can read: either direct fields (for tests)
 * or via a state property (for internal Nodes). Field-shaped nodes default to
 * pending 0 and garbageRows null; their `b2b` boolean stands in for the chain.
 */
type DedupeableFields = {
  board: BitBoard;
  next: number;
  hold: PieceKind | null;
  canHold: boolean;
  b2b: boolean;
  combo: number;
  lift: number;
  pending?: number;
  garbageRows?: Uint8Array | readonly number[] | null;
};
type DedupeableViaState = {
  state: NodeState;
};
type Dedupeable = DedupeableFields | DedupeableViaState;

/** The key-relevant fields of a node, read uniformly from either shape. */
interface KeyFields {
  readonly board: BitBoard;
  readonly next: number;
  readonly hold: PieceKind | null;
  readonly canHold: boolean;
  readonly b2bActive: boolean;
  /** Exact chain (state nodes); field-shaped nodes map b2b to 0/1. */
  readonly b2bChain: number;
  readonly combo: number;
  readonly lift: number;
  readonly pending: number;
  readonly garbageRows: Uint8Array | readonly number[] | null;
}

function keyFields(node: Dedupeable): KeyFields {
  if ("state" in node) {
    const s = node.state;
    return {
      board: s.board,
      next: s.next,
      hold: s.hold,
      canHold: s.canHold,
      b2bActive: s.b2bActive,
      b2bChain: s.b2bChain,
      combo: s.combo,
      lift: s.lift,
      pending: s.pending,
      garbageRows: s.garbageRows,
    };
  }
  return {
    board: node.board,
    next: node.next,
    hold: node.hold,
    canHold: node.canHold,
    b2bActive: node.b2b,
    b2bChain: node.b2b ? 1 : 0,
    combo: node.combo,
    lift: node.lift,
    pending: node.pending ?? 0,
    garbageRows: node.garbageRows ?? null,
  };
}

function flagsKey(rows: Uint8Array | readonly number[] | null): string {
  return rows === null ? "" : rows.join(",");
}

/**
 * Keep the best `width` children, dropping later copies of an identical position.
 *
 * Under the guideline profile (`profile = "guideline"`, default), the legacy key
 * (`next|hold|b2b|board`) is preserved so the frozen guideline/Hoiko record is unchanged.
 * Under the S2 profile (`profile = "s2"`), the key is exactly the production S2 lab key:
 * queue index, hold, exact B2B chain, combo, lift, residual pending, garbage flags and
 * board. It has no hold-availability segment (expanded children always have canHold
 * true) and never folds combo — the `guideline` flag is ignored under S2.
 */
export function dedupe<T extends Dedupeable>(
  sorted: readonly T[],
  width: number,
  _guideline = false,
  profile: SearchProfile = "guideline",
): T[] {
  const kept: T[] = [];
  const seen = new Set<string>();
  for (const node of sorted) {
    if (kept.length >= width) break;
    const f = keyFields(node);
    const key =
      profile === "s2"
        ? `${f.next}|${f.hold}|${f.b2bChain}|${f.combo}|${f.lift}|${f.pending}|${flagsKey(f.garbageRows)}|${f.board.join(",")}`
        : `${f.next}|${f.hold}|${f.b2bActive ? 1 : 0}|${f.board.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(node);
  }
  return kept;
}

/**
 * Keep distinct attack economies and reserve a bounded set of first moves.
 *
 * The pool key carries hold availability, B2B, combo, lift, residual pending and
 * garbage flags. Under "s2" the B2B segment is the exact chain (the lab key);
 * under "guideline" it is the 0/1 flag, and the pending/flags segments are
 * constant (guideline children carry pending 0 and no flags), so the guideline
 * pool is unchanged.
 */
export function selectBeam<T extends Dedupeable & { root: number; value: number }>(
  sorted: readonly T[],
  width: number,
  profile: SearchProfile = "guideline",
): T[] {
  if (width <= 0) return [];
  const pool: T[] = [];
  const seen = new Set<string>();
  for (const node of sorted) {
    const f = keyFields(node);
    const b2b = profile === "s2" ? f.b2bChain : Number(f.b2bActive);
    const key = `${f.next}|${f.hold}|${Number(f.canHold)}|${b2b}|${f.combo}|${f.lift}|${f.pending}|${flagsKey(f.garbageRows)}|${f.board.join(",")}`;
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
