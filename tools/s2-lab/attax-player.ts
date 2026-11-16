import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BOARD_FEATURES } from "../../src/ai/bot/features.js";
import { BOT_DEFAULTS } from "../../src/ai/bot/fighter.js";
import { generatePlacements, type Placement, spawnPosition } from "../../src/ai/bot/movegen.js";
import { type SearchResult, search } from "../../src/ai/bot/search.js";
import { DEFAULT_WEIGHTS, type Weights } from "../../src/ai/bot/weights.js";
import { cellsFor, type PieceKind } from "../../src/core/pieces.js";
import { rulesProfile } from "../../src/core/profile.js";
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
const S2_ONLY_ADOPT_KEYS = [
  "holeRuns",
  "holeShifts",
  "miniSingleDelta",
  "miniDoubleDelta",
  "miniTripleDelta",
] as const;
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
    if (
      !Object.hasOwn(base, key) &&
      !(path === "" && (S2_ONLY_ADOPT_KEYS as readonly string[]).includes(key))
    )
      throw new Error(`unknown weight: ${path}${key}`);
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
  const identityWeights = { ...weights } as Weights & Record<string, unknown>;
  for (const key of S2_ONLY_ADOPT_KEYS) {
    if (identityWeights[key] === 0) delete identityWeights[key];
  }
  const identity =
    mechanisms.stock === undefined &&
    mechanisms.solvency === undefined &&
    mechanisms.solvencyMode === undefined
      ? canonical(identityWeights)
      : canonical({ weights: identityWeights, mechanisms });
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

/**
 * Engine rule (Souta's order, 2026-11-16 — see "Search engine rule" in the repo
 * AGENTS.md): matches and benches run on the native Rust search
 * (`attax-search-cli --oneshot`), which is bit-identical to the TS search under
 * profile "s2" (proven by the decision-corpus digest and the agreement harness).
 * ATTAX_ENGINE therefore defaults to "rust". The TS search is the reference
 * implementation for agreement checking only and requires the explicit opt-in
 * ATTAX_ENGINE=ts-reference. There is no fallback at any point: the startup
 * handshake in engineIdentity() aborts the run if the Rust binary is missing or
 * does not answer, so a fleet run can never silently run on TS or mix engines.
 * ATTAX_RUST_CLI overrides the binary path.
 */
export interface EngineIdentity {
  readonly id: "rust" | "ts-reference";
  /** Commit the engine was built from (Rust binary stamp / repo HEAD for TS). */
  readonly build: string;
  readonly binary?: string;
  readonly version?: string;
}

const ENGINE = process.env.ATTAX_ENGINE ?? "rust";
if (ENGINE !== "rust" && ENGINE !== "ts-reference") {
  throw new Error(`expected "rust" (the default) or "ts-reference" in ATTAX_ENGINE, got ${ENGINE}`);
}
const RUST_CLI =
  process.env.ATTAX_RUST_CLI ??
  new URL("../../rust/target/release/attax-agree", import.meta.url).pathname;

let identity: EngineIdentity | undefined;
const timingSamples: number[] = [];

/**
 * The engine producing this process's decisions, with its build identifier.
 * For the Rust engine this IS the startup self-check: it runs the binary's
 * --version handshake and throws loudly if the binary is missing, fails to
 * start, or does not identify as the Rust engine. Cached per process.
 */
export function engineIdentity(): EngineIdentity {
  if (identity) return identity;
  if (ENGINE === "rust") {
    const run = spawnSync(RUST_CLI, ["--version"], { encoding: "utf8" });
    if (run.error || run.status !== 0) {
      const detail = run.error ? run.error.message : (run.stderr || `exit ${run.status}`).trim();
      throw new Error(
        `Rust search engine unavailable: ${RUST_CLI} --version failed (${detail}). ` +
          "Matches run on the Rust engine and there is no TS fallback. Build it with:\n" +
          "  cargo build --release --manifest-path rust/Cargo.toml -p attax-search-cli\n" +
          "or set ATTAX_ENGINE=ts-reference for a reference-only TS run " +
          "(agreement checking; never for match records).",
      );
    }
    const parsed = JSON.parse(run.stdout) as {
      engine?: string;
      binary?: string;
      version?: string;
      build?: string;
    };
    if (parsed.engine !== "rust" || typeof parsed.build !== "string") {
      throw new Error(
        `Rust search engine handshake mismatch: ${RUST_CLI} --version answered ${run.stdout.trim()}`,
      );
    }
    identity = {
      id: "rust",
      build: parsed.build,
      binary: parsed.binary,
      version: parsed.version,
    };
  } else {
    const repoRoot = new URL("../../", import.meta.url).pathname;
    const git = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
    identity = {
      id: "ts-reference",
      build: git.status === 0 ? git.stdout.trim() : "unknown",
    };
  }
  return identity;
}

/**
 * Per-decision engine timings for this process and the speed tripwire state.
 * The tripwire catches a mis-wired "Rust" path that secretly performs like the
 * TS reference (e.g. a binary shelling out to TS): if the Rust engine's median
 * decision time exceeds ATTAX_TRIPWIRE_MS (default 100 ms — TS sits at ~133 ms
 * median on the S2 corpus at width 48, the real Rust engine at ~65 ms), the run
 * must warn prominently. It warns; it does not abort (load spikes are real).
 */
export function engineTimingSummary(): {
  decisions: number;
  medianMs: number | null;
  tripwireMs: number;
  tripped: boolean;
} {
  const tripwireMs = Number(process.env.ATTAX_TRIPWIRE_MS ?? 100);
  const sorted = [...timingSamples].sort((a, b) => a - b);
  const medianMs = sorted.length === 0 ? null : (sorted[Math.floor(sorted.length / 2)] as number);
  return {
    decisions: timingSamples.length,
    medianMs,
    tripwireMs,
    tripped: ENGINE === "rust" && medianMs !== null && medianMs > tripwireMs,
  };
}

/** The prominent tripwire warning for run output, or null when not tripped. */
export function tripwireWarningText(): string | null {
  const s = engineTimingSummary();
  if (!s.tripped) return null;
  return (
    `⚠⚠ SPEED TRIPWIRE: engine "rust" median ${(s.medianMs as number).toFixed(1)} ms/decision ` +
    `exceeds the ${s.tripwireMs} ms TS-like threshold (ATTAX_TRIPWIRE_MS). The Rust path is ` +
    "performing like the TS reference — check the engine wiring before trusting this run."
  );
}

type SharedInput = ReturnType<typeof toSharedInput>;

/** The witness key run-match.mjs builds for a root placement. */
function witnessKeyOf(p: Placement, usedHold: boolean): string {
  return `${p.kind}:${usedHold}:${p.lastSrs > 0}:${cellKey(placementCells(p))}`;
}

type RustCallOpts = {
  weights: Weights;
  width: number;
  stock?: StockParams;
  solvency?: SolvencyParams;
  rootVeto: boolean;
};

/** Serialize one decision for the Rust engine (oneshot and server share it). */
function rustPayload(
  input: SharedInput,
  opts: RustCallOpts,
  acceptRoot?: SharedInput["acceptRoot"],
): string {
  let acceptRootKeys: string[] | undefined;
  if (acceptRoot) {
    // The callback cannot cross the process boundary, so materialize it: probe
    // every root placement the search would expand (same movegen options, same
    // start positions) and pass the accepted witness keys. The lab's witness is
    // a pure function of this key, so the filter stays exact.
    const profile = rulesProfile("s2");
    const movegen = {
      spinEvidence: profile.spinEvidence,
      rotate180: profile.rotate180,
      kicks180: profile.kicks180,
    };
    const seen = new Set<string>();
    acceptRootKeys = [];
    const rootOptions: { kind: PieceKind; usedHold: boolean }[] = [
      { kind: input.active.kind, usedHold: false },
    ];
    if (input.canHold) {
      if (input.hold === null) {
        const after = input.preview[0];
        if (after !== undefined && after !== input.active.kind)
          rootOptions.push({ kind: after, usedHold: true });
      } else if (input.hold !== input.active.kind) {
        rootOptions.push({ kind: input.hold, usedHold: true });
      }
    }
    for (const option of rootOptions) {
      const start = !option.usedHold
        ? input.active
        : input.hold !== null
          ? {
              rotation: 0,
              x: 3,
              y:
                input.board.length > profile.visibleRows
                  ? input.board.length - profile.visibleRows - 1
                  : 0,
            }
          : spawnPosition(option.kind, input.board.length);
      for (const p of generatePlacements(input.board, option.kind, start, movegen)) {
        if (!acceptRoot(p, option.usedHold)) continue;
        const key = witnessKeyOf(p, option.usedHold);
        if (!seen.has(key)) {
          seen.add(key);
          acceptRootKeys.push(key);
        }
      }
    }
  }
  const payload = JSON.stringify({
    id: "decide",
    profile: "s2",
    input: {
      board: Array.from(input.board),
      frame: input.frame ?? 0,
      garbageRows: input.garbageRows ? Array.from(input.garbageRows) : null,
      active: input.active,
      hold: input.hold,
      canHold: input.canHold,
      preview: [...input.preview],
      b2b: input.b2b,
      b2bChain: input.b2bChain,
      combo: input.combo,
      pending: input.pending,
      dueThisLock: input.dueThisLock ?? 0,
      speculativePieces: [...(input.speculativePieces ?? [])],
      ...(acceptRootKeys ? { acceptRootKeys } : {}),
    },
    options: {
      width: opts.width,
      ...(opts.stock ? { stock: opts.stock } : {}),
      ...(opts.solvency ? { solvency: opts.solvency } : {}),
      ...(opts.rootVeto ? { rootVeto: true } : {}),
    },
    weights: opts.weights,
  });
  return payload;
}

/** Shape a Rust engine reply into the lab's SearchResult (see searchViaRust). */
function normalizeRustResult(
  raw: (SearchResult & { searchMs?: number }) | null,
): SearchResult | null {
  if (raw === null) return null;
  if (typeof raw.searchMs === "number") timingSamples.push(raw.searchMs);
  // Rebuild the result in the TS construction order (search.ts / movegen.ts
  // object shapes): serde_json's map ordering at the boundary is alphabetical,
  // and consumers that serialize results (the decision-corpus digest) are
  // byte-sensitive to key order even though the values are identical.
  const normPlacement = (p: Placement): Placement => ({
    kind: p.kind,
    rotation: p.rotation,
    x: p.x,
    y: p.y,
    lastSrs: p.lastSrs,
    tspin: p.tspin,
  });
  const normStep = (s: SearchResult["best"]): SearchResult["best"] => ({
    placement: normPlacement(s.placement),
    usedHold: s.usedHold,
    linesCleared: s.linesCleared,
    attack: s.attack,
    reward: s.reward,
  });
  return {
    best: normStep(raw.best),
    line: raw.line.map(normStep),
    value: raw.value,
    breakdown: Object.fromEntries(BOARD_FEATURES.map((f) => [f, raw.breakdown[f] as number])),
    candidates: raw.candidates.map((c) => ({
      placement: normPlacement(c.placement),
      usedHold: c.usedHold,
      value: c.value,
    })),
    nodes: raw.nodes,
    depth: raw.depth,
  };
}

/** Synchronous oneshot call (one process per decision). Debugging path. */
function searchViaRust(
  input: SharedInput,
  opts: RustCallOpts,
  acceptRoot?: SharedInput["acceptRoot"],
): SearchResult | null {
  const run = spawnSync(RUST_CLI, ["--oneshot"], {
    input: rustPayload(input, opts, acceptRoot),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  if (run.status !== 0)
    throw new Error(`attax-search-cli --oneshot failed (${run.status}): ${run.stderr}`);
  return normalizeRustResult(JSON.parse(run.stdout));
}

/**
 * A long-lived Rust engine process (`attax-agree --serve`): one case JSON per
 * stdin line, one result JSON per stdout line, requests serialized per server.
 * This is the production path for matches and corpus runs — the search is the
 * same code as the oneshot's; only the per-decision process startup disappears.
 * A dead server fails every pending and future request loudly (no fallback).
 */
class RustServer {
  private proc: ChildProcess | undefined;
  private buffer = "";
  private waiters: {
    resolve: (line: string) => void;
    reject: (e: Error) => void;
  }[] = [];
  private tail: Promise<void> = Promise.resolve();
  private failure: Error | undefined;
  private closed = false;

  private ensure(): ChildProcess {
    if (this.failure) throw this.failure;
    if (this.proc) return this.proc;
    engineIdentity(); // handshake first: a missing binary fails here, loudly
    const proc = spawn(RUST_CLI, ["--serve"], { stdio: ["pipe", "pipe", "inherit"] });
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx = this.buffer.indexOf("\n");
      while (idx >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        const w = this.waiters.shift();
        if (w) w.resolve(line);
        idx = this.buffer.indexOf("\n");
      }
    });
    const die = (e: Error) => {
      if (!this.failure) this.failure = e;
      for (const w of this.waiters.splice(0)) w.reject(this.failure);
    };
    proc.on("error", (e) => die(new Error(`Rust search server failed: ${e.message}`)));
    proc.on("exit", (code) => {
      if (!this.closed)
        die(new Error(`Rust search server exited (${code}) mid-run; there is no fallback`));
    });
    this.proc = proc;
    return proc;
  }

  request(payload: string): Promise<string> {
    const run = this.tail.then(
      () =>
        new Promise<string>((resolve, reject) => {
          if (this.failure) {
            reject(this.failure);
            return;
          }
          let proc: ChildProcess;
          try {
            proc = this.ensure();
          } catch (e) {
            reject(e as Error);
            return;
          }
          this.waiters.push({ resolve, reject });
          proc.stdin?.write(`${payload}\n`);
        }),
    );
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  close(): void {
    this.closed = true;
    this.proc?.stdin?.end();
    this.proc = undefined;
  }
}

/** ATTAX_RUST_MODE=oneshot forces the per-decision spawn (debugging / A/B). */
const RUST_MODE = process.env.ATTAX_RUST_MODE ?? "server";
if (RUST_MODE !== "server" && RUST_MODE !== "oneshot") {
  throw new Error(`expected "server" or "oneshot" in ATTAX_RUST_MODE, got ${RUST_MODE}`);
}

export function createAttaxDecider(
  profilePath: string | undefined,
  opts?: { width?: number },
) {
  // Startup self-check: the engine handshake runs before the run begins, so a
  // missing/failing Rust binary aborts here rather than mid-match.
  engineIdentity();
  // Beam width: the shipped default (BOT_DEFAULTS.width) unless the caller
  // pins one explicitly — the corpus/agreement surfaces pin theirs so a
  // future default change cannot silently move their digests.
  const width = opts?.width ?? BOT_DEFAULTS.width;
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
  const server = ENGINE === "rust" && RUST_MODE === "server" ? new RustServer() : null;
  const project = (decision: PublicDecision, acceptRoot?: SearchInput["acceptRoot"]) =>
    // The shared core under rules profile "s2" (the former lab search). The
    // projected lab input carries the exact chain as a number; toSharedInput
    // moves it into b2bChain (and the b2b flag) — every other field verbatim.
    toSharedInput({
      ...projectAttax(decision),
      ...(acceptRoot ? { acceptRoot } : {}),
    });
  const runTs = (shared: SharedInput) => {
    const t0 = performance.now();
    const result = search(shared, {
      weights,
      width,
      profile: "s2",
      ...(stock ? { stock } : {}),
      ...(solvency ? { solvency } : {}),
      ...(rootVeto ? { rootVeto } : {}),
    });
    timingSamples.push(performance.now() - t0);
    return result;
  };
  return {
    weights,
    mechanisms,
    profileId,
    decide(decision: PublicDecision, acceptRoot?: SearchInput["acceptRoot"]) {
      const shared = project(decision, acceptRoot);
      if (ENGINE === "rust") {
        return searchViaRust(shared, { weights, width, stock, solvency, rootVeto }, acceptRoot);
      }
      return runTs(shared);
    },
    /**
     * The production path for async drivers (matches, corpus): the Rust engine
     * answers from a long-lived server process instead of a spawn per decision.
     * Results are identical to decide() — same payload, same engine code.
     */
    async decideAsync(decision: PublicDecision, acceptRoot?: SearchInput["acceptRoot"]) {
      const shared = project(decision, acceptRoot);
      if (ENGINE === "rust") {
        if (server) {
          const line = await server.request(
            rustPayload(shared, { weights, width, stock, solvency, rootVeto }, acceptRoot),
          );
          return normalizeRustResult(JSON.parse(line));
        }
        return searchViaRust(shared, { weights, width, stock, solvency, rootVeto }, acceptRoot);
      }
      return runTs(shared);
    },
    /** End the engine server process, if any. Safe to call more than once. */
    close() {
      server?.close();
    },
  };
}

/** The decider decideAttax uses: the ATTAX_S2_PROFILE-selected (or default) profile. */
export function createDefaultAttaxDecider() {
  loadS2Weights();
  return createAttaxDecider(loaded?.source === "DEFAULT_WEIGHTS" ? undefined : loaded?.source);
}

export function decideAttax(decision: PublicDecision, acceptRoot?: SearchInput["acceptRoot"]) {
  return createDefaultAttaxDecider().decide(decision, acceptRoot);
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
