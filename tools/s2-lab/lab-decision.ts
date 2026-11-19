/**
 * The lab's public decision shape, its projection onto the search input,
 * the referee witness keys, and the adapter that lets run-match drive the
 * GPU decider through the lab's decision interface.
 *
 * PublicDecision / projectAttax / cellKey / placementCells are moved
 * verbatim from attax-player.ts in Phase C (2026-11-19): that module wired
 * the TS and Rust engines and was removed with them. The projection itself
 * is engine-independent — it is the one place a referee-visible state
 * becomes a search input — so it lives here now, feeding the only engine
 * left (the GPU driver, gpu-player.ts).
 */
import { cellsFor, type PieceKind } from "../../src/core/pieces.js";
import type { Placement } from "./board.js";
import { spawnPosition } from "./board.js";
import type { GpuDecider } from "./gpu-player.js";
import { type SearchInput, toSharedInput } from "./s2-input.js";
import type { SearchResult } from "./search-types.js";

export interface PublicDecision {
  lockTime?: { logicalFrame: number };
  board: { width: number; height: number; cells: string };
  pieces: {
    current: PieceKind;
    known: PieceKind[];
    hold: PieceKind | null;
    holdAvailable: boolean;
  };
  chain: { combo: number; b2b: number };
  incoming: { pendingRows: number; dueThisLockRows: number };
}

/** Only the lab's allowlisted, queue-truncated public decision crosses this boundary. */
export function projectAttax(decision: PublicDecision): SearchInput {
  const { board, pieces, chain, incoming } = decision;
  if (board.width !== 10 || board.height !== 40 || board.cells.length !== 400) {
    throw new Error("attax requires an exact 10x40 board");
  }
  if (pieces.known.length > 13) throw new Error("attax public queue exceeds 14 including current");
  if (
    ![chain.combo, chain.b2b, incoming.pendingRows, incoming.dueThisLockRows].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    incoming.dueThisLockRows > incoming.pendingRows
  ) {
    throw new Error("invalid public chain/incoming counters");
  }
  const rows = new Uint16Array(40);
  const garbageRows = Array<number>(40).fill(0);
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 10; x++) {
      if (board.cells[y * 10 + x] === "G") garbageRows[39 - y] = 1;
      if (board.cells[y * 10 + x] !== "_") rows[39 - y] |= 1 << x;
    }
  }
  return {
    board: rows,
    frame: decision.lockTime?.logicalFrame,
    garbageRows,
    active: { kind: pieces.current, ...spawnPosition(pieces.current, 40) },
    hold: pieces.hold,
    canHold: pieces.holdAvailable,
    preview: [...pieces.known],
    b2b: chain.b2b,
    combo: chain.combo - 1,
    pending: incoming.pendingRows,
    dueThisLock: incoming.dueThisLockRows,
    speculativePieces: [],
  };
}

/** Cell matching derives all origin/rotation offsets from the referee's geometry. */
export function placementCells(p: Pick<Placement, "kind" | "rotation" | "x" | "y">) {
  return cellsFor(p.kind, p.rotation).map((c) => [p.x + c.x, 39 - p.y - c.y]);
}

export function cellKey(cells: readonly (readonly number[])[]) {
  return cells
    .map(([x, y]) => `${x},${y}`)
    .sort()
    .join(";");
}

/** The decision interface run-match drives (the former attax-player decider shape). */
export interface LabDecider {
  decideAsync(
    decision: PublicDecision,
    acceptRoot?: SearchInput["acceptRoot"],
  ): Promise<SearchResult | null>;
  close(): void;
}

/**
 * Adapt a GPU decider to the lab interface: project the public decision,
 * attach the referee's root witness, and hand the shared input to the GPU
 * engine. acceptRoot reaches the GPU decider as a post-filter over the
 * result block's root candidates (gpu-player.ts) — the wire format cannot
 * carry witness keys, so this is not bit-identical to in-search filtering
 * in general; that approximation is recorded in the match record's design
 * notes (GPU-LAB-DRIVER §5.3).
 */
export function wrapGpuDecider(decider: GpuDecider): LabDecider {
  return {
    async decideAsync(decision, acceptRoot) {
      const shared = toSharedInput({
        ...projectAttax(decision),
        ...(acceptRoot ? { acceptRoot } : {}),
      });
      return decider.decideAsync(shared, {});
    },
    close() {
      decider.close();
    },
  };
}
