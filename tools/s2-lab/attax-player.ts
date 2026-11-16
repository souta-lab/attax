import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BOT_DEFAULTS } from "../../src/ai/bot/fighter.js";
import { type Placement, spawnPosition } from "../../src/ai/bot/movegen.js";
import { search } from "../../src/ai/bot/search.js";
import { DEFAULT_WEIGHTS, type Weights } from "../../src/ai/bot/weights.js";
import { cellsFor, type PieceKind } from "../../src/core/pieces.js";
import { type SearchInput, toSharedInput } from "./s2-input.js";
import { DEFAULT_SOLVENCY_PARAMS, type SolvencyParams } from "./solvency.js";
import { DEFAULT_STOCK_PARAMS, type StockParams } from "./stock.js";

/** Optional mechanism layers a profile may switch on (canonical §C1/§C2). */
export interface MechanismSettings {
  readonly stock?: StockParams;
  readonly solvency?: SolvencyParams;
  /**
   * Solvency form: "soft" = the C2 per-layer penalty (needs the solvency
   * parameter section, or the env force-on); "hard" = the root-stage veto
   * (choose_rescue), which needs no parameters and disables the soft
   * penalty — the two forms are mutually exclusive A/B settings.
   * Absent = "soft" when a solvency section is present, off otherwise.
   */
  readonly solvencyMode?: "soft" | "hard";
}

const profiles = new Map<
  string | undefined,
  { weights: Weights; mechanisms: MechanismSettings; profileId: string; source: string }
>();
let loaded: ReturnType<typeof loadProfile> | undefined;

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

/** Fill a mechanism parameter set from a profile patch, rejecting bad shapes. */
function mechanismParams<T extends Record<string, number>>(
  defaults: T,
  patch: unknown,
  path: string,
): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error(`expected an object at ${path}`);
  }
  const out: Record<string, number> = { ...defaults };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(defaults, key)) {
      throw new Error(`unknown mechanism parameter: ${path}.${key}`);
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`expected a finite number at ${path}.${key}`);
    }
    out[key] = value;
  }
  return out as T;
}

function parseMechanisms(raw: unknown): MechanismSettings {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("expected an object at mechanisms");
  }
  const out: {
    stock?: StockParams;
    solvency?: SolvencyParams;
    solvencyMode?: "soft" | "hard";
  } = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "stock") {
      out.stock = mechanismParams(DEFAULT_STOCK_PARAMS, value, "mechanisms.stock");
    } else if (key === "solvency") {
      out.solvency = mechanismParams(DEFAULT_SOLVENCY_PARAMS, value, "mechanisms.solvency");
    } else if (key === "solvencyMode") {
      if (value !== "soft" && value !== "hard") {
        throw new Error(`expected "soft" or "hard" at mechanisms.solvencyMode`);
      }
      out.solvencyMode = value;
    } else {
      throw new Error(`unknown mechanism: mechanisms.${key}`);
    }
  }
  return out;
}

function loadProfile(profilePath: string | undefined) {
  const cached = profiles.get(profilePath);
  if (cached) return cached;
  const source = profilePath ?? "DEFAULT_WEIGHTS";
  let weights = DEFAULT_WEIGHTS;
  let mechanisms: MechanismSettings = {};
  if (profilePath !== undefined) {
    const parsed = JSON.parse(readFileSync(source, "utf8")) as Record<string, unknown>;
    const { mechanisms: rawMechanisms, ...patch } = parsed;
    mechanisms = parseMechanisms(rawMechanisms);
    weights = mergeProfile(
      DEFAULT_WEIGHTS as unknown as Record<string, unknown>,
      patch,
    ) as unknown as Weights;
  }
  // Profiles without mechanisms keep the historical weights-only identity;
  // mechanism-bearing profiles hash the full configuration.
  const identity =
    mechanisms.stock === undefined &&
    mechanisms.solvency === undefined &&
    mechanisms.solvencyMode === undefined
      ? canonical(weights)
      : canonical({ weights, mechanisms });
  const loaded = {
    weights,
    mechanisms,
    profileId: createHash("sha256").update(identity).digest("hex").slice(0, 16),
    source,
  };
  profiles.set(profilePath, loaded);
  return loaded;
}

export function loadS2Weights() {
  loaded ??= loadProfile(process.env.ATTAX_S2_PROFILE);
  return loaded;
}

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

/**
 * Env switch for mechanism A/B runs: "0" forces the layer off, "1" forces it
 * on with the profile's parameters (or the defaults), unset defers to the
 * profile. Applies per decider, exactly like ATTAX_S2_PROFILE selection.
 */
function envMechanism<T>(
  env: string | undefined,
  fromProfile: T | undefined,
  defaults: T,
): T | undefined {
  if (env === "0") return undefined;
  if (env === "1") return fromProfile ?? defaults;
  return fromProfile;
}

export function createAttaxDecider(profilePath: string | undefined) {
  const { weights, mechanisms, profileId } = loadProfile(profilePath);
  const stock = envMechanism(
    process.env.ATTAX_S2_STOCK_POTENTIAL,
    mechanisms.stock,
    DEFAULT_STOCK_PARAMS,
  );
  // Solvency mode resolution: ATTAX_S2_SOLVENCY "0" forces every form off;
  // ATTAX_S2_SOLVENCY_MODE overrides the profile's form; the profile form
  // defaults to "soft" when a solvency section (or the env force-on) is in
  // play. "hard" swaps the per-layer penalty for the root-stage veto.
  const solvencyEnv = process.env.ATTAX_S2_SOLVENCY;
  const modeEnv = process.env.ATTAX_S2_SOLVENCY_MODE;
  if (modeEnv !== undefined && modeEnv !== "soft" && modeEnv !== "hard") {
    throw new Error(`expected "soft" or "hard" in ATTAX_S2_SOLVENCY_MODE`);
  }
  const solvencyMode: "soft" | "hard" | undefined =
    solvencyEnv === "0"
      ? undefined
      : (modeEnv ??
        mechanisms.solvencyMode ??
        (mechanisms.solvency !== undefined || solvencyEnv === "1" ? "soft" : undefined));
  const solvency =
    solvencyMode === "soft"
      ? envMechanism(solvencyEnv, mechanisms.solvency, DEFAULT_SOLVENCY_PARAMS)
      : undefined;
  const rootVeto = solvencyMode === "hard";
  return {
    weights,
    mechanisms,
    profileId,
    decide(decision: PublicDecision, acceptRoot?: SearchInput["acceptRoot"]) {
      // The shared core under rules profile "s2" (the former lab search). The
      // projected lab input carries the exact chain as a number; toSharedInput
      // moves it into b2bChain (and the b2b flag) — every other field verbatim.
      return search(
        toSharedInput({ ...projectAttax(decision), ...(acceptRoot ? { acceptRoot } : {}) }),
        {
          weights,
          width: BOT_DEFAULTS.width,
          profile: "s2",
          ...(stock ? { stock } : {}),
          ...(solvency ? { solvency } : {}),
          ...(rootVeto ? { rootVeto } : {}),
        },
      );
    },
  };
}

export function decideAttax(decision: PublicDecision, acceptRoot?: SearchInput["acceptRoot"]) {
  loadS2Weights();
  return createAttaxDecider(
    loaded?.source === "DEFAULT_WEIGHTS" ? undefined : loaded?.source,
  ).decide(decision, acceptRoot);
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
