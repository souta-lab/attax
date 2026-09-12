// Head-to-head gate for DeepSeek v2 (left) vs the Hoiko replica (right) over the
// fixed 32-seed corpus. Mirror of scripts/hoiko-gate.ts, but selects the v2
// fighter and allows ablation knobs via env:
//   DSV2_DEPTH, DSV2_WIDTH, DSV2_TOP_K, DSV2_KICKS=0|1,
//   DSV2_OPPONENT=0|1, DSV2_GARBAGE=0|1, DSV2_DOWNSTACK=0|1, DSV2_RUST=0|1,
//   DSV2_BOOK=0|1, HOIKO_BEAM (default 150), HOIKO_ADAPT=0|1 (default 1)
// Emits JSONL records via stdout (HOIKO-config / HOIKO-match / HOIKO-summary).
import { createDeepSeekV2, type DeepSeekV2Options } from "../src/ai/deepseek-v2.js";
import { resolveFaithfulHoikoOptions } from "../src/ai/hoiko-faithful.js";
import type { RustHoikoEngine } from "../src/ai/hoiko-rust-core.js";
import type { HoikoPreset } from "../src/ai/hoiko-weights.js";
import type { GameSnapshot } from "../src/ui/types.js";
import { resolveVersusConfig } from "../src/versus/config.js";
import {
  createVersusController,
  type SideState,
  VERSUS_DEFAULTS,
  type VersusFighter,
} from "../src/versus/controller.js";
import { createRustDeepSeekV2 } from "../tools/deepseek-rust/loader.js";
import { createRustHoiko, type RustHoikoFighter } from "../tools/hoiko-rust/loader.js";

const FIXED_SEEDS = [
  1, 5555, 13, 37, 61, 89, 7, 9001, 17, 41, 67, 97, 42, 2, 19, 43, 71, 99, 3, 23, 47, 73, 777, 5,
  29, 53, 79, 1234, 11, 31, 59, 83,
] as const;
const MAX_TICKS = Number(process.env.HOIKO_MAX_TICKS ?? 12000);
const TICK_MS = 16;
const VALID_PRESETS: readonly HoikoPreset[] = ["we", "wo", "wd", "wr", "ultra2", "sprint"];

function readPreset(raw: string | undefined): HoikoPreset {
  const value = raw ?? "we";
  const found = VALID_PRESETS.find((preset) => preset === value);
  if (found === undefined) {
    throw new Error(`HOIKO_PRESET must be one of ${VALID_PRESETS.join(",")}, got ${value}`);
  }
  return found;
}

function readInteger(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer, got ${raw}`);
  return value;
}

function readFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw !== "0";
}

const USE_RUST = readFlag(process.env.DSV2_RUST, false);

function readV2Options(): DeepSeekV2Options {
  return {
    depth: readInteger("DSV2_DEPTH", process.env.DSV2_DEPTH, 7),
    width: readInteger("DSV2_WIDTH", process.env.DSV2_WIDTH, 24),
    topK: readInteger("DSV2_TOP_K", process.env.DSV2_TOP_K, 16),
    useKicks: readFlag(process.env.DSV2_KICKS, true),
    useOpponent: readFlag(process.env.DSV2_OPPONENT, true),
    useGarbageDefense: readFlag(process.env.DSV2_GARBAGE, true),
    useDownstack: readFlag(process.env.DSV2_DOWNSTACK, true),
    openingBook: readFlag(process.env.DSV2_BOOK, false),
  };
}

interface SideMetrics {
  readonly lines: number;
  readonly sent: number;
  readonly tsd: number;
  readonly tetris: number;
  readonly locks: number;
  readonly maxPending: number;
  readonly maxHeight: number;
  readonly holes: number;
  readonly maxAdaptiveBeamSize: number;
  readonly executionSourceMismatches: number;
  readonly executionExpectedBoardFailures: number;
  readonly thinkMs: number;
  readonly thinkCount: number;
}

interface Row {
  readonly seed: number;
  readonly winner: "left" | "right" | "draw" | "cap";
  readonly reason: string;
  readonly ticks: number;
  readonly pieces: number;
  readonly left: SideMetrics;
  readonly right: SideMetrics;
}

function stackHeight(grid: GameSnapshot["board"]["grid"]): number {
  for (let rowIndex = 0; rowIndex < grid.length; rowIndex += 1) {
    if (grid[rowIndex]?.some((cell) => cell !== 0) === true) return grid.length - rowIndex;
  }
  return 0;
}

function countHoles(grid: GameSnapshot["board"]["grid"]): number {
  let holes = 0;
  for (let column = 0; column < 10; column += 1) {
    let blockSeen = false;
    for (const row of grid) {
      const filled = (row?.[column] ?? 0) !== 0;
      if (filled) blockSeen = true;
      else if (blockSeen) holes += 1;
    }
  }
  return holes;
}

interface MutableMetrics {
  lines: number;
  sent: number;
  tsd: number;
  tetris: number;
  locks: number;
  maxPending: number;
  maxHeight: number;
  holes: number;
  maxAdaptiveBeamSize: number;
  executionSourceMismatches: number;
  executionExpectedBoardFailures: number;
  thinkMs: number;
  thinkCount: number;
  previousLines: number;
}

function sampleSide(side: SideState, metrics: MutableMetrics, engine?: RustHoikoEngine): void {
  const snapshot = side.core.getSnapshot();
  metrics.lines = snapshot.lines;
  metrics.sent = side.sentTotal;
  metrics.locks = snapshot.lockId;
  metrics.maxPending = Math.max(metrics.maxPending, snapshot.pendingGarbage);
  metrics.maxHeight = Math.max(metrics.maxHeight, stackHeight(snapshot.board.grid));
  metrics.holes = Math.max(metrics.holes, countHoles(snapshot.board.grid));
  if (engine !== undefined) {
    metrics.maxAdaptiveBeamSize = Math.max(
      metrics.maxAdaptiveBeamSize,
      engine.searchState.maxBeamSize,
    );
  }
  metrics.executionSourceMismatches = side.executionSourceMismatches;
  metrics.executionExpectedBoardFailures = side.executionExpectedBoardFailures;
  metrics.thinkMs = side.thinkMs;
  metrics.thinkCount = side.thinkCount;
  // Count clears from the engine's own native lock action (accurate for placeAt
  // T-spins, unlike the fighter debug heuristic).
  if (snapshot.lines > metrics.previousLines) {
    if (snapshot.lastAction === "Tsd" || snapshot.lastAction === "Tst") metrics.tsd += 1;
    if (snapshot.lastAction === "Quad") metrics.tetris += 1;
  }
  metrics.previousLines = snapshot.lines;
}

function finishMetrics(side: SideState, metrics: MutableMetrics): SideMetrics {
  sampleSide(side, metrics);
  const snapshot = side.core.getSnapshot();
  return {
    lines: snapshot.lines,
    sent: side.sentTotal,
    tsd: metrics.tsd,
    tetris: metrics.tetris,
    locks: metrics.locks,
    maxPending: metrics.maxPending,
    maxHeight: metrics.maxHeight,
    holes: metrics.holes,
    maxAdaptiveBeamSize: metrics.maxAdaptiveBeamSize,
    executionSourceMismatches: side.executionSourceMismatches,
    executionExpectedBoardFailures: side.executionExpectedBoardFailures,
    thinkMs: side.thinkMs,
    thinkCount: side.thinkCount,
  };
}

function runMatch(seed: number, ourFighter: VersusFighter, hoikoFighter: RustHoikoFighter): Row {
  const controller = createVersusController(ourFighter, hoikoFighter, seed, resolveVersusConfig());
  const left = freshMetrics();
  const right = freshMetrics();
  let ticks = 0;
  while (controller.result === null && ticks < MAX_TICKS) {
    controller.tick(TICK_MS, VERSUS_DEFAULTS);
    ticks += 1;
    sampleSide(controller.left, left);
    sampleSide(controller.right, right, hoikoFighter.engine);
  }
  const result = controller.result;
  return {
    seed,
    winner: result?.winner ?? "cap",
    reason: result?.reason ?? "max-ticks",
    ticks,
    pieces: result?.pieces ?? controller.pieces,
    left: finishMetrics(controller.left, left),
    right: finishMetrics(controller.right, right),
  };
}

function freshMetrics(): MutableMetrics {
  return {
    lines: 0,
    sent: 0,
    tsd: 0,
    tetris: 0,
    locks: 0,
    maxPending: 0,
    maxHeight: 0,
    holes: 0,
    maxAdaptiveBeamSize: 0,
    executionSourceMismatches: 0,
    executionExpectedBoardFailures: 0,
    thinkMs: 0,
    thinkCount: 0,
    previousLines: 0,
  };
}

interface Aggregate {
  readonly matches: number;
  readonly leftWins: number;
  readonly rightWins: number;
  readonly draws: number;
  readonly caps: number;
  readonly ticks: number;
  readonly pieces: number;
  readonly left: SideMetrics;
  readonly right: SideMetrics;
}

function sumSide(rows: readonly Row[], key: "left" | "right"): SideMetrics {
  const total: MutableMetrics = freshMetrics();
  for (const row of rows) {
    const side = row[key];
    total.lines += side.lines;
    total.sent += side.sent;
    total.tsd += side.tsd;
    total.tetris += side.tetris;
    total.locks += side.locks;
    total.maxPending += side.maxPending;
    total.maxHeight += side.maxHeight;
    total.holes += side.holes;
    total.maxAdaptiveBeamSize += side.maxAdaptiveBeamSize;
    total.executionSourceMismatches += side.executionSourceMismatches;
    total.executionExpectedBoardFailures += side.executionExpectedBoardFailures;
    total.thinkMs += side.thinkMs;
    total.thinkCount += side.thinkCount;
  }
  return {
    lines: total.lines,
    sent: total.sent,
    tsd: total.tsd,
    tetris: total.tetris,
    locks: total.locks,
    maxPending: total.maxPending,
    maxHeight: total.maxHeight,
    holes: total.holes,
    maxAdaptiveBeamSize: total.maxAdaptiveBeamSize,
    executionSourceMismatches: total.executionSourceMismatches,
    executionExpectedBoardFailures: total.executionExpectedBoardFailures,
    thinkMs: total.thinkMs,
    thinkCount: total.thinkCount,
  };
}

function aggregate(rows: readonly Row[]): Aggregate {
  const count = (winner: Row["winner"]): number =>
    rows.filter((row) => row.winner === winner).length;
  return {
    matches: rows.length,
    leftWins: count("left"),
    rightWins: count("right"),
    draws: count("draw"),
    caps: count("cap"),
    ticks: rows.reduce((total, row) => total + row.ticks, 0),
    pieces: rows.reduce((total, row) => total + row.pieces, 0),
    left: sumSide(rows, "left"),
    right: sumSide(rows, "right"),
  };
}

function fingerprint(rows: readonly Row[]): string {
  const text = JSON.stringify(rows);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function makeOurFighter(v2: DeepSeekV2Options): VersusFighter {
  const useRust = USE_RUST && v2.openingBook !== true;
  const core = useRust ? createRustDeepSeekV2(v2) : createDeepSeekV2(v2);
  return { ...core, color: "#3aa0ff" };
}

function main(): void {
  const preset = readPreset(process.env.HOIKO_PRESET);
  const ours = "deepseek-v2";
  const v2 = readV2Options();
  const hoiko = resolveFaithfulHoikoOptions(process.env, preset);
  const override = process.env.HOIKO_SEEDS;
  const shardIndex = readInteger("HOIKO_SHARD_INDEX", process.env.HOIKO_SHARD_INDEX, 0);
  const shardCount = readInteger("HOIKO_SHARD_COUNT", process.env.HOIKO_SHARD_COUNT, 1);
  if (shardIndex < 0 || shardCount < 1 || shardIndex >= shardCount) {
    throw new Error("HOIKO_SHARD_INDEX must be < HOIKO_SHARD_COUNT");
  }
  const seeds: readonly number[] =
    override === undefined
      ? FIXED_SEEDS.filter((_, index) => index % shardCount === shardIndex)
      : override
          .split(",")
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isFinite(value));

  console.log(
    JSON.stringify({
      type: "HOIKO-config",
      preset,
      ours,
      shard: { index: shardIndex, count: shardCount },
      seeds,
      maxTicks: MAX_TICKS,
      tickMs: TICK_MS,
      engine: USE_RUST ? "rust-wasm" : "ts",
      v2,
      hoiko,
    }),
  );

  const rows: Row[] = [];
  for (const seed of seeds) {
    const row = runMatch(seed, makeOurFighter(v2), createRustHoiko(hoiko));
    rows.push(row);
    console.log(JSON.stringify({ type: "HOIKO-match", preset, ours, ...row }));
  }
  const agg = aggregate(rows);
  console.log(
    JSON.stringify({
      type: "HOIKO-summary",
      preset,
      ours,
      shard: { index: shardIndex, count: shardCount },
      seeds,
      maxTicks: MAX_TICKS,
      v2,
      engine: USE_RUST ? "rust-wasm" : "ts",
      hoiko,
      aggregate: agg,
      fingerprint: fingerprint(rows),
      winLossCap: `${agg.leftWins}-${agg.rightWins}-${agg.draws}/${agg.caps}`,
      avgMsPerDecision: {
        left: agg.left.thinkCount > 0 ? agg.left.thinkMs / agg.left.thinkCount : 0,
        right: agg.right.thinkCount > 0 ? agg.right.thinkMs / agg.right.thinkCount : 0,
      },
      attackPerPiece: {
        left: agg.left.locks > 0 ? agg.left.sent / agg.left.locks : 0,
        right: agg.right.locks > 0 ? agg.right.sent / agg.right.locks : 0,
      },
      adaptiveBeamMax: Math.max(0, ...rows.map((row) => row.right.maxAdaptiveBeamSize)),
    }),
  );
}

// Run only when executed as the gate entrypoint; importable by parity tests/tools.
if (import.meta.main) main();

export { FIXED_SEEDS, makeOurFighter, readPreset, readV2Options };
