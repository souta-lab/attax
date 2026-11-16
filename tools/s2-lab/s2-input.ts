/**
 * The S2 lab's search-input shape and its single mapping onto the shared core.
 *
 * The former private lab search (tools/s2-lab/search.ts) is gone: the lab now
 * runs the shared src search under rules profile "s2" (src/ai/bot/search.ts).
 * The lab keeps its own input shape because its public-state projection
 * (projectAttax) and the imitation variants carry the exact difficult-clear
 * chain in a numeric `b2b` and always know `dueThisLock`. The shared input keeps
 * `b2b` boolean and carries the exact chain in `b2bChain`; `toSharedInput` is
 * the one place that converts between them (same conversion as the chunk-3b
 * parity test). Every other field is shared verbatim.
 */

import type { Placement } from "../../src/ai/bot/movegen.js";
import type {
  SearchOptions as SharedSearchOptions,
  SearchInput as SrcSearchInput,
} from "../../src/ai/bot/search.js";
import type { PieceKind } from "../../src/core/pieces.js";

export type { Candidate, SearchResult, Step } from "../../src/ai/bot/search.js";

/** Lab search input: the shared input with the exact chain as a numeric `b2b`. */
export interface SearchInput {
  readonly board: SrcSearchInput["board"];
  /** Logical referee frame at the root decision (lockTime). */
  readonly frame?: number;
  /** Garbage flags aligned with board row indices (same index space as board). */
  readonly garbageRows?: readonly number[];
  readonly active: { kind: PieceKind; rotation: number; x: number; y: number };
  readonly hold: PieceKind | null;
  readonly canHold: boolean;
  /** Upcoming pieces after the active one (the visible preview). */
  readonly preview: readonly PieceKind[];
  /** Exact difficult-clear chain (0 = none). */
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

/** Lab search options: the shared options minus the profile selectors (always "s2"). */
export type SearchOptions = Omit<SharedSearchOptions, "profile" | "guideline">;

/** Map a lab input onto the shared core's input: numeric chain -> `b2b` flag + `b2bChain`. */
export function toSharedInput(input: SearchInput): SrcSearchInput {
  const { b2b, ...rest } = input;
  return { ...rest, b2b: b2b > 0, b2bChain: b2b };
}
