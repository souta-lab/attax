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
import { type StockParams, stockPotential } from "./stock.js";

export interface SearchInput {
  readonly board: BitBoard;
  /** Logical referee frame at the root decision (lockTime). */
  readonly frame?: number;
  /** Garbage flags aligned with board row indices (same index space as board). */
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
  /** C1 stock potential (canonical §C1). Absent or scale 0 = Φ ≡ 0. */
  readonly stock?: StockParams;
}

/** Optional mechanism layers threaded through expand(). All S2-only. */
interface Mechanisms {
  readonly stock?: StockParams;
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
  /** Residual incoming garbage not yet landed or cancelled. */
  readonly pending: number;
  /** Referee-given rows due on the root lock (deeper locks: see expand). */
  readonly dueThisLock: number;
  /** Unmaterialized landed rows; landed garbage is inserted into the board
   * itself (see expand), so this is 0 in the S2 search. */
  readonly lift: number;
  readonly tSlot: number;
  readonly reward: number;
  readonly value: number;
  /** Terminal under the referee death rule: valued as a leaf, never expanded. */
  readonly dead: boolean;
  readonly depth: number;
  readonly step: Step | null;
  readonly parent: Node | null;
  readonly root: number;
}

export function search(input: SearchInput, options: SearchOptions): SearchResult | null {
  const { weights: w, width } = options;
  const mech: Mechanisms = { stock: options.stock };
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
    pending: input.pending,
    dueThisLock: input.dueThisLock,
    lift: 0,
    tSlot: rootFeatures.tSlot,
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
                node.board,
                option.kind,
                spawnPosition(option.kind, node.board.length),
                { spinEvidence: true, rotate180: true },
              )) {
                const child = expand(
                  node,
                  placement,
                  option,
                  w,
                  0,
                  options.exposure ?? 0,
                  input.frame ?? 0,
                  mech,
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
        for (const placement of generatePlacements(node.board, option.kind, start, {
          spinEvidence: true,
          rotate180: true,
        })) {
          if (node.depth === 0 && input.acceptRoot && !input.acceptRoot(placement, option.usedHold))
            continue;
          const child = expand(
            node,
            placement,
            option,
            w,
            firstMoves.length,
            options.exposure ?? 0,
            input.frame ?? 0,
            mech,
          );
          nodes += 1;
          if (child === null) continue;
          if (node.depth === 0) firstMoves.push(child);
          // Dead lines are leaves: valued for the fallback/best-try choice
          // (and as root moves when every lock is fatal), never expanded.
          if (child.dead) finished.push(child);
          else children.push(child);
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
  w: Weights,
  rootIndex: number,
  exposure: number,
  rootFrame: number,
  mech: Mechanisms,
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
  // Compact the surviving flags in the same direction lockPlacement collapses
  // the board (write cursor from the high-index end), so each flag stays on
  // its own board row after a clear.
  const garbageRows = new Uint8Array(node.board.length);
  let garbageCleared = 0;
  let write = node.board.length - 1;
  for (let read = filled.length - 1; read >= 0; read -= 1) {
    if (filled[read] === FULL_ROW) {
      garbageCleared += node.garbageRows[read] ?? 0;
    } else {
      garbageRows[write--] = node.garbageRows[read] ?? 0;
    }
  }
  const outcome = lockPlacement(node.board, placement);
  const lines = outcome.linesCleared;
  const combo = lines > 0 ? node.combo + 1 : -1;
  const multiplier = s2GarbageMultiplier(rootFrame + 60 * node.depth);
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
    { multiplier, garbageCleared },
  );
  const attack = award.attack;
  const difficult = lines > 0 && (lines === 4 || spin !== "none" || outcome.perfectClear);
  const b2b = award.difficultChain;

  // Garbage: our attack cancels what is pending; the due remainder lands under
  // the stack on a non-clearing lock. The residual pending is carried into the
  // child: a clear blocks this lock's intake but does not erase the uncanceled
  // remainder, and a non-clearing lock lands only the due part. The lab runs
  // zero-frame garbage delay with instant entry, so past the root every
  // residual row is due at the next non-clearing lock.
  const pendingIn = node.pending;
  let pending = pendingIn;
  let landed = 0;
  if (lines > 0) {
    pending = Math.max(0, pendingIn - attack);
  } else {
    landed = Math.min(node.depth === 0 ? node.dueThisLock : pendingIn, pendingIn);
    pending = pendingIn - landed;
  }

  let reward = attack * w.attack;
  // Attack is paid pre-cancel; only excess converts to pressure. Priced at the
  // root only, against the referee's known pending figure.
  if (node.depth === 0) reward += w.conversion * Math.max(0, attack - pendingIn);
  const kind = clearKind(lines, placement.tspin, outcome.perfectClear);
  if (kind !== null) reward += w.clear[kind];
  if (node.b2b && lines > 0 && !difficult && !outcome.perfectClear) reward += w.b2bBreak;
  if (placement.kind === "T" && placement.tspin === "none" && node.tSlot > 0) reward += w.wastedT;

  // Materialize the landed rows into the child board: in the referee they
  // tank under the stack before the next decision, so deeper placements must
  // plan around real garbage rows, not a height scalar (the child lift is
  // therefore 0; the field stays for key/breakdown compatibility). The hole
  // column is the post-lock board's well — the amount-only interface cannot
  // know the referee's hole, and one shared hole per tank matches the lab's
  // one-cell-hole model.
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
  // Referee death rule (occupied-buffer): a post-lock state with any occupied
  // cell above the visible 20-row field is already a loss (run-match.mjs,
  // "occupied-buffer-lab-placement-rule"), however much buffer remains above
  // it. Death is TERMINAL, not null: the node is valued and kept as a leaf
  // but never expanded (the game is over). Returning null instead made the
  // search report "no move" in states where every root lock is fatal -
  // under heavy due garbage that is most losing endgames - while the
  // referee still requires a submitted placement and records a normal
  // top-out. This also disposes of buffer-locking placements (movegen
  // generates them at every depth): they can only ever be terminal leaves.
  const deathLimit = Math.min(node.board.length, 21);
  const dead = features.maxHeight >= deathLimit;
  const scale = w.discount ** node.depth;
  const accumulated = node.reward + scale * (reward - exposure * features.danger);
  // C1: the stock potential is part of this node's terminal estimate, inside
  // the same discounted bracket as the board evaluation (canonical §C1).
  // Skipped entirely when absent or scaled to 0, so Φ ≡ 0 is bit-identical.
  const phi =
    mech.stock !== undefined && mech.stock.scale !== 0
      ? stockPotential(
          {
            chain: b2b,
            combo,
            pending,
            maxHeight: features.maxHeight,
            tSlot: features.tSlot,
            wellDepth: features.wellDepth,
            multiplier,
          },
          mech.stock,
          w.attack,
          w.discount,
        )
      : 0;
  const value = accumulated + scale * w.discount * (dot(features, w) + phi);

  return {
    board,
    garbageRows: childGarbageRows,
    hold: option.hold,
    next: option.next,
    canHold: true,
    b2b,
    combo,
    pending,
    dueThisLock: 0,
    lift: 0,
    tSlot: features.tSlot,
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
    const key = `${node.next}|${node.hold}|${node.b2b}|${node.combo}|${node.lift}|${node.pending}|${node.garbageRows.join(",")}|${node.board.join(",")}`;
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
    pending: number;
    garbageRows: Uint8Array;
    root: number;
    value: number;
  },
>(sorted: readonly T[], width: number): T[] {
  if (width <= 0) return [];
  const pool: T[] = [];
  const seen = new Set<string>();
  for (const node of sorted) {
    const key = `${node.next}|${node.hold}|${Number(node.canHold)}|${Number(node.b2b)}|${node.combo}|${node.lift}|${node.pending}|${node.garbageRows.join(",")}|${node.board.join(",")}`;
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
