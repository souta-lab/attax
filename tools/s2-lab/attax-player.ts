import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BOT_DEFAULTS } from "../../src/ai/bot/fighter.js";
import { type Placement, spawnPosition } from "../../src/ai/bot/movegen.js";
import { DEFAULT_WEIGHTS, type Weights } from "../../src/ai/bot/weights.js";
import { cellsFor, type PieceKind } from "../../src/core/pieces.js";
import { type SearchInput, search } from "./search.js";

let loaded: { weights: Weights; profileId: string; source: string } | undefined;

function mergeProfile(
  base: Record<string, unknown>,
  patch: unknown,
  path = "",
): Record<string, unknown> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error(`expected an object at ${path || "profile"}`);
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(base, key)) throw new Error(`unknown weight: ${path}${key}`);
    const original = base[key];
    if (typeof original === "object" && original !== null) {
      merged[key] = mergeProfile(original as Record<string, unknown>, value, `${path}${key}.`);
    } else {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`expected a finite number at ${path}${key}`);
      }
      merged[key] = value;
    }
  }
  return merged;
}

function canonical(value: unknown): string {
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function loadS2Weights(): { weights: Weights; profileId: string; source: string } {
  if (loaded) return loaded;
  const source = process.env.ATTAX_S2_PROFILE ?? "DEFAULT_WEIGHTS";
  const weights =
    process.env.ATTAX_S2_PROFILE === undefined
      ? DEFAULT_WEIGHTS
      : (mergeProfile(
          DEFAULT_WEIGHTS as unknown as Record<string, unknown>,
          JSON.parse(readFileSync(source, "utf8")),
        ) as unknown as Weights);
  loaded = {
    weights,
    profileId: createHash("sha256").update(canonical(weights)).digest("hex").slice(0, 16),
    source,
  };
  return loaded;
}

export interface PublicDecision {
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
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 10; x++) {
      if (board.cells[y * 10 + x] !== "_") rows[39 - y] |= 1 << x;
    }
  }
  return {
    board: rows,
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

export function decideAttax(decision: PublicDecision, acceptRoot?: SearchInput["acceptRoot"]) {
  return search(
    { ...projectAttax(decision), ...(acceptRoot ? { acceptRoot } : {}) },
    { weights: loadS2Weights().weights, width: BOT_DEFAULTS.width },
  );
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
